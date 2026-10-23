import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { JwksJwtVerifier } from '../packages/auth/src/index.js';
import { createApiAppWithDatabase } from '../apps/api/src/index.js';
import { PostgresBlockRelationStore, PostgresProfileStore } from '../packages/database/src/index.js';
import { createLocalTrustedPostgresExecutor } from '../packages/database/src/local-postgres-executor.js';
import type { TrustedPostgresExecutor } from '../packages/database/src/index.js';

const container = process.env.HEISEI_LOCAL_PG_CONTAINER;
const databaseUrl = process.env.HEISEI_LOCAL_PG_URL;
const subject = 'integration-subject-1';
const userId = '00000000-0000-4000-8000-000000000001';
const targetId = '00000000-0000-4000-8000-000000000002';

function adminSql(sql: string): string {
  if (!container) throw new Error('local database container is required');
  return execFileSync('docker', ['exec', '-i', container, 'psql', '-h', '127.0.0.1', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'heisei_local'], { input: sql, encoding: 'utf8' }).trim();
}

async function signedToken(tokenSubject = subject): Promise<{ verifier: JwksJwtVerifier; token: string }> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const encode = (value: string | Uint8Array) => {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
  };
  const header = encode(JSON.stringify({ alg: 'RS256', kid: 'integration-key', typ: 'JWT' }));
  const payload = encode(JSON.stringify({ sub: tokenSubject, iss: 'https://issuer.example.test', aud: 'heisei-api', exp: Math.floor(Date.now() / 1000) + 300 }));
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, pair.privateKey, new TextEncoder().encode(input));
  return {
    verifier: new JwksJwtVerifier({
      issuer: 'https://issuer.example.test', audience: 'heisei-api', jwksUri: 'https://issuer.example.test/jwks',
      fetcher: async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'integration-key', alg: 'RS256' }] })),
    }),
    token: `${input}.${encode(new Uint8Array(signature))}`,
  };
}

describe.skipIf(!container || !databaseUrl)('real JWT → Hono → isolated PostgreSQL', () => {
  let executor: TrustedPostgresExecutor;

  beforeAll(async () => {
    executor = await createLocalTrustedPostgresExecutor({ connectionString: databaseUrl, max: 2 });
  });

  afterAll(async () => {
    await (executor as { close?: () => Promise<void> }).close?.();
  });

  it('returns the identity loaded through RLS-scoped PostgreSQL', async () => {
    const { verifier, token } = await signedToken();
    const response = await createApiAppWithDatabase({ verifier, executor }).request('/api/v1/session', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).data.session).toMatchObject({ userId, authLevel: 2, status: 'active' });
  });

  it('gets and patches only the authenticated user profile through RLS', async () => {
    const { verifier, token } = await signedToken();
    const app = createApiAppWithDatabase({ verifier, executor });
    const before = await app.request('/api/v1/profile', { headers: { authorization: `Bearer ${token}` } });
    expect(before.status).toBe(200);
    expect((await before.json()).data.profile).toMatchObject({ userId, username: 'integration-one', displayName: 'Integration One' });
    const update = await app.request('/api/v1/profile', {
      method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Updated One', bio: 'private bio' }),
    });
    expect(update.status).toBe(200);
    expect((await update.json()).data.profile).toMatchObject({ userId, displayName: 'Updated One', bio: 'private bio' });
    expect(adminSql(`SELECT count(*)::text FROM audit_logs WHERE actor_user_id = '${userId}'::uuid AND action = 'profile.update'`)).toBe('1');
  });

  it('rejects cross-user updates and privileged-column writes at RLS and SQL grant boundaries', async () => {
    await executor.withProfileWriter!(userId, async (query) => {
      const result = await query.query<{ user_id: string }>(
        'UPDATE profiles SET display_name = $1 WHERE id = $2::uuid RETURNING id::text AS user_id',
        ['Cannot change target', targetId],
      );
      expect(result.rows).toHaveLength(0);
      await expect(query.query(
        'UPDATE profiles SET auth_level = $1 WHERE id = $2::uuid', [4, userId],
      )).rejects.toThrow();
    });
  });

  it('rolls back profile changes when the audit insert fails', async () => {
    const failingExecutor: TrustedPostgresExecutor = {
      withAuthSubject: executor.withAuthSubject.bind(executor),
      withUserId: executor.withUserId.bind(executor),
      withProfileWriter: (id, operation) => executor.withProfileWriter!(id, async (query) => operation({
        query: async (text, values) => {
          if (text.includes('INSERT INTO audit_logs')) throw new Error('audit unavailable');
          return query.query(text, values);
        },
      })),
    };
    const store = new PostgresProfileStore(failingExecutor);
    await expect(store.updateOwn(userId, { displayName: 'Must Roll Back' }, 'rollback-test')).rejects.toThrow('audit unavailable');
    const current = await new PostgresProfileStore(executor).findOwn(userId);
    expect(current?.displayName).toBe('Updated One');
  });

  it('rejects unknown subject and insufficient evidence without leaking DB state', async () => {
    const { verifier, token } = await signedToken('unknown-subject');
    const response = await createApiAppWithDatabase({ verifier, executor }).request('/api/v1/session', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).not.toContain('integration-subject');
  });

  it('rejects a known subject with missing verification evidence', async () => {
    const { verifier, token } = await signedToken('integration-subject-2');
    const response = await createApiAppWithDatabase({ verifier, executor }).request('/api/v1/session', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe('unauthorized');
    expect(JSON.stringify(body)).not.toContain('integration-subject-2');
  });

  it('reads both block directions through the same isolated executor', async () => {
    const result = await new PostgresBlockRelationStore(executor).findBetween(userId, targetId);
    expect(result).toEqual({ blockedByActor: true, blockedByTarget: true });
  });

  it('creates and removes only the actor-owned block through real JWT and RLS', async () => {
    const { verifier, token } = await signedToken();
    const app = createApiAppWithDatabase({ verifier, executor });
    const existing = adminSql(`SELECT id::text FROM blocks WHERE blocker_id = '${userId}'::uuid AND blocked_id = '${targetId}'::uuid`);
    const repeat = await app.request('/api/v1/blocks', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ targetUserId: targetId }),
    });
    expect(repeat.status).toBe(202);
    const repeatBody = await repeat.json();
    expect(repeatBody.data.block.id).toMatch(/^[0-9a-f-]{36}$/i);
    const unknown = await app.request('/api/v1/blocks', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ targetUserId: '00000000-0000-4000-8000-000000000003' }),
    });
    expect(unknown.status).toBe(202);
    const unknownBody = await unknown.json();
    expect(Object.keys(unknownBody.data.block)).toEqual(Object.keys(repeatBody.data.block));
    const removed = await app.request(`/api/v1/blocks/${existing}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${token}` },
    });
    expect(removed.status).toBe(200);
    expect(adminSql(`SELECT count(*)::text FROM blocks WHERE id = '${existing}'::uuid`)).toBe('0');
    expect(adminSql(`SELECT count(*)::text FROM audit_logs WHERE actor_user_id = '${userId}'::uuid AND target_user_id = '${targetId}'::uuid AND action = 'block.delete'`)).toBe('1');
    const recreated = await app.request('/api/v1/blocks', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ targetUserId: targetId }),
    });
    expect(recreated.status).toBe(202);
    expect((await recreated.json()).data.block.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(adminSql(`SELECT count(*)::text FROM audit_logs WHERE actor_user_id = '${userId}'::uuid AND target_user_id = '${targetId}'::uuid AND action = 'block.create'`)).toBe('1');
  });

  it('rejects invalid JWT and cross-owner unblock without leaking ownership', async () => {
    const { verifier, token } = await signedToken();
    const app = createApiAppWithDatabase({ verifier, executor });
    const invalid = await app.request('/api/v1/blocks', {
      method: 'POST', headers: { authorization: 'Bearer invalid', 'content-type': 'application/json' },
      body: JSON.stringify({ targetUserId: targetId }),
    });
    expect(invalid.status).toBe(401);
    const otherOwned = adminSql(`SELECT id::text FROM blocks WHERE blocker_id = '${targetId}'::uuid AND blocked_id = '${userId}'::uuid`);
    const crossOwner = await app.request(`/api/v1/blocks/${otherOwned}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${token}` },
    });
    expect(crossOwner.status).toBe(404);
    expect(adminSql(`SELECT count(*)::text FROM blocks WHERE id = '${otherOwned}'::uuid`)).toBe('1');
  });

  it('handles concurrent duplicate block requests with one row and one audit event', async () => {
    adminSql(`DELETE FROM blocks WHERE blocker_id = '${userId}'::uuid AND blocked_id = '${targetId}'::uuid`);
    adminSql(`DELETE FROM audit_logs WHERE actor_user_id = '${userId}'::uuid AND target_user_id = '${targetId}'::uuid AND action = 'block.create'`);
    const { verifier, token } = await signedToken();
    const app = createApiAppWithDatabase({ verifier, executor });
    const request = () => app.request('/api/v1/blocks', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ targetUserId: targetId }),
    });
    const responses = await Promise.all([request(), request()]);
    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    expect(adminSql(`SELECT count(*)::text FROM blocks WHERE blocker_id = '${userId}'::uuid AND blocked_id = '${targetId}'::uuid`)).toBe('1');
    expect(adminSql(`SELECT count(*)::text FROM audit_logs WHERE actor_user_id = '${userId}'::uuid AND target_user_id = '${targetId}'::uuid AND action = 'block.create'`)).toBe('1');
  });

  it('cannot bypass block auditing with the general app role or misuse the audit role', async () => {
    const block = adminSql(`SELECT id::text FROM blocks WHERE blocker_id = '${userId}'::uuid AND blocked_id = '${targetId}'::uuid`);
    await expect(executor.withUserId(userId, (query) => query.query(
      'INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1::uuid, $2::uuid)', [userId, targetId],
    ))).rejects.toThrow();
    await expect(executor.withUserId(userId, (query) => query.query(
      'DELETE FROM blocks WHERE id = $1::uuid', [block],
    ))).rejects.toThrow();
    await expect(executor.withBlockWriter!(userId, (query) => query.query(
      "INSERT INTO audit_logs (actor_user_id, target_user_id, action, request_id, rule_version) VALUES ($1::uuid, $2::uuid, 'profile.update', 'bad-audit', '003h')",
      [userId, targetId],
    ))).rejects.toThrow();
    await expect(executor.withBlockWriter!(userId, (query) => query.query(
      "INSERT INTO audit_logs (actor_user_id, target_user_id, action, request_id, rule_version) VALUES ($1::uuid, $2::uuid, 'block.create', 'bad-owner', '003h')",
      [targetId, targetId],
    ))).rejects.toThrow();
    expect(adminSql(`SELECT count(*)::text FROM blocks WHERE id = '${block}'::uuid`)).toBe('1');
  });

  it('returns a safe 500 for delete database failures and rolls back delete audits', async () => {
    const block = adminSql(`SELECT id::text FROM blocks WHERE blocker_id = '${userId}'::uuid AND blocked_id = '${targetId}'::uuid`);
    const failingExecutor: TrustedPostgresExecutor = {
      withAuthSubject: executor.withAuthSubject.bind(executor),
      withUserId: executor.withUserId.bind(executor),
      withBlockWriter: (id, operation) => executor.withBlockWriter!(id, async (query) => operation({
        query: async (text, values) => {
          if (text.includes('INSERT INTO audit_logs')) throw new Error('audit unavailable');
          return query.query(text, values);
        },
      })),
    };
    const { verifier, token } = await signedToken();
    const app = createApiAppWithDatabase({ verifier, executor: failingExecutor });
    const response = await app.request(`/api/v1/blocks/${block}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('audit unavailable');
    expect(adminSql(`SELECT count(*)::text FROM blocks WHERE id = '${block}'::uuid`)).toBe('1');
  });

  it('rolls back block insertion when the atomic audit write fails', async () => {
    adminSql(`DELETE FROM blocks WHERE blocker_id = '${userId}'::uuid AND blocked_id = '${targetId}'::uuid`);
    const failingExecutor: TrustedPostgresExecutor = {
      withAuthSubject: executor.withAuthSubject.bind(executor),
      withUserId: executor.withUserId.bind(executor),
      withBlockWriter: (id, operation) => executor.withBlockWriter!(id, async (query) => operation({
        query: async (text, values) => {
          if (text.includes('INSERT INTO audit_logs')) throw new Error('audit unavailable');
          return query.query(text, values);
        },
      })),
    };
    const { verifier, token } = await signedToken();
    const app = createApiAppWithDatabase({ verifier, executor: failingExecutor });
    const response = await app.request('/api/v1/blocks', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ targetUserId: targetId }),
    });
    expect(response.status).toBe(500);
    expect(adminSql(`SELECT count(*)::text FROM blocks WHERE blocker_id = '${userId}'::uuid AND blocked_id = '${targetId}'::uuid`)).toBe('0');
  });

  it('does not leak transaction-local role or RLS settings across reused connections', async () => {
    const observed = await executor.withUserId(userId, async (query) => {
      const result = await query.query<{ role: string; user_id: string | null }>(
        "SELECT current_user AS role, current_setting('app.user_id', true) AS user_id",
        [],
      );
      return result.rows[0];
    });
    expect(observed).toEqual({ role: 'heisei_app', user_id: userId });
    const next = await executor.withUserId(targetId, async (query) => {
      const result = await query.query<{ role: string; user_id: string | null }>(
        "SELECT current_user AS role, current_setting('app.user_id', true) AS user_id",
        [],
      );
      return result.rows[0];
    });
    expect(next).toEqual({ role: 'heisei_app', user_id: targetId });
  });

  it('resets the DB role and prior identity setting on the same pooled backend', async () => {
    if (!databaseUrl) throw new Error('local database not configured');
    const single = await createLocalTrustedPostgresExecutor({ connectionString: databaseUrl, max: 1 });
    try {
      const first = await single.withUserId(userId, async (query) => {
        const r = await query.query<{ pid: number; role: string }>(
          'SELECT pg_backend_pid() AS pid, current_user AS role', [],
        );
        return r.rows[0];
      });
      const second = await single.withAuthSubject(subject, async (query) => {
        const r = await query.query<{ pid: number; role: string; previous_user_id: string | null }>(
          "SELECT pg_backend_pid() AS pid, current_user AS role, current_setting('app.user_id', true) AS previous_user_id", [],
        );
        return r.rows[0];
      });
      expect(second.pid).toBe(first.pid);
      expect(first.role).toBe('heisei_app');
      expect(second.role).toBe('heisei_identity_writer');
      expect([null, '']).toContain(second.previous_user_id);
      const third = await single.withUserId(targetId, async (query) => {
        const r = await query.query<{ pid: number; role: string; previous_subject: string | null }>(
          "SELECT pg_backend_pid() AS pid, current_user AS role, current_setting('app.auth_subject', true) AS previous_subject", [],
        );
        return r.rows[0];
      });
      expect(third.pid).toBe(first.pid);
      expect(third.role).toBe('heisei_app');
      expect([null, '']).toContain(third.previous_subject);
    } finally {
      await single.close();
    }
  });

  it('rejects invalid RLS subjects and UUIDs before executing SQL', async () => {
    await expect(executor.withAuthSubject(' ', async () => 1)).rejects.toThrow('invalid auth subject');
    await expect(executor.withAuthSubject('x'.repeat(256), async () => 1)).rejects.toThrow('invalid auth subject');
    await expect(executor.withUserId('not-uuid', async () => 1)).rejects.toThrow('invalid user id');
  });

  it('rolls back and releases a connection after a failed operation', async () => {
    await expect(executor.withUserId(userId, async () => { throw new Error('expected failure'); })).rejects.toThrow('expected failure');
    const result = await executor.withUserId(targetId, async (query) => {
      const rows = await query.query<{ user_id: string }>('SELECT id::text AS user_id FROM profiles ORDER BY id', []);
      return rows.rows;
    });
    expect(result).toEqual([{ user_id: targetId }]);
  });

  it('keeps transaction-local identity isolated for concurrent requests', async () => {
    const read = (id: string) => executor.withUserId(id, async (query) => {
      const result = await query.query<{ user_id: string | null }>(
        "SELECT current_setting('app.user_id', true) AS user_id, pg_sleep(0.05)",
        [],
      );
      return result.rows[0]?.user_id;
    });
    await expect(Promise.all([read(userId), read(targetId)])).resolves.toEqual([userId, targetId]);
  });
});

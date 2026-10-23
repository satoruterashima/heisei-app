import { describe, expect, it } from 'vitest';
import { JwksJwtVerifier, type JwtVerifier } from '../packages/auth/src/index.js';
import {
  PostgresBlockRelationStore,
  PostgresBlockMutationStore,
  PostgresIdentityRecordStore,
  type PostgresQueryExecutor,
  type TrustedPostgresExecutor,
} from '../packages/database/src/index.js';
import { createApiAppWithDatabase } from '../apps/api/src/index.js';

const subject = 'provider-subject-1';
const userId = '00000000-0000-4000-8000-000000000001';

const identityRow = {
  auth_subject: subject,
  user_id: userId,
  auth_level: 1,
  membership: 'free',
  roles_json: '["member"]',
  account_status: 'active',
  verification_kind: 'email_verified',
  verification_status: 'verified',
};

function executorFor(rows: readonly Record<string, unknown>[]): TrustedPostgresExecutor {
  const query: PostgresQueryExecutor = {
    query: async <Row extends Record<string, unknown>>() => ({ rows: rows as readonly Row[] }),
  };
  return {
    withAuthSubject: async (_subject, operation) => operation(query),
    withUserId: async (_userId, operation) => operation(query),
  };
}

async function signedToken(): Promise<{ verifier: JwtVerifier; token: string }> {
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
  const header = encode(JSON.stringify({ alg: 'RS256', kid: 'db-test-key', typ: 'JWT' }));
  const payload = encode(JSON.stringify({
    sub: subject,
    iss: 'https://issuer.example.test',
    aud: 'heisei-api',
    exp: Math.floor(Date.now() / 1000) + 300,
  }));
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, pair.privateKey, new TextEncoder().encode(input));
  return {
    verifier: new JwksJwtVerifier({
      issuer: 'https://issuer.example.test',
      audience: 'heisei-api',
      jwksUri: 'https://issuer.example.test/jwks',
      fetcher: async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'db-test-key', alg: 'RS256' }] })),
    }),
    token: `${input}.${encode(new Uint8Array(signature))}`,
  };
}

describe('PostgreSQL identity and block stores', () => {
  it('maps provider subject to internal UUID without trusting JWT authorization fields', async () => {
    const store = new PostgresIdentityRecordStore(executorFor([identityRow]));
    const identity = await store.findByAuthSubject(subject);
    expect(identity).toMatchObject({ authSubject: subject, userId, authLevel: 1, membership: 'free', accountStatus: 'active' });
    expect(identity?.verifications).toEqual([{ kind: 'email_verified', status: 'verified' }]);
  });

  it('fails closed on subject mismatch and database errors', async () => {
    const mismatch = new PostgresIdentityRecordStore(executorFor([{ ...identityRow, auth_subject: 'other-subject' }]));
    expect(await mismatch.findByAuthSubject(subject)).toBeNull();
    const outage: TrustedPostgresExecutor = {
      withAuthSubject: async () => { throw new Error('connection details must not escape'); },
      withUserId: async (_id, operation) => operation({ query: async () => ({ rows: [] }) }),
    };
    await expect(new PostgresIdentityRecordStore(outage).findByAuthSubject(subject)).rejects.toThrow();
  });

  it('reads both block directions inside the actor context', async () => {
    const store = new PostgresBlockRelationStore(executorFor([{ blocked_by_actor: true, blocked_by_target: false }]));
    expect(await store.findBetween(userId, '00000000-0000-4000-8000-000000000002')).toEqual({
      blockedByActor: true,
      blockedByTarget: false,
    });
    expect(await store.findBetween('not-a-uuid', userId)).toBeNull();
  });

  it('fails closed if a block query returns missing or malformed boolean columns', async () => {
    const target = '00000000-0000-4000-8000-000000000002';
    for (const row of [[], [{ blocked_by_actor: false }], [{ blocked_by_actor: 0, blocked_by_target: false }]]) {
      const store = new PostgresBlockRelationStore(executorFor(row));
      await expect(store.findBetween(userId, target)).resolves.toBeNull();
    }
  });

  it('binds actor, target and subject as SQL parameters', async () => {
    const seen: Array<{ sql: string; values: readonly unknown[] }> = [];
    const exec: TrustedPostgresExecutor = {
      withAuthSubject: async (_s, callback) => callback({
        query: async <Row extends Record<string, unknown>>(sql: string, values: readonly unknown[]) => {
          seen.push({ sql, values });
          return { rows: [identityRow] as unknown as readonly Row[] };
        },
      }),
      withUserId: async (_s, callback) => callback({
        query: async <Row extends Record<string, unknown>>(sql: string, values: readonly unknown[]) => {
          seen.push({ sql, values });
          return { rows: [{ blocked_by_actor: false, blocked_by_target: false }] as unknown as readonly Row[] };
        },
      }),
    };
    const target = '00000000-0000-4000-8000-000000000002';
    await new PostgresIdentityRecordStore(exec).findByAuthSubject(subject);
    await new PostgresBlockRelationStore(exec).findBetween(userId, target);
    expect(seen).toHaveLength(2);
    expect(seen[0].sql).toContain('$1');
    expect(seen[0].values).toEqual([subject]);
    expect(seen[1].sql).toContain('$2');
    expect(seen[1].values).toEqual([userId, target]);
  });

  it('masks only a missing block target FK while rejecting audit FK failures', async () => {
    const actor = userId;
    const target = '00000000-0000-4000-8000-000000000002';
    const makePgError = (constraint: string) =>
      Object.assign(new Error('foreign key violation'), { code: '23503', constraint });
    const executorForConstraint = (failureAt: 'block' | 'audit', constraint: string): TrustedPostgresExecutor => ({
      withAuthSubject: async (_subject, operation) => operation({ query: async () => ({ rows: [] }) }),
      withUserId: async (_id, operation) => operation({ query: async () => ({ rows: [] }) }),
      withBlockWriter: async (_id, operation) => operation({
        query: async <Row extends Record<string, unknown>>(sql: string) => {
          if ((failureAt === 'block' && sql.includes('INSERT INTO blocks')) ||
              (failureAt === 'audit' && sql.includes('INSERT INTO audit_logs'))) {
            throw makePgError(constraint);
          }
          return { rows: [{ block_id: '00000000-0000-4000-8000-000000000099', target_user_id: target }] as unknown as readonly Row[] };
        },
      }),
    });
    await expect(new PostgresBlockMutationStore(
      executorForConstraint('block', 'blocks_blocked_id_fkey'),
    ).blockOwn(actor, target, 'request-1')).resolves.toBeUndefined();
    await expect(new PostgresBlockMutationStore(
      executorForConstraint('audit', 'audit_logs_target_user_id_fkey'),
    ).blockOwn(actor, target, 'request-2')).rejects.toMatchObject({
      code: '23503', constraint: 'audit_logs_target_user_id_fkey',
    });
    await expect(new PostgresBlockMutationStore(
      executorForConstraint('block', 'blocks_blocker_id_fkey'),
    ).blockOwn(actor, target, 'request-3')).rejects.toMatchObject({
      code: '23503', constraint: 'blocks_blocker_id_fkey',
    });
  });

  it('integrates a real JWT with the session API and the identity store', async () => {
    const { verifier, token } = await signedToken();
    const app = createApiAppWithDatabase({ verifier, executor: executorFor([identityRow]) });
    const response = await app.request('/api/v1/session', { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.session).toMatchObject({ userId, authLevel: 1, membership: 'free', roles: ['member'], status: 'active' });
    expect(body.data.session.authSubject).toBeUndefined();
  });

  it('returns a generic 401 on an identity database outage', async () => {
    const { verifier, token } = await signedToken();
    const outage: TrustedPostgresExecutor = {
      withAuthSubject: async () => { throw new Error('private database state'); },
      withUserId: async (_id, operation) => operation({ query: async () => ({ rows: [] }) }),
    };
    const response = await createApiAppWithDatabase({ verifier, executor: outage }).request('/api/v1/session', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.message).toBe('Identity is not available');
    expect(JSON.stringify(body)).not.toContain('private database state');
  });
});

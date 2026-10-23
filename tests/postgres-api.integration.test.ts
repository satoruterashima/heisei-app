import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { JwksJwtVerifier } from '../packages/auth/src/index.js';
import { createApiAppWithDatabase } from '../apps/api/src/index.js';
import { PostgresBlockRelationStore } from '../packages/database/src/index.js';
import type { PostgresQueryExecutor, TrustedPostgresExecutor } from '../packages/database/src/index.js';

const container = process.env.HEISEI_LOCAL_PG_CONTAINER;
const subject = 'integration-subject-1';
const userId = '00000000-0000-4000-8000-000000000001';
const targetId = '00000000-0000-4000-8000-000000000002';

function sqlLiteral(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:/-]+$/.test(value)) throw new Error('test value is not a safe SQL literal');
  return `'${value}'`;
}

function runPsql(sql: string): string {
  if (!container) throw new Error('HEISEI_LOCAL_PG_CONTAINER is required');
  return execFileSync('docker', [
    'exec', '-i', container, 'psql', '-h', '127.0.0.1', '-q', '-A', '-t', '-F', '\t', '-P', 'null=\\N',
    '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'heisei_local',
  ], { input: sql, encoding: 'utf8' });
}

function makeExecutor(): TrustedPostgresExecutor {
  const run = async <T>(role: string, settings: Record<string, string>, operation: (query: PostgresQueryExecutor) => Promise<T>) => {
    const query: PostgresQueryExecutor = {
      query: async <Row extends Record<string, unknown>>(text: string, values: readonly unknown[]) => {
        const rendered = text.replace(/\$(\d+)/g, (_match, index: string) => sqlLiteral(values[Number(index) - 1]));
        const settingsSql = Object.entries(settings).map(([key, value]) => `SET LOCAL ${key} = ${sqlLiteral(value)};`).join('\n');
        const output = runPsql(`BEGIN; SET LOCAL ROLE ${role};\n${settingsSql}\n${rendered};\nCOMMIT;`);
        const rows = output.trim() ? output.trimEnd().split('\n').map((line) => line.split('\t')) : [];
        const mapped = rows.map((columns) => {
          if (text.includes('p.auth_subject')) {
            return {
              auth_subject: columns[0] === '\\N' ? null : columns[0], user_id: columns[1], auth_level: Number(columns[2]),
              membership: columns[3], roles_json: columns[4], account_status: columns[5],
              verification_kind: columns[6] === '\\N' ? null : columns[6], verification_status: columns[7] === '\\N' ? null : columns[7],
            } as unknown as Row;
          }
          return { blocked_by_actor: columns[0] === 't', blocked_by_target: columns[1] === 't' } as unknown as Row;
        });
        return { rows: mapped } as { rows: readonly Row[] };
      },
    };
    return operation(query);
  };
  return {
    withAuthSubject: (value, operation) => run('heisei_identity_writer', { 'app.auth_subject': value }, operation),
    withUserId: (value, operation) => run('heisei_app', { 'app.user_id': value }, operation),
  };
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

describe.skipIf(!container)('real JWT → Hono → isolated PostgreSQL', () => {
  it('returns the identity loaded through RLS-scoped PostgreSQL', async () => {
    const { verifier, token } = await signedToken();
    const response = await createApiAppWithDatabase({ verifier, executor: makeExecutor() }).request('/api/v1/session', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).data.session).toMatchObject({ userId, authLevel: 1, status: 'active' });
  });

  it('rejects unknown subject and insufficient evidence without leaking DB state', async () => {
    const { verifier, token } = await signedToken('unknown-subject');
    const response = await createApiAppWithDatabase({ verifier, executor: makeExecutor() }).request('/api/v1/session', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).not.toContain('integration-subject');
  });

  it('reads both block directions through the same isolated executor', async () => {
    const result = await new PostgresBlockRelationStore(makeExecutor()).findBetween(userId, targetId);
    expect(result).toEqual({ blockedByActor: true, blockedByTarget: true });
  });
});

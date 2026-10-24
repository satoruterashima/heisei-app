import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { PostgresReportIdempotencyReadOnlyLookup, type TrustedPostgresExecutor } from '../packages/database/src/index.js';
import { createLocalTrustedPostgresExecutor } from '../packages/database/src/local-postgres-executor.js';

const container = process.env.HEISEI_LOCAL_PG_CONTAINER;
const databaseUrl = process.env.HEISEI_LOCAL_PG_URL;
const actor = '00000000-0000-4000-8000-000000000001';
const scopeHex = 'a'.repeat(64);
const payloadHex = 'b'.repeat(64);

function adminSql(sql: string): string {
  if (!container) throw new Error('local database container is required');
  return execFileSync('docker', ['exec', '-i', container, 'psql', '-h', '127.0.0.1', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'heisei_local'], { input: sql, encoding: 'utf8' }).trim();
}

describe.skipIf(!container || !databaseUrl)('actor-bound PostgreSQL report reconciliation', () => {
  let executor: TrustedPostgresExecutor;

  beforeAll(async () => {
    executor = await createLocalTrustedPostgresExecutor({ connectionString: databaseUrl, max: 2 });
  });
  beforeEach(() => {
    adminSql('DELETE FROM report_idempotency;');
  });
  afterAll(async () => {
    await (executor as { close?: () => Promise<void> }).close?.();
  });

  it('returns stored only for the exact actor/key-scope/payload tuple', async () => {
    adminSql(`INSERT INTO report_idempotency (reporter_user_id, reporter_scope_digest, payload_fingerprint, fingerprint_algorithm_version, fingerprint_key_version, expires_at) VALUES ('${actor}'::uuid, decode('${scopeHex}', 'hex'), decode('${payloadHex}', 'hex'), 'hmac-sha256-v1', 'hmac-v1', now() + interval '30 days');`);
    const lookup = new PostgresReportIdempotencyReadOnlyLookup(executor);
    await expect(lookup.lookup({ actorUserId: actor, candidates: [{ keyVersion: 'hmac-v1', scopeHex, payloadHex }] })).resolves.toEqual({ result: 'stored', candidate: { keyVersion: 'hmac-v1', scopeHex, payloadHex } });
    await expect(lookup.lookup({ actorUserId: actor, candidates: [{ keyVersion: 'hmac-v1', scopeHex, payloadHex: 'c'.repeat(64) }] })).resolves.toEqual({ result: 'not_found' });
  });

  it('cannot write or read another actor through the reconciliation role', async () => {
    await expect(executor.withReportReconciler!(actor, (query) => query.query('INSERT INTO report_idempotency (reporter_user_id, reporter_scope_digest, payload_fingerprint, fingerprint_algorithm_version, fingerprint_key_version, expires_at) VALUES ($1::uuid, decode($2, \'hex\'), decode($3, \'hex\'), \'hmac-sha256-v1\', \'hmac-v1\', now() + interval \'30 days\')', [actor, scopeHex, payloadHex]))).rejects.toThrow();
    const other = '00000000-0000-4000-8000-000000000002';
    adminSql(`INSERT INTO report_idempotency (reporter_user_id, reporter_scope_digest, payload_fingerprint, fingerprint_algorithm_version, fingerprint_key_version, expires_at) VALUES ('${other}'::uuid, decode('${scopeHex}', 'hex'), decode('${payloadHex}', 'hex'), 'hmac-sha256-v1', 'hmac-v1', now() + interval '30 days');`);
    const result = await new PostgresReportIdempotencyReadOnlyLookup(executor).lookup({ actorUserId: actor, candidates: [{ keyVersion: 'hmac-v1', scopeHex, payloadHex }] });
    expect(result).toEqual({ result: 'not_found' });
  });
});

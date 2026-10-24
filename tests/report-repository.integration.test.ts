import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  FixtureReportKeyProvider,
  createReportFingerprint,
  encryptReportDescription,
  type ReportKeyProvider,
  type ValidatedReportPayload,
} from '../packages/validation/src/index.js';
import { prepareReportPayload, ReportRepository, type ReportCryptoAdapter, type TrustedPostgresExecutor } from '../packages/database/src/index.js';
import { createLocalTrustedPostgresExecutor } from '../packages/database/src/local-postgres-executor.js';

const container = process.env.HEISEI_LOCAL_PG_CONTAINER;
const databaseUrl = process.env.HEISEI_LOCAL_PG_URL;
const actor = '00000000-0000-4000-8000-000000000001';
const target = '00000000-0000-4000-8000-000000000003';
const otherTarget = '00000000-0000-4000-8000-000000000004';

function adminSql(sql: string): string {
  if (!container) throw new Error('local database container is required');
  return execFileSync('docker', ['exec', '-i', container, 'psql', '-h', '127.0.0.1', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'heisei_local'], { input: sql, encoding: 'utf8' }).trim();
}

function base64UrlToHex(value: string): string {
  const base64 = value.replace(/-/gu, '+').replace(/_/gu, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Array.from(binary, (character) => character.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

function payload(targetUserId = target, description = 'normalized text') {
  const result = prepareReportPayload({ targetType: 'user', targetUserId, category: 'other', categoryVersion: 'category-v1', normalizedDescription: description, originalDescription: `  ${description}  ` });
  if (!result) throw new Error('test payload preparation failed');
  return result;
}

async function adapter(provider: ReportKeyProvider, fingerprintVersions: readonly string[] = ['hmac-v1', 'hmac-v2']): Promise<ReportCryptoAdapter> {
  return {
    fingerprintVersions,
    encryptionKeyVersion: 'enc-v1',
    createFingerprint: async ({ actorUserId, idempotencyKey, payload: value, keyVersion }) => {
      const result = await createReportFingerprint({
        reporterUserId: actorUserId,
        idempotencyKey,
        payload: value as ValidatedReportPayload,
        keyVersion,
      }, provider);
      return {
        scopeHex: base64UrlToHex(result.reporterScope),
        payloadHex: base64UrlToHex(result.payloadFingerprint),
        keyVersion: result.keyVersion,
        algorithmVersion: result.scheme,
      };
    },
    encryptDescription: async ({ description, reportId, actorUserId, targetUserId, keyVersion }) => {
      const envelope = await encryptReportDescription(description, { reportId, reporterUserId: actorUserId, targetUserId }, keyVersion, provider);
      return {
        ciphertextHex: base64UrlToHex(envelope.ciphertext),
        nonceHex: base64UrlToHex(envelope.nonce),
        algorithmVersion: envelope.algorithmVersion,
        encryptionKeyVersion: envelope.keyVersion,
        aadVersion: envelope.aadVersion,
      };
    },
  };
}

describe.skipIf(!container || !databaseUrl)('G4-B2 internal report repository on isolated PostgreSQL', () => {
  let executor: TrustedPostgresExecutor;
  let provider: ReportKeyProvider;

  beforeAll(async () => {
    executor = await createLocalTrustedPostgresExecutor({ connectionString: databaseUrl, max: 4 });
    provider = await FixtureReportKeyProvider.create(['hmac-v1', 'hmac-v2', 'enc-v1']);
  });

  beforeEach(() => {
    adminSql(`DELETE FROM report_idempotency; DELETE FROM reports; DELETE FROM audit_logs WHERE rule_version = '003i-g4b2';`);
  });

  afterAll(async () => {
    await (executor as { close?: () => Promise<void> }).close?.();
  });

  it('stores encrypted original text, normalized fingerprint, and audit atomically', async () => {
    const repo = new ReportRepository(executor, await adapter(provider));
    const result = await repo.createReport(
      { userId: actor, authSubject: 'integration-subject-1', authLevel: 2, accountStatus: 'active' },
      { ...payload(), idempotencyKey: '00000000-0000-4000-8000-000000000004', requestId: 'g4b2-accepted' },
    );
    expect(result.result).toBe('accepted');
    expect(adminSql(`SELECT count(*) FROM reports WHERE reporter_user_id = '${actor}'::uuid AND target_user_id = '${target}'::uuid AND description_ciphertext IS NOT NULL`)).toBe('1');
    expect(adminSql(`SELECT count(*) FROM report_idempotency WHERE reporter_user_id = '${actor}'::uuid`)).toBe('1');
    expect(adminSql("SELECT count(*) FROM audit_logs WHERE request_id = 'g4b2-accepted' AND action = 'report.create'")).toBe('1');
    expect(adminSql("SELECT count(*) FROM reports WHERE description_ciphertext::text ILIKE '%normalized%'")).toBe('0');
  });

  it('replays the same key, rejects changed payload, and preserves the report', async () => {
    const repo = new ReportRepository(executor, await adapter(provider));
    const key = '00000000-0000-4000-8000-000000000005';
    const first = await repo.createReport({ userId: actor, authSubject: 'integration-subject-1', authLevel: 2, accountStatus: 'active' }, { ...payload(), idempotencyKey: key, requestId: 'g4b2-replay-1' });
    const replay = await repo.createReport({ userId: actor, authSubject: 'integration-subject-1', authLevel: 2, accountStatus: 'active' }, { ...payload(), idempotencyKey: key, requestId: 'g4b2-replay-2' });
    const conflict = await repo.createReport({ userId: actor, authSubject: 'integration-subject-1', authLevel: 2, accountStatus: 'active' }, { ...payload(target, 'changed'), idempotencyKey: key, requestId: 'g4b2-conflict' });
    expect(first.result).toBe('accepted');
    expect(replay.result).toBe('replayed');
    expect(conflict.result).toBe('idempotency_conflict');
    expect(adminSql(`SELECT count(*) FROM reports WHERE reporter_user_id = '${actor}'::uuid AND target_user_id = '${target}'::uuid`)).toBe('1');
  });

  it('returns duplicate for a different key without changing the existing pending report', async () => {
    const repo = new ReportRepository(executor, await adapter(provider));
    const accepted = await repo.createReport({ userId: actor, authSubject: 'integration-subject-1', authLevel: 2, accountStatus: 'active' }, { ...payload(), idempotencyKey: '00000000-0000-4000-8000-000000000012', requestId: 'g4b2-duplicate-seed' });
    const result = await repo.createReport({ userId: actor, authSubject: 'integration-subject-1', authLevel: 2, accountStatus: 'active' }, { ...payload(), idempotencyKey: '00000000-0000-4000-8000-000000000006', requestId: 'g4b2-duplicate' });
    expect(accepted.result).toBe('accepted');
    expect(result.result).toBe('duplicate');
    expect(adminSql(`SELECT count(*) FROM reports WHERE reporter_user_id = '${actor}'::uuid AND target_user_id = '${target}'::uuid`)).toBe('1');
  });

  it('serializes one key used concurrently for different targets', async () => {
    const repo = new ReportRepository(executor, await adapter(provider));
    const key = '00000000-0000-4000-8000-000000000007';
    const results = await Promise.all([
      repo.createReport({ userId: actor, authSubject: 'integration-subject-1', authLevel: 2, accountStatus: 'active' }, { ...payload(target), idempotencyKey: key, requestId: 'g4b2-same-key-a' }),
      repo.createReport({ userId: actor, authSubject: 'integration-subject-1', authLevel: 2, accountStatus: 'active' }, { ...payload(otherTarget), idempotencyKey: key, requestId: 'g4b2-same-key-b' }),
    ]);
    expect(results.filter((value) => value.result === 'accepted')).toHaveLength(1);
    expect(results.filter((value) => value.result === 'idempotency_conflict')).toHaveLength(1);
    expect(adminSql(`SELECT count(*) FROM report_idempotency WHERE reporter_user_id = '${actor}'::uuid`)).toBe('1');
  });

  it('supports old HMAC version replay and fails closed on missing keys', async () => {
    const oldRepo = new ReportRepository(executor, await adapter(provider, ['hmac-v1']));
    const key = '00000000-0000-4000-8000-000000000008';
    const accepted = await oldRepo.createReport({ userId: actor, authSubject: 'integration-subject-1', authLevel: 2, accountStatus: 'active' }, { ...payload(otherTarget), idempotencyKey: key, requestId: 'g4b2-rotation-1' });
    const rotatedRepo = new ReportRepository(executor, await adapter(provider, ['hmac-v2', 'hmac-v1']));
    const replay = await rotatedRepo.createReport({ userId: actor, authSubject: 'integration-subject-1', authLevel: 2, accountStatus: 'active' }, { ...payload(otherTarget), idempotencyKey: key, requestId: 'g4b2-rotation-2' });
    const missingKeyRepo = new ReportRepository(executor, await adapter(await FixtureReportKeyProvider.create(['hmac-v2', 'enc-v1'])));
    const unavailable = await missingKeyRepo.createReport({ userId: actor, authSubject: 'integration-subject-1', authLevel: 2, accountStatus: 'active' }, { ...payload(otherTarget), idempotencyKey: '00000000-0000-4000-8000-000000000009', requestId: 'g4b2-key-missing' });
    expect(accepted.result).toBe('accepted');
    expect(replay.result).toBe('replayed');
    expect(unavailable.result).toBe('unavailable');
  });

  it('rejects malformed candidate JSON and envelope before any write', async () => {
    const call = (candidates: string, envelope: readonly (string | null)[]) => executor.withReportWriter!(
      actor, otherTarget, (query) => query.query<{ result: string; report_id: string | null }>(
        `SELECT * FROM report_create_atomic_v2($1::uuid, 'other', 'category-v1', 'g4b2-invalid', $2::uuid, $3::jsonb, $4::text, $5::text, $6::text, $7::text, $8::text, 'hmac-sha256-v1')`,
        [otherTarget, '00000000-0000-4000-8000-000000000099', candidates, ...envelope],
      ),
      'integration-subject-1',
    );
    const validCandidate = JSON.stringify([{ scope_hex: '00'.repeat(32), payload_hex: '11'.repeat(32), key_version: 'hmac-v1', algorithm_version: 'hmac-sha256-v1' }]);
    const extraField = JSON.stringify([{ scope_hex: '00'.repeat(32), payload_hex: '11'.repeat(32), key_version: 'hmac-v1', algorithm_version: 'hmac-sha256-v1', extra: 'reject' }]);
    const duplicateVersion = JSON.stringify([
      { scope_hex: '00'.repeat(32), payload_hex: '11'.repeat(32), key_version: 'hmac-v1', algorithm_version: 'hmac-sha256-v1' },
      { scope_hex: '22'.repeat(32), payload_hex: '33'.repeat(32), key_version: 'hmac-v1', algorithm_version: 'hmac-sha256-v1' },
    ]);
    for (const candidates of [extraField, duplicateVersion]) {
      await expect(call(candidates, [null, null, null, null, null])).resolves.toMatchObject({ rows: [{ result: 'unavailable', report_id: null }] });
    }
    await expect(call(validCandidate, ['00'.repeat(16), '00'.repeat(12), 'aes-256-gcm-v1', null, 'aad-v1']))
      .resolves.toMatchObject({ rows: [{ result: 'unavailable', report_id: null }] });
    expect(adminSql(`SELECT count(*) FROM reports WHERE id = '00000000-0000-4000-8000-000000000099'::uuid`)).toBe('0');
    expect(adminSql("SELECT count(*) FROM audit_logs WHERE request_id = 'g4b2-invalid'")).toBe('0');
  });

  it('denies visibility failures and rejects direct report INSERT', async () => {
    const repo = new ReportRepository(executor, await adapter(provider));
    expect((await repo.createReport({ userId: actor, authSubject: 'integration-subject-1', authLevel: 1, accountStatus: 'active' }, { ...payload(), idempotencyKey: '00000000-0000-4000-8000-000000000010', requestId: 'g4b2-claimed-level' })).result).toBe('accepted');
    adminSql(`UPDATE profiles SET account_status = 'suspended' WHERE id = '${actor}'::uuid`);
    expect((await repo.createReport({ userId: actor, authSubject: 'integration-subject-1', authLevel: 2, accountStatus: 'active' }, { ...payload(otherTarget), idempotencyKey: '00000000-0000-4000-8000-000000000011', requestId: 'g4b2-deny-status' })).result).toBe('denied');
    adminSql(`UPDATE profiles SET account_status = 'active' WHERE id = '${actor}'::uuid`);
    await expect(executor.withReportWriter!(actor, target, (query) => query.query("INSERT INTO reports (reporter_user_id, target_type, target_user_id, category, category_version) VALUES ($1, 'user', $2, 'other', 'category-v1')", [actor, target]), 'integration-subject-1')).rejects.toThrow();
    expect(adminSql("SELECT count(*) FROM audit_logs WHERE rule_version = '003i-g4b2' AND action = 'report.create'")).toBe('1');
  });
});

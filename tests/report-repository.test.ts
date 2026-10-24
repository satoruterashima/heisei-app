import { describe, expect, it } from 'vitest';
import { prepareReportPayload, ReportRepository, TransactionRollbackError, UnknownCommitError, validDescriptionEnvelope, type ReportCryptoAdapter, type TrustedPostgresExecutor } from '../packages/database/src/index.js';

const actor = '00000000-0000-4000-8000-000000000001';
const target = '00000000-0000-4000-8000-000000000002';

const cryptoAdapter: ReportCryptoAdapter = {
  fingerprintVersions: ['hmac-v1'],
  activeFingerprintVersion: 'hmac-v1',
  encryptionKeyVersion: 'enc-v1',
  createFingerprint: async () => ({ scopeHex: '00'.repeat(32), payloadHex: '11'.repeat(32), keyVersion: 'hmac-v1', algorithmVersion: 'hmac-sha256-v1' }),
  encryptDescription: async () => ({ ciphertextHex: '00'.repeat(16), nonceHex: '00'.repeat(12), algorithmVersion: 'aes-256-gcm-v1', encryptionKeyVersion: 'enc-v1', aadVersion: 'aad-v1' }),
};

const prepared = prepareReportPayload({
  targetType: 'user', targetUserId: target, category: 'other', categoryVersion: 'category-v1',
  normalizedDescription: 'original', originalDescription: '  original  ',
});
if (!prepared) throw new Error('test payload preparation failed');
const input = { ...prepared, idempotencyKey: '00000000-0000-4000-8000-000000000004', requestId: 'repository-test' };

describe('ReportRepository failure projection', () => {
  it('requires a prepared raw/normalized payload pair', () => {
    expect(prepareReportPayload({
      targetType: 'user', targetUserId: target, category: 'other', categoryVersion: 'category-v1',
      normalizedDescription: 'normalized', originalDescription: 'different',
    })).toBeNull();
  });

  it('binds NULL envelope strictly to absent original text', () => {
    const valid = { ciphertextHex: '00'.repeat(16), nonceHex: '00'.repeat(12), algorithmVersion: 'aes-256-gcm-v1', encryptionKeyVersion: 'enc-v1', aadVersion: 'aad-v1' };
    expect(validDescriptionEnvelope(null, null)).toBe(true);
    expect(validDescriptionEnvelope(null, valid)).toBe(false);
    expect(validDescriptionEnvelope('original', null)).toBe(false);
    expect(validDescriptionEnvelope('original', valid)).toBe(true);
  });

  it('does not open a DB transaction for a raw description with a NULL envelope', async () => {
    let calls = 0;
    const executor: TrustedPostgresExecutor = {
      withReportWriter: async () => { calls += 1; throw new Error('must not reach database'); },
      withAuthSubject: async () => { throw new Error('not used'); },
      withUserId: async () => { throw new Error('not used'); },
    };
    const result = await new ReportRepository(executor, { ...cryptoAdapter, encryptDescription: async () => null }).createReport(
      { userId: actor, authSubject: 'subject-1', authLevel: 2, accountStatus: 'active' }, input,
    );
    expect(result).toEqual({ result: 'unavailable' });
    expect(calls).toBe(0);
  });

  it('uses a NULL envelope when the original description is absent', async () => {
    let encryptCalls = 0;
    const executor: TrustedPostgresExecutor = {
      withReportWriter: async (_actor, _target, operation) => operation({
        query: async <Row extends Record<string, unknown>>() => ({ rows: [{ result: 'accepted', report_id: '00000000-0000-4000-8000-000000000099' } as unknown as Row] }),
      }),
      withAuthSubject: async () => { throw new Error('not used'); },
      withUserId: async () => { throw new Error('not used'); },
    };
    const result = await new ReportRepository(executor, {
      ...cryptoAdapter,
      encryptDescription: async () => { encryptCalls += 1; return cryptoAdapter.encryptDescription({ description: '', reportId: '', actorUserId: actor, targetUserId: target, keyVersion: 'enc-v1' }); },
    }).createReport(
      { userId: actor, authSubject: 'subject-1', authLevel: 2, accountStatus: 'active' },
      { ...prepareReportPayload({ targetType: 'user', targetUserId: target, category: 'other', categoryVersion: 'category-v1', normalizedDescription: null, originalDescription: null })!, idempotencyKey: '00000000-0000-4000-8000-000000000005', requestId: 'no-description' },
    );
    expect(result.result).toBe('accepted');
    expect(encryptCalls).toBe(0);
  });

  it('fails closed when crypto returns an invalid envelope or candidate', async () => {
    let calls = 0;
    const executor: TrustedPostgresExecutor = {
      withReportWriter: async () => { calls += 1; throw new Error('must not reach database'); },
      withAuthSubject: async () => { throw new Error('not used'); },
      withUserId: async () => { throw new Error('not used'); },
    };
    const malformed: ReportCryptoAdapter = {
      fingerprintVersions: ['hmac-v1'], encryptionKeyVersion: 'enc-v1',
      activeFingerprintVersion: 'hmac-v1',
      createFingerprint: async () => ({ scopeHex: 'not-a-digest', payloadHex: '11'.repeat(32), keyVersion: 'hmac-v1', algorithmVersion: 'hmac-sha256-v1' }),
      encryptDescription: async () => ({ ciphertextHex: '00'.repeat(16), nonceHex: '00'.repeat(12), algorithmVersion: 'aes-256-gcm-v1', encryptionKeyVersion: 'enc-v1', aadVersion: 'aad-v1' }),
    };
    const result = await new ReportRepository(executor, malformed).createReport(
      { userId: actor, authSubject: 'subject-1', authLevel: 2, accountStatus: 'active' }, input,
    );
    expect(result).toEqual({ result: 'unavailable' });
    expect(calls).toBe(0);
  });

  it('projects rollback, lock, and deadlock failures without exposing internals', async () => {
    for (const [error, expected] of [
      [new TransactionRollbackError({ code: 'XX000', detail: 'private SQL' }), 'rollback'],
      [new TransactionRollbackError({ code: '55P03', detail: 'private SQL' }), 'lock_timeout'],
      [new TransactionRollbackError({ code: '40P01', detail: 'private SQL' }), 'deadlock'],
    ] as const) {
      const executor: TrustedPostgresExecutor = {
        withReportWriter: async () => { throw error; },
        withAuthSubject: async () => { throw new Error('not used'); },
        withUserId: async () => { throw new Error('not used'); },
      };
      await expect(new ReportRepository(executor, cryptoAdapter).createReport(
        { userId: actor, authSubject: 'subject-1', authLevel: 2, accountStatus: 'active' }, input,
      )).resolves.toEqual({ result: expected });
    }
  });

  it('returns unknown_commit without retrying after an indeterminate commit', async () => {
    let calls = 0;
    const executor: TrustedPostgresExecutor = {
      withReportWriter: async () => {
        calls += 1;
        throw new UnknownCommitError();
      },
      withAuthSubject: async () => { throw new Error('not used'); },
      withUserId: async () => { throw new Error('not used'); },
    };
    const result = await new ReportRepository(executor, cryptoAdapter).createReport(
      { userId: actor, authSubject: 'subject-1', authLevel: 2, accountStatus: 'active' }, input,
    );
    expect(result).toEqual({ result: 'unknown_commit' });
    expect(calls).toBe(1);
  });

  it('maps connection failures to unavailable without exposing the error', async () => {
    const executor: TrustedPostgresExecutor = {
      withReportWriter: async () => { throw new Error('private SQL connection details'); },
      withAuthSubject: async () => { throw new Error('not used'); },
      withUserId: async () => { throw new Error('not used'); },
    };
    const result = await new ReportRepository(executor, cryptoAdapter).createReport(
      { userId: actor, authSubject: 'subject-1', authLevel: 2, accountStatus: 'active' }, input,
    );
    expect(result).toEqual({ result: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('private SQL');
  });
});

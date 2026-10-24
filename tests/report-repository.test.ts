import { describe, expect, it } from 'vitest';
import { ReportRepository, UnknownCommitError, type ReportCryptoAdapter, type TrustedPostgresExecutor } from '../packages/database/src/index.js';

const actor = '00000000-0000-4000-8000-000000000001';
const target = '00000000-0000-4000-8000-000000000002';

const cryptoAdapter: ReportCryptoAdapter = {
  fingerprintVersions: ['hmac-v1'],
  encryptionKeyVersion: 'enc-v1',
  createFingerprint: async () => ({ scopeHex: '00'.repeat(32), payloadHex: '11'.repeat(32), keyVersion: 'hmac-v1', algorithmVersion: 'hmac-sha256-v1' }),
  encryptDescription: async () => null,
};

const input = {
  targetType: 'user' as const,
  targetUserId: target,
  category: 'other',
  categoryVersion: 'category-v1',
  description: 'normalized',
  rawDescription: 'original',
  idempotencyKey: '00000000-0000-4000-8000-000000000004',
  requestId: 'repository-test',
};

describe('ReportRepository failure projection', () => {
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
      { userId: actor, authLevel: 2, accountStatus: 'active' }, input,
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
      { userId: actor, authLevel: 2, accountStatus: 'active' }, input,
    );
    expect(result).toEqual({ result: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('private SQL');
  });
});

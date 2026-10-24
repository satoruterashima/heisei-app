import { describe, expect, it } from 'vitest';
import { SecretReportKeyProvider, ReportCryptoError } from '../packages/validation/src/index.js';
import { productionPostgresSettings } from '../packages/database/src/index.js';
import { planReportRetention, quotaConfigFromSource } from '../packages/domain/src/index.js';

const quotaSource = Object.fromEntries([
  ['SHORT_WINDOW_MS', '100'], ['SHORT_REQUEST_LIMIT', '2'], ['LONG_WINDOW_MS', '1000'], ['LONG_REQUEST_LIMIT', '4'],
  ['ADMISSION_WINDOW_MS', '1000'], ['NEW_ADMISSION_LIMIT', '4'], ['RESERVATION_TTL_MS', '50'],
  ['MAX_ACTIVE_RESERVATIONS', '3'], ['STATE_RETENTION_MS', '200'],
].map(([key, value]) => [`HEISEI_QUOTA_${key}`, value]));

describe('production configuration boundaries', () => {
  it('requires all quota values and never supplies production defaults', () => {
    expect(quotaConfigFromSource(quotaSource)).toMatchObject({ shortWindowMs: 100, newAdmissionLimit: 4 });
    expect(() => quotaConfigFromSource({})).toThrow();
    expect(() => quotaConfigFromSource({ ...quotaSource, HEISEI_QUOTA_SHORT_REQUEST_LIMIT: '0' })).toThrow();
  });

  it('requires TLS and bounded database pool/timeouts without opening a connection', () => {
    const settings = productionPostgresSettings({
      HEISEI_DATABASE_URL: 'postgresql://secret-host/db', HEISEI_DATABASE_POOL_MAX: '5',
      HEISEI_DATABASE_CONNECT_TIMEOUT_MS: '1000', HEISEI_DATABASE_STATEMENT_TIMEOUT_MS: '5000', HEISEI_DATABASE_QUERY_TIMEOUT_MS: '5000',
    });
    expect(settings.ssl).toEqual({ rejectUnauthorized: true });
    expect(() => productionPostgresSettings({
      HEISEI_DATABASE_URL: 'postgresql://host/db?sslmode=disable', HEISEI_DATABASE_POOL_MAX: '5',
      HEISEI_DATABASE_CONNECT_TIMEOUT_MS: '1000', HEISEI_DATABASE_STATEMENT_TIMEOUT_MS: '5000', HEISEI_DATABASE_QUERY_TIMEOUT_MS: '5000',
    })).toThrow();
  });

  it('imports only explicit 32-byte secret versions and fails closed when missing', async () => {
    const key = btoa(String.fromCharCode(...new Uint8Array(32))).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
    const provider = new SecretReportKeyProvider({
      source: { get: (name) => name.endsWith('_v1') ? key : undefined },
      encryptionKeyVersions: ['v1'], fingerprintKeyVersions: ['v1'],
    });
    expect((await provider.getEncryptionKey('v1')).type).toBe('secret');
    await expect(provider.getFingerprintKey('missing')).rejects.toBeInstanceOf(ReportCryptoError);
    await expect(new SecretReportKeyProvider({ source: { get: () => 'bad' }, encryptionKeyVersions: ['v1'], fingerprintKeyVersions: ['v1'] }).getEncryptionKey('v1')).rejects.toBeInstanceOf(ReportCryptoError);
  });

  it('plans retention but never deletes legal-hold or unproven records', () => {
    const result = planReportRetention({ nowMs: 31 * 86_400_000, retentionDays: 30, candidates: [
      { reportId: 'old', createdAtMs: 0, status: 'pending', legalHold: false },
      { reportId: 'held', createdAtMs: 0, status: 'pending', legalHold: true },
    ] });
    expect(result).toEqual([{ action: 'delete', reportId: 'old' }, { action: 'retain', reportId: 'held', reason: 'legal_hold' }]);
    expect(planReportRetention({ nowMs: 1, retentionDays: undefined, candidates: [{ reportId: 'x', createdAtMs: 0, status: 'pending', legalHold: false }] })[0]).toMatchObject({ action: 'retain', reason: 'invalid_evidence' });
  });
});

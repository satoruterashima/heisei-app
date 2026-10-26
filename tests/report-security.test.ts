import { describe, expect, it } from 'vitest';
import {
  REPORT_MAX_BODY_BYTES,
  REPORT_MAX_DESCRIPTION_CODE_POINTS,
  FixtureReportKeyProvider,
  ReportCryptoError,
  canonicalizeReportPayload,
  createReportFingerprint,
  decryptReportDescription,
  encryptReportDescription,
  fingerprintsEqual,
  parseAndValidateReportPayload,
  validateIdempotencyKey,
  validateReportPayload,
  utf8ByteLength,
} from '../packages/validation/src/index.js';

const actor = '00000000-0000-4000-8000-000000000001';
const target = '00000000-0000-4000-8000-000000000002';
const reportId = '00000000-0000-4000-8000-000000000003';
const key = '00000000-0000-4000-8000-000000000004';
const payload = { targetType: 'user' as const, targetUserId: target, category: 'other' as const, description: '説明 😀' };

function validatedPayload() {
  const result = validateReportPayload(payload);
  if (!result.ok) throw new Error('test payload must be valid');
  return result.value;
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/gu, '+').replace(/_/gu, '/');
  const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`;
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

describe('report payload validator', () => {
  it('accepts all approved categories and normalizes UUID/description', () => {
    for (const category of ['harassment', 'spam', 'impersonation', 'inappropriate_content', 'fraud', 'other'] as const) {
      const result = validateReportPayload({ targetType: 'user', targetUserId: target.toUpperCase(), category, description: '  ｅ́\r\n説明  ' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toMatchObject({ targetUserId: target, category, description: 'é\n説明' });
    }
  });

  it.each([
    ['non-object', []],
    ['unknown field', { ...payload, extra: true }],
    ['invalid target type', { ...payload, targetType: 'post' }],
    ['invalid UUID', { ...payload, targetUserId: 'not-a-uuid' }],
    ['invalid category', { ...payload, category: 'unknown' }],
    ['description number', { ...payload, description: 1 }],
    ['empty description', { ...payload, description: '' }],
    ['whitespace-only description', { ...payload, description: ' \n\t ' }],
    ['forbidden control character', { ...payload, description: 'bad\u0000text' }],
  ] as const)('rejects %s', (_name, value) => {
    expect(validateReportPayload(value).ok).toBe(false);
  });

  it('uses Unicode code points after fixed normalization', () => {
    expect(validateReportPayload({ ...payload, description: '😀'.repeat(REPORT_MAX_DESCRIPTION_CODE_POINTS) }).ok).toBe(true);
    expect(validateReportPayload({ ...payload, description: '😀'.repeat(REPORT_MAX_DESCRIPTION_CODE_POINTS + 1) }).ok).toBe(false);
    expect(validateReportPayload({ ...payload, description: 'e\u0301'.repeat(500) }).ok).toBe(true);
    expect(validateReportPayload({ ...payload, description: 'e\u0301'.repeat(501) }).ok).toBe(false);
    expect(validateReportPayload({ ...payload, description: 'line\nfeed\tallowed' }).ok).toBe(true);
  });

  it('measures actual UTF-8 JSON bytes, not Content-Length', () => {
    const json = JSON.stringify(payload);
    const exact = `${' '.repeat(REPORT_MAX_BODY_BYTES - utf8ByteLength(json))}${json}`;
    expect(utf8ByteLength(exact)).toBe(REPORT_MAX_BODY_BYTES);
    expect(parseAndValidateReportPayload(exact).ok).toBe(true);
    expect(parseAndValidateReportPayload(`${' '.repeat(REPORT_MAX_BODY_BYTES + 1 - utf8ByteLength(json))}${json}`).ok).toBe(false);
    expect(parseAndValidateReportPayload('{"targetType":').ok).toBe(false);
    expect(parseAndValidateReportPayload(new Uint8Array([0xff])).ok).toBe(false);
  });
});

describe('idempotency validation and fingerprint', () => {
  it('strictly validates and normalizes UUID v4 keys', () => {
    expect(validateIdempotencyKey(key.toUpperCase())).toEqual({ ok: true, normalized: key });
    expect(validateIdempotencyKey('00000000-0000-3000-8000-000000000004')).toEqual({ ok: false, code: 'invalid_idempotency_key' });
    expect(validateIdempotencyKey('not-a-uuid')).toEqual({ ok: false, code: 'invalid_idempotency_key' });
  });

  it('reproduces canonical fingerprints for the same reporter/key/payload', async () => {
    const provider = await FixtureReportKeyProvider.create(['hmac-v1', 'hmac-v2']);
    const first = await createReportFingerprint({ reporterUserId: actor, idempotencyKey: key, payload: validatedPayload(), keyVersion: 'hmac-v1' }, provider);
    const second = await createReportFingerprint({ reporterUserId: actor.toUpperCase(), idempotencyKey: key.toUpperCase(), payload: { ...validatedPayload(), targetUserId: target.toUpperCase() }, keyVersion: 'hmac-v1' }, provider);
    expect(fingerprintsEqual(first, second)).toBe(true);
    expect(canonicalizeReportPayload(validatedPayload())).toContain('category-v1');
  });

  it('separates reporter scope, payload changes, and HMAC key versions', async () => {
    const provider = await FixtureReportKeyProvider.create(['hmac-v1', 'hmac-v2']);
    const first = await createReportFingerprint({ reporterUserId: actor, idempotencyKey: key, payload: validatedPayload(), keyVersion: 'hmac-v1' }, provider);
    const otherReporter = await createReportFingerprint({ reporterUserId: target, idempotencyKey: key, payload: validatedPayload(), keyVersion: 'hmac-v1' }, provider);
    const changed = await createReportFingerprint({ reporterUserId: actor, idempotencyKey: key, payload: { ...validatedPayload(), category: 'spam' }, keyVersion: 'hmac-v1' }, provider);
    const rotated = await createReportFingerprint({ reporterUserId: actor, idempotencyKey: key, payload: validatedPayload(), keyVersion: 'hmac-v2' }, provider);
    expect(first.reporterScope).not.toBe(otherReporter.reporterScope);
    expect(first.payloadFingerprint).not.toBe(changed.payloadFingerprint);
    expect(first.payloadFingerprint).not.toBe(rotated.payloadFingerprint);
    expect(fingerprintsEqual(first, otherReporter)).toBe(false);
  });

  it('rechecks a stored idempotency record with its original key version after rotation', async () => {
    const provider = await FixtureReportKeyProvider.create(['hmac-v1', 'hmac-v2']);
    const storedRecord = await createReportFingerprint({ reporterUserId: actor, idempotencyKey: key, payload: validatedPayload(), keyVersion: 'hmac-v1' }, provider);
    const recheckedRecord = await createReportFingerprint({ reporterUserId: actor, idempotencyKey: key, payload: validatedPayload(), keyVersion: storedRecord.keyVersion }, provider);
    expect(recheckedRecord.keyVersion).toBe('hmac-v1');
    expect(fingerprintsEqual(storedRecord, recheckedRecord)).toBe(true);
  });
});

describe('report description AES-256-GCM', () => {
  it('encrypts/decrypts with unique nonces and separated HMAC/encryption keys', async () => {
    const provider = await FixtureReportKeyProvider.create(['enc-v1', 'enc-v2']);
    const context = { reportId, reporterUserId: actor, targetUserId: target };
    const first = await encryptReportDescription('secret text', context, 'enc-v1', provider);
    const second = await encryptReportDescription('secret text', context, 'enc-v1', provider);
    expect(first.nonce).not.toBe(second.nonce);
    expect(await decryptReportDescription(first, context, provider)).toBe('secret text');
    expect(await provider.getEncryptionKey('enc-v1')).not.toBe(await provider.getFingerprintKey('enc-v1'));
  });

  it('rejects ciphertext, nonce, and AAD tampering without exposing plaintext', async () => {
    const provider = await FixtureReportKeyProvider.create(['enc-v1']);
    const context = { reportId, reporterUserId: actor, targetUserId: target };
    const encrypted = await encryptReportDescription('do not leak this', context, 'enc-v1', provider);
    const ciphertextBytes = decodeBase64Url(encrypted.ciphertext);
    ciphertextBytes[Math.floor(ciphertextBytes.length / 2)] ^= 0x01;
    const tamperedCiphertext = { ...encrypted, ciphertext: encodeBase64Url(ciphertextBytes) };
    const nonceBytes = decodeBase64Url(encrypted.nonce);
    nonceBytes[0] ^= 0x01;
    const tamperedNonce = { ...encrypted, nonce: encodeBase64Url(nonceBytes) };
    await expect(decryptReportDescription(tamperedCiphertext, context, provider)).rejects.toBeInstanceOf(ReportCryptoError);
    await expect(decryptReportDescription(tamperedNonce, context, provider)).rejects.toBeInstanceOf(ReportCryptoError);
    await expect(decryptReportDescription(encrypted, { ...context, targetUserId: actor }, provider)).rejects.toBeInstanceOf(ReportCryptoError);
    try {
      await decryptReportDescription(tamperedCiphertext, context, provider);
    } catch (error) {
      expect(error).toBeInstanceOf(ReportCryptoError);
      expect(String(error)).toBe('ReportCryptoError: report cryptographic operation failed');
      expect(String(error)).not.toContain('do not leak this');
      expect(String(error)).not.toMatch(/enc-v1|AES|CryptoKey|OperationError|nonce|ciphertext/iu);
    }
  });

  it('supports key rotation and fails closed when an old key is unavailable', async () => {
    const rotatedProvider = await FixtureReportKeyProvider.create(['enc-v1', 'enc-v2']);
    const context = { reportId, reporterUserId: actor, targetUserId: target };
    const oldEnvelope = await encryptReportDescription('old', context, 'enc-v1', rotatedProvider);
    const newEnvelope = await encryptReportDescription('new', context, 'enc-v2', rotatedProvider);
    expect(await decryptReportDescription(oldEnvelope, context, rotatedProvider)).toBe('old');
    expect(await decryptReportDescription(newEnvelope, context, rotatedProvider)).toBe('new');
    const currentOnly = await FixtureReportKeyProvider.create(['enc-v2']);
    await expect(decryptReportDescription(oldEnvelope, context, currentOnly)).rejects.toBeInstanceOf(ReportCryptoError);
  });
});

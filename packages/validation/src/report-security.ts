const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const REPORT_CATEGORIES = [
  'harassment',
  'spam',
  'impersonation',
  'inappropriate_content',
  'fraud',
  'other',
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
export type ReportTargetType = 'user';

export const REPORT_CATEGORY_VERSION = 'category-v1';
export const REPORT_FINGERPRINT_VERSION = 'hmac-sha256-v1';
export const REPORT_ENCRYPTION_ALGORITHM_VERSION = 'aes-256-gcm-v1';
export const REPORT_AAD_VERSION = 'aad-v1';
export const REPORT_MAX_BODY_BYTES = 8192;
export const REPORT_MAX_DESCRIPTION_CODE_POINTS = 500;

export type ReportPayload = {
  targetType: ReportTargetType;
  targetUserId: string;
  category: ReportCategory;
  description?: string;
};

export type ValidatedReportPayload = {
  targetType: ReportTargetType;
  targetUserId: string;
  category: ReportCategory;
  description?: string;
  /** Original user text is retained only for immediate encryption; never log or persist it as plaintext. */
  rawDescription?: string;
};

export type ReportPayloadErrorCode =
  | 'body_too_large'
  | 'invalid_json'
  | 'object_required'
  | 'unknown_field'
  | 'invalid_target_type'
  | 'invalid_target_user_id'
  | 'invalid_category'
  | 'invalid_description'
  | 'empty_description'
  | 'control_character'
  | 'description_too_long';

export type ReportPayloadValidation =
  | { ok: true; value: ValidatedReportPayload }
  | { ok: false; errors: readonly { code: ReportPayloadErrorCode; field?: string }[] };

export type IdempotencyKeyValidation =
  | { ok: true; normalized: string }
  | { ok: false; code: 'invalid_idempotency_key' };

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function normalizeUuid(value: string): string {
  return value.toLowerCase();
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isReportCategory(value: unknown): value is ReportCategory {
  return typeof value === 'string' && (REPORT_CATEGORIES as readonly string[]).includes(value);
}

function hasForbiddenControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if ((codePoint >= 0 && codePoint <= 8) || (codePoint >= 11 && codePoint <= 12) ||
        (codePoint >= 14 && codePoint <= 31) || (codePoint >= 127 && codePoint <= 159)) return true;
  }
  return false;
}

/** Fixed order: NFKC, CRLF/CR to LF, trim, control check, then count. */
export function normalizeReportDescription(value: string): string {
  return value.normalize('NFKC').replace(/\r\n?/gu, '\n').trim();
}

function validationFailure(...errors: { code: ReportPayloadErrorCode; field?: string }[]): ReportPayloadValidation {
  return { ok: false, errors };
}

export function validateReportPayload(payload: unknown, bodyBytes?: number): ReportPayloadValidation {
  if (bodyBytes !== undefined && (!Number.isInteger(bodyBytes) || bodyBytes < 0 || bodyBytes > REPORT_MAX_BODY_BYTES)) {
    return validationFailure({ code: 'body_too_large' });
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return validationFailure({ code: 'object_required' });
  }

  const input = payload as Record<string, unknown>;
  const allowedFields = new Set(['targetType', 'targetUserId', 'category', 'description']);
  const unknownField = Object.keys(input).find((field) => !allowedFields.has(field));
  if (unknownField) return validationFailure({ code: 'unknown_field', field: unknownField });
  if (input.targetType !== 'user') return validationFailure({ code: 'invalid_target_type', field: 'targetType' });
  if (!isUuid(input.targetUserId)) return validationFailure({ code: 'invalid_target_user_id', field: 'targetUserId' });
  if (!isReportCategory(input.category)) return validationFailure({ code: 'invalid_category', field: 'category' });

  let description: string | undefined;
  let rawDescription: string | undefined;
  if (Object.prototype.hasOwnProperty.call(input, 'description')) {
    if (typeof input.description !== 'string') return validationFailure({ code: 'invalid_description', field: 'description' });
    rawDescription = input.description;
    description = normalizeReportDescription(input.description);
    if (description.length === 0) return validationFailure({ code: 'empty_description', field: 'description' });
    if (hasForbiddenControlCharacter(description)) return validationFailure({ code: 'control_character', field: 'description' });
    if (Array.from(description).length > REPORT_MAX_DESCRIPTION_CODE_POINTS) {
      return validationFailure({ code: 'description_too_long', field: 'description' });
    }
  }

  return {
    ok: true,
    value: {
      targetType: 'user',
      targetUserId: normalizeUuid(input.targetUserId as string),
      category: input.category as ReportCategory,
      ...(description === undefined ? {} : { description, rawDescription }),
    },
  };
}

export function parseAndValidateReportPayload(body: string | Uint8Array): ReportPayloadValidation {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body);
  if (bytes.byteLength > REPORT_MAX_BODY_BYTES) return validationFailure({ code: 'body_too_large' });
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return validationFailure({ code: 'invalid_json' });
  }
  try {
    return validateReportPayload(JSON.parse(text) as unknown, bytes.byteLength);
  } catch {
    return validationFailure({ code: 'invalid_json' });
  }
}

export function validateIdempotencyKey(value: unknown): IdempotencyKeyValidation {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) return { ok: false, code: 'invalid_idempotency_key' };
  return { ok: true, normalized: normalizeUuid(value) };
}

export function canonicalizeReportPayload(payload: ValidatedReportPayload): string {
  return JSON.stringify([
    REPORT_CATEGORY_VERSION,
    payload.targetType,
    normalizeUuid(payload.targetUserId),
    payload.category,
    payload.description ?? null,
  ]);
}

export interface ReportKeyProvider {
  getEncryptionKey(version: string): Promise<CryptoKey>;
  getFingerprintKey(version: string): Promise<CryptoKey>;
}

export type ReportFingerprint = {
  scheme: typeof REPORT_FINGERPRINT_VERSION;
  keyVersion: string;
  reporterScope: string;
  payloadFingerprint: string;
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('invalid encoded value');
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmac(key: CryptoKey, value: string): Promise<string> {
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function createReportFingerprint(input: {
  reporterUserId: string;
  idempotencyKey: string;
  payload: ValidatedReportPayload;
  keyVersion: string;
}, provider: ReportKeyProvider): Promise<ReportFingerprint> {
  if (!isUuid(input.reporterUserId)) throw new Error('invalid reporter identity');
  const keyValidation = validateIdempotencyKey(input.idempotencyKey);
  if (!keyValidation.ok) throw new Error('invalid idempotency key');
  if (!input.keyVersion || input.keyVersion.length > 64) throw new Error('invalid fingerprint key version');
  const key = await provider.getFingerprintKey(input.keyVersion);
  const reporter = normalizeUuid(input.reporterUserId);
  return {
    scheme: REPORT_FINGERPRINT_VERSION,
    keyVersion: input.keyVersion,
    reporterScope: await hmac(key, `scope-v1\u0000${reporter}\u0000${keyValidation.normalized}`),
    payloadFingerprint: await hmac(key, `payload-v1\u0000${canonicalizeReportPayload(input.payload)}`),
  };
}

export function fingerprintsEqual(left: ReportFingerprint, right: ReportFingerprint): boolean {
  const leftBytes = new TextEncoder().encode(JSON.stringify(left));
  const rightBytes = new TextEncoder().encode(JSON.stringify(right));
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) difference |= (leftBytes[index % (leftBytes.length || 1)] ?? 0) ^ (rightBytes[index % (rightBytes.length || 1)] ?? 0);
  return difference === 0;
}

export type EncryptedReportDescription = {
  algorithm: 'AES-256-GCM';
  algorithmVersion: typeof REPORT_ENCRYPTION_ALGORITHM_VERSION;
  aadVersion: typeof REPORT_AAD_VERSION;
  keyVersion: string;
  nonce: string;
  ciphertext: string;
};

export type ReportEncryptionContext = {
  reportId: string;
  reporterUserId: string;
  targetUserId: string;
};

export class ReportCryptoError extends Error {
  constructor() {
    super('report cryptographic operation failed');
    this.name = 'ReportCryptoError';
  }
}

function assertEncryptionContext(context: ReportEncryptionContext): void {
  if (!isUuid(context.reportId) || !isUuid(context.reporterUserId) || !isUuid(context.targetUserId)) throw new ReportCryptoError();
}

function associatedData(context: ReportEncryptionContext): Uint8Array {
  return new TextEncoder().encode(
    `${REPORT_AAD_VERSION}\u0000${REPORT_ENCRYPTION_ALGORITHM_VERSION}\u0000${normalizeUuid(context.reportId)}\u0000${normalizeUuid(context.reporterUserId)}\u0000${normalizeUuid(context.targetUserId)}`,
  );
}

function assertAes256Key(key: CryptoKey): void {
  const algorithm = key.algorithm as { name?: string; length?: number };
  if (algorithm.name !== 'AES-GCM' || algorithm.length !== 256) throw new ReportCryptoError();
}

export async function encryptReportDescription(
  description: string,
  context: ReportEncryptionContext,
  keyVersion: string,
  provider: ReportKeyProvider,
): Promise<EncryptedReportDescription> {
  try {
    assertEncryptionContext(context);
    if (!keyVersion || keyVersion.length > 64) throw new ReportCryptoError();
    const key = await provider.getEncryptionKey(keyVersion);
    assertAes256Key(key);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce as unknown as BufferSource, additionalData: associatedData(context) as unknown as BufferSource, tagLength: 128 },
      key,
      new TextEncoder().encode(description),
    );
    return {
      algorithm: 'AES-256-GCM',
      algorithmVersion: REPORT_ENCRYPTION_ALGORITHM_VERSION,
      aadVersion: REPORT_AAD_VERSION,
      keyVersion,
      nonce: bytesToBase64Url(nonce),
      ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
    };
  } catch (error) {
    if (error instanceof ReportCryptoError) throw error;
    throw new ReportCryptoError();
  }
}

export async function decryptReportDescription(
  envelope: EncryptedReportDescription,
  context: ReportEncryptionContext,
  provider: ReportKeyProvider,
): Promise<string> {
  try {
    assertEncryptionContext(context);
    if (envelope.algorithm !== 'AES-256-GCM' || envelope.algorithmVersion !== REPORT_ENCRYPTION_ALGORITHM_VERSION || envelope.aadVersion !== REPORT_AAD_VERSION) throw new ReportCryptoError();
    const nonce = base64UrlToBytes(envelope.nonce);
    if (nonce.byteLength !== 12) throw new ReportCryptoError();
    const key = await provider.getEncryptionKey(envelope.keyVersion);
    assertAes256Key(key);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce as unknown as BufferSource, additionalData: associatedData(context) as unknown as BufferSource, tagLength: 128 },
      key,
      base64UrlToBytes(envelope.ciphertext) as unknown as BufferSource,
    );
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  } catch (error) {
    if (error instanceof ReportCryptoError) throw error;
    throw new ReportCryptoError();
  }
}

/** In-memory random fixture keys only; never a production secret source. */
export class FixtureReportKeyProvider implements ReportKeyProvider {
  private constructor(
    private readonly encryptionKeys: ReadonlyMap<string, CryptoKey>,
    private readonly fingerprintKeys: ReadonlyMap<string, CryptoKey>,
  ) {}

  static async create(versions: readonly string[] = ['fixture-v1']): Promise<FixtureReportKeyProvider> {
    const encryption = new Map<string, CryptoKey>();
    const fingerprints = new Map<string, CryptoKey>();
    for (const version of versions) {
      const encryptionKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const fingerprintKey = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
      encryption.set(version, encryptionKey as CryptoKey);
      fingerprints.set(version, fingerprintKey as CryptoKey);
    }
    return new FixtureReportKeyProvider(encryption, fingerprints);
  }

  async getEncryptionKey(version: string): Promise<CryptoKey> {
    const key = this.encryptionKeys.get(version);
    if (!key) throw new ReportCryptoError();
    return key;
  }

  async getFingerprintKey(version: string): Promise<CryptoKey> {
    const key = this.fingerprintKeys.get(version);
    if (!key) throw new ReportCryptoError();
    return key;
  }
}

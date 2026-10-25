import type { TrustedPostgresExecutor } from './postgres-stores.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type VerifiedReportActor = {
  userId: string;
  authSubject: string;
  authLevel: number;
  accountStatus: string;
};

const preparedReportPayloadBrand: unique symbol = Symbol('prepared-report-payload');
export type PreparedReportPayload = {
  targetType: 'user';
  targetUserId: string;
  category: string;
  categoryVersion: string;
  description: string | null;
  /** Used only by the injected crypto adapter and never sent to SQL. */
  rawDescription: string | null;
  readonly [preparedReportPayloadBrand]: true;
};

/** Creates the only payload shape accepted by ReportRepository. */
export function prepareReportPayload(input: {
  targetType: 'user';
  targetUserId: string;
  category: string;
  categoryVersion: string;
  normalizedDescription: string | null;
  originalDescription: string | null;
}): PreparedReportPayload | null {
  const normalized = input.normalizedDescription;
  const original = input.originalDescription;
  if ((normalized === null) !== (original === null)) return null;
  if (original !== null && original.normalize('NFKC').replace(/\r\n?/gu, '\n').trim() !== normalized) return null;
  return {
    targetType: input.targetType,
    targetUserId: input.targetUserId,
    category: input.category,
    categoryVersion: input.categoryVersion,
    description: normalized,
    rawDescription: original,
    [preparedReportPayloadBrand]: true,
  };
}

export type ReportFingerprintCandidate = {
  scopeHex: string;
  payloadHex: string;
  keyVersion: string;
  algorithmVersion: string;
};

export type ReportEnvelope = {
  ciphertextHex: string;
  nonceHex: string;
  algorithmVersion: string;
  encryptionKeyVersion: string;
  aadVersion: string;
} | null;

const HEX = /^[0-9a-f]+$/u;
const FINGERPRINT_ALGORITHM = 'hmac-sha256-v1';
const ENCRYPTION_ALGORITHM = 'aes-256-gcm-v1';
const AAD_VERSION = 'aad-v1';
const REPORT_CATEGORIES = new Set(['harassment', 'spam', 'impersonation', 'inappropriate_content', 'fraud', 'other']);

function validEnvelope(envelope: ReportEnvelope): boolean {
  if (envelope === null) return true;
  return envelope.algorithmVersion === ENCRYPTION_ALGORITHM &&
    envelope.aadVersion === AAD_VERSION &&
    typeof envelope.encryptionKeyVersion === 'string' &&
    envelope.encryptionKeyVersion.length > 0 && envelope.encryptionKeyVersion.length <= 80 &&
    typeof envelope.nonceHex === 'string' && envelope.nonceHex.length === 24 && HEX.test(envelope.nonceHex) &&
    typeof envelope.ciphertextHex === 'string' && envelope.ciphertextHex.length >= 32 && envelope.ciphertextHex.length % 2 === 0 && HEX.test(envelope.ciphertextHex);
}

export function validDescriptionEnvelope(rawDescription: string | null, envelope: ReportEnvelope): boolean {
  return rawDescription === null ? envelope === null : envelope !== null && validEnvelope(envelope);
}

function validCandidates(candidates: readonly ReportFingerprintCandidate[]): boolean {
  if (candidates.length === 0) return false;
  const versions = new Set<string>();
  return candidates.every((candidate) => {
    if (candidate.algorithmVersion !== FINGERPRINT_ALGORITHM || versions.has(candidate.keyVersion)) return false;
    versions.add(candidate.keyVersion);
    return candidate.keyVersion.length > 0 && candidate.keyVersion.length <= 80 &&
      /^[0-9a-f]{64}$/u.test(candidate.scopeHex) && /^[0-9a-f]{64}$/u.test(candidate.payloadHex);
  });
}

export interface ReportCryptoAdapter {
  fingerprintVersions: readonly string[];
  activeFingerprintVersion: string;
  encryptionKeyVersion: string;
  createFingerprint(input: { actorUserId: string; idempotencyKey: string; payload: PreparedReportPayload; keyVersion: string }): Promise<ReportFingerprintCandidate>;
  encryptDescription(input: { description: string; reportId: string; actorUserId: string; targetUserId: string; keyVersion: string }): Promise<ReportEnvelope>;
}

export type ReportRepositoryResult =
  | { result: 'accepted'; reportId: string }
  | { result: 'replayed'; reportId: string | null }
  | { result: 'duplicate'; reportId: string | null }
  | { result: 'denied' }
  | { result: 'unavailable' }
  | { result: 'idempotency_conflict' }
  | { result: 'rollback' }
  | { result: 'lock_timeout' }
  | { result: 'deadlock' }
  | { result: 'connection_failure' }
  | { result: 'db_unavailable' }
  | { result: 'unknown_commit' };

export type ReportRepositoryInput = PreparedReportPayload & {
  idempotencyKey: string;
  requestId: string;
};

type AtomicResultRow = { result: ReportRepositoryResult['result']; report_id: string | null };

const atomicSql = `
  SELECT * FROM report_create_atomic_v2(
    $1::uuid, $2::varchar, $3::varchar, $4::varchar, $5::uuid,
    $6::jsonb, $7::text, $8::text, $9::text, $10::text, $11::text, $12::text, $13::text
  )
`;

export class ReportRepository {
  constructor(
    private readonly executor: TrustedPostgresExecutor,
    private readonly crypto: ReportCryptoAdapter,
  ) {}

  async prepareReconciliationEvidence(actorUserId: string, input: ReportRepositoryInput): Promise<{ requestId: string; candidates: Array<{ keyVersion: string; scopeHex: string; payloadHex: string }> } | null> {
    if (!UUID.test(actorUserId) || !UUID_V4.test(input.idempotencyKey) || !input.requestId || input.requestId.length > 128) return null;
    try {
      const candidates = await Promise.all(this.crypto.fingerprintVersions.map((keyVersion) => this.crypto.createFingerprint({ actorUserId: actorUserId.toLowerCase(), idempotencyKey: input.idempotencyKey, payload: input, keyVersion })));
      if (!validCandidates(candidates)) return null;
      return { requestId: input.requestId, candidates: candidates.map(({ keyVersion, scopeHex, payloadHex }) => ({ keyVersion, scopeHex, payloadHex })) };
    } catch {
      return null;
    }
  }

  async createReport(actor: VerifiedReportActor, input: ReportRepositoryInput): Promise<ReportRepositoryResult> {
    const actorUserId = actor.userId.toLowerCase();
    const targetUserId = input.targetUserId.toLowerCase();
    if (!UUID.test(actorUserId) || !UUID.test(targetUserId) || !actor.authSubject ||
      !UUID_V4.test(input.idempotencyKey) || !input.requestId || input.requestId.length > 128 ||
      input.targetType !== 'user' || !REPORT_CATEGORIES.has(input.category) || input.categoryVersion !== 'category-v1') return { result: 'unavailable' };
    if (input.rawDescription === null && input.description !== null) return { result: 'unavailable' };
    if (input.rawDescription !== null && (input.description === null || input.rawDescription.normalize('NFKC').replace(/\r\n?/gu, '\n').trim() !== input.description)) return { result: 'unavailable' };
    if (!this.executor.withReportWriter) return { result: 'unavailable' };

    const reportId = crypto.randomUUID();
    let candidates: ReportFingerprintCandidate[];
    let envelope: ReportEnvelope;
    try {
      candidates = await Promise.all(this.crypto.fingerprintVersions.map((keyVersion) => this.crypto.createFingerprint({
        actorUserId,
        idempotencyKey: input.idempotencyKey,
        payload: { ...input, targetUserId },
        keyVersion,
      })));
      envelope = input.rawDescription === null
        ? null
        : await this.crypto.encryptDescription({
          description: input.rawDescription,
          reportId,
          actorUserId,
          targetUserId,
          keyVersion: this.crypto.encryptionKeyVersion,
        });
      if (!validCandidates(candidates) || !validDescriptionEnvelope(input.rawDescription, envelope) ||
        !candidates.some((candidate) => candidate.keyVersion === this.crypto.activeFingerprintVersion)) return { result: 'unavailable' };
      candidates = [
        ...candidates.filter((candidate) => candidate.keyVersion === this.crypto.activeFingerprintVersion),
        ...candidates.filter((candidate) => candidate.keyVersion !== this.crypto.activeFingerprintVersion),
      ];
    } catch {
      return { result: 'unavailable' };
    }

    try {
      return await this.executor.withReportWriter(actorUserId, targetUserId, async (query) => {
        const response = await query.query<AtomicResultRow>(atomicSql, [
          targetUserId,
          input.category,
          input.categoryVersion,
          input.requestId,
          reportId,
          JSON.stringify(candidates.map((candidate) => ({
            scope_hex: candidate.scopeHex,
            payload_hex: candidate.payloadHex,
            key_version: candidate.keyVersion,
            algorithm_version: candidate.algorithmVersion,
          }))),
          envelope?.ciphertextHex ?? null,
          envelope?.nonceHex ?? null,
          envelope?.algorithmVersion ?? null,
          envelope?.encryptionKeyVersion ?? null,
          envelope?.aadVersion ?? null,
          this.crypto.activeFingerprintVersion,
          'hmac-sha256-v1',
        ]);
        const row = response.rows[0];
        if (!row || !['accepted', 'replayed', 'duplicate', 'denied', 'idempotency_conflict'].includes(row.result)) return { result: 'unavailable' };
        return row.result === 'accepted'
          ? { result: 'accepted', reportId: row.report_id ?? reportId }
          : { result: row.result, reportId: row.report_id ?? null } as ReportRepositoryResult;
      }, actor.authSubject);
    } catch (error) {
      if (error instanceof UnknownCommitError) return { result: 'unknown_commit' };
      if (error instanceof TransactionRollbackError) {
        const code = databaseErrorCode(error.cause);
        if (code === '40P01') return { result: 'deadlock' };
        if (code === '55P03' || code === '57014') return { result: 'lock_timeout' };
        if (code === '57P01') return { result: 'db_unavailable' };
        if (code?.startsWith('08')) return { result: 'connection_failure' };
        return { result: 'rollback' };
      }
      const code = databaseErrorCode(error);
      if (code === '40P01') return { result: 'deadlock' };
      if (code === '55P03' || code === '57014') return { result: 'lock_timeout' };
      if (code === '57P01') return { result: 'db_unavailable' };
      if (code?.startsWith('08')) return { result: 'connection_failure' };
      return { result: 'unavailable' };
    }
  }
}

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Executor adapters must use this only when COMMIT outcome is not knowable. */
export class UnknownCommitError extends Error {
  constructor() {
    super('database commit outcome is unknown');
    this.name = 'UnknownCommitError';
  }
}

/** Operation failed before COMMIT and the transaction was rolled back. */
export class TransactionRollbackError extends Error {
  constructor(public readonly cause: unknown) {
    super('database transaction rolled back');
    this.name = 'TransactionRollbackError';
  }
}

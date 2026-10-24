import type { TrustedPostgresExecutor } from './postgres-stores.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type VerifiedReportActor = {
  userId: string;
  authLevel: number;
  accountStatus: string;
};

export type PreparedReportPayload = {
  targetType: 'user';
  targetUserId: string;
  category: string;
  categoryVersion: string;
  description?: string;
  /** Used only by the injected crypto adapter and never sent to SQL. */
  rawDescription?: string;
};

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

export interface ReportCryptoAdapter {
  fingerprintVersions: readonly string[];
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
  | { result: 'unknown_commit' };

export type ReportRepositoryInput = PreparedReportPayload & {
  idempotencyKey: string;
  requestId: string;
};

type AtomicResultRow = { result: ReportRepositoryResult['result']; report_id: string | null };

const atomicSql = `
  SELECT * FROM report_create_atomic_v2(
    $1::uuid, $2::varchar, $3::varchar, $4::varchar, $5::uuid,
    $6::jsonb, $7::text, $8::text, $9::text, $10::text, $11::text, $12::text
  )
`;

export class ReportRepository {
  constructor(
    private readonly executor: TrustedPostgresExecutor,
    private readonly crypto: ReportCryptoAdapter,
  ) {}

  async createReport(actor: VerifiedReportActor, input: ReportRepositoryInput): Promise<ReportRepositoryResult> {
    const actorUserId = actor.userId.toLowerCase();
    const targetUserId = input.targetUserId.toLowerCase();
    if (!UUID.test(actorUserId) || !UUID.test(targetUserId) || !UUID_V4.test(input.idempotencyKey) || !input.requestId || input.requestId.length > 128) return { result: 'unavailable' };
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
      envelope = input.rawDescription === undefined
        ? null
        : await this.crypto.encryptDescription({
          description: input.rawDescription,
          reportId,
          actorUserId,
          targetUserId,
          keyVersion: this.crypto.encryptionKeyVersion,
        });
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
          'hmac-sha256-v1',
        ]);
        const row = response.rows[0];
        if (!row || !['accepted', 'replayed', 'duplicate', 'denied', 'idempotency_conflict'].includes(row.result)) return { result: 'unavailable' };
        return row.result === 'accepted'
          ? { result: 'accepted', reportId: row.report_id ?? reportId }
          : { result: row.result, reportId: row.report_id ?? null } as ReportRepositoryResult;
      });
    } catch (error) {
      if (error instanceof UnknownCommitError) return { result: 'unknown_commit' };
      return { result: 'unavailable' };
    }
  }
}

/** Executor adapters must use this only when COMMIT outcome is not knowable. */
export class UnknownCommitError extends Error {
  constructor() {
    super('database commit outcome is unknown');
    this.name = 'UnknownCommitError';
  }
}

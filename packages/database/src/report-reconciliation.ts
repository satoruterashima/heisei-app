import type { TrustedPostgresExecutor } from './postgres-stores.js';

export type ReconciliationCandidate = { keyVersion: string; scopeHex: string; payloadHex: string };
export type ReadOnlyReportLookupResult =
  | { result: 'stored'; candidate: ReconciliationCandidate }
  | { result: 'not_found' }
  | { result: 'unavailable' };

export interface ReportIdempotencyReadOnlyLookup {
  lookup(input: { actorUserId: string; candidates: readonly ReconciliationCandidate[] }): Promise<ReadOnlyReportLookupResult>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST = /^[0-9a-f]{64}$/u;

/**
 * Queries only actor-scoped idempotency evidence through the dedicated
 * read-only role. A miss is intentionally returned as not_found, never as
 * proof that the report was not stored.
 */
export class PostgresReportIdempotencyReadOnlyLookup implements ReportIdempotencyReadOnlyLookup {
  constructor(private readonly executor: TrustedPostgresExecutor) {}

  async lookup(input: { actorUserId: string; candidates: readonly ReconciliationCandidate[] }): Promise<ReadOnlyReportLookupResult> {
    const actorUserId = input.actorUserId.toLowerCase();
    if (!this.executor.withReportReconciler || !UUID.test(actorUserId) || input.candidates.length === 0 || input.candidates.some((candidate) =>
      candidate.keyVersion.length === 0 || candidate.keyVersion.length > 80 || !DIGEST.test(candidate.scopeHex) || !DIGEST.test(candidate.payloadHex))) {
      return { result: 'unavailable' };
    }
    try {
      return await this.executor.withReportReconciler(actorUserId, async (query) => {
        const response = await query.query<{ key_version: string; scope_hex: string; payload_hex: string }>(`
          SELECT ri.fingerprint_key_version AS key_version,
                 encode(ri.reporter_scope_digest, 'hex') AS scope_hex,
                 encode(ri.payload_fingerprint, 'hex') AS payload_hex
            FROM report_idempotency AS ri
            JOIN jsonb_to_recordset($2::jsonb)
              AS candidate(scope_hex text, payload_hex text, key_version text)
              ON candidate.key_version = ri.fingerprint_key_version
             AND decode(candidate.scope_hex, 'hex') = ri.reporter_scope_digest
             AND decode(candidate.payload_hex, 'hex') = ri.payload_fingerprint
           WHERE ri.reporter_user_id = $1::uuid
           LIMIT 1
        `, [actorUserId, JSON.stringify(input.candidates.map((candidate) => ({
          key_version: candidate.keyVersion,
          scope_hex: candidate.scopeHex,
          payload_hex: candidate.payloadHex,
        })))]);
        const row = response.rows[0];
        return row ? { result: 'stored', candidate: { keyVersion: row.key_version, scopeHex: row.scope_hex, payloadHex: row.payload_hex } } : { result: 'not_found' };
      });
    } catch {
      return { result: 'unavailable' };
    }
  }
}

import type { QuotaReservationId, ReconciliationObservation, VerifiedQuotaActor } from './quota.js';
import type { CoordinatorResult, QuotaCoordinator } from './quota.js';

/** A digest tuple produced by the trusted G4 crypto boundary. Raw keys and text never enter this API. */
export type ReconciliationCandidate = {
  keyVersion: string;
  scopeHex: string;
  payloadHex: string;
};

export type ReconciliationLookupResult =
  | { result: 'stored'; candidate: ReconciliationCandidate }
  | { result: 'not_stored_proven' }
  | { result: 'not_found' }
  | { result: 'unavailable' }
  | { result: 'key_missing' };

export interface ReadOnlyReportLookup {
  /** The implementation must use an actor-bound, read-only G4 connection. */
  lookup(input: { actorUserId: string; candidates: readonly ReconciliationCandidate[] }): Promise<ReconciliationLookupResult>;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST = /^[0-9a-f]{64}$/u;

function validCandidate(candidate: ReconciliationCandidate): boolean {
  return candidate.keyVersion.length > 0 && candidate.keyVersion.length <= 80 &&
    DIGEST.test(candidate.scopeHex) && DIGEST.test(candidate.payloadHex);
}

function sameCandidate(left: ReconciliationCandidate, right: ReconciliationCandidate): boolean {
  return left.keyVersion === right.keyVersion &&
    left.scopeHex.toLowerCase() === right.scopeHex.toLowerCase() &&
    left.payloadHex.toLowerCase() === right.payloadHex.toLowerCase();
}

/**
 * Converts only trusted, evidence-backed lookup results into quota observations.
 * A database miss is deliberately not equivalent to `not_stored`.
 */
export class ReportReadOnlyReconciler {
  constructor(private readonly lookup: ReadOnlyReportLookup) {}

  async reconcile(actor: VerifiedQuotaActor, candidates: readonly ReconciliationCandidate[]): Promise<ReconciliationObservation> {
    const actorUserId = actor.userId.toLowerCase();
    if (!UUID_V4.test(actorUserId) || candidates.length === 0 || candidates.some((candidate) => !validCandidate(candidate))) return 'unknown';
    const distinct = new Set(candidates.map((candidate) => `${candidate.keyVersion}\u0000${candidate.scopeHex.toLowerCase()}\u0000${candidate.payloadHex.toLowerCase()}`));
    if (distinct.size !== candidates.length) return 'unknown';
    try {
      const result = await this.lookup.lookup({ actorUserId, candidates });
      if (result.result === 'stored') return candidates.some((candidate) => sameCandidate(candidate, result.candidate)) ? 'stored' : 'unknown';
      if (result.result === 'not_stored_proven') return 'not_stored';
      if (result.result === 'key_missing') return 'key_missing';
      if (result.result === 'unavailable') return 'unavailable';
      return 'unknown';
    } catch {
      return 'unavailable';
    }
  }
}

/** Bridges the read-only G4 result to the actor-serialized quota state transition. */
export class QuotaReconciliationCoordinator {
  constructor(private readonly coordinator: QuotaCoordinator, private readonly reconciler: ReportReadOnlyReconciler) {}

  async reconcile(
    actor: VerifiedQuotaActor,
    reservationId: QuotaReservationId,
    candidates: readonly ReconciliationCandidate[],
  ): Promise<CoordinatorResult<'committed' | 'cancelled' | 'uncertain' | 'replayed'>> {
    const observation = await this.reconciler.reconcile(actor, candidates);
    return this.coordinator.reconcile(actor, reservationId, observation);
  }
}

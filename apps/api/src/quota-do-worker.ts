import { DurableObject } from 'cloudflare:workers';
import {
  DurableObjectQuotaStore,
  QuotaCoordinator,
  QuotaEngine,
  type QuotaConfig,
  type VerifiedQuotaActor,
} from '@heisei/domain';

export interface QuotaDoEnv {
  QUOTA_ACTOR: DurableObjectNamespace<QuotaActor>;
}

const FIXTURE_CONFIG: QuotaConfig = {
  shortWindowMs: 100,
  shortRequestLimit: 2,
  longWindowMs: 1_000,
  longRequestLimit: 4,
  admissionWindowMs: 1_000,
  newAdmissionLimit: 4,
  reservationTtlMs: 50,
  maxActiveReservations: 3,
  stateRetentionMs: 200,
};
const STORAGE_OPTIONS = { maxStoredReservations: 4 };

/** Local-runtime-only actor. It has no public fetch route for quota operations. */
export class QuotaActor extends DurableObject<QuotaDoEnv> {
  private coordinator(actor: VerifiedQuotaActor): QuotaCoordinator {
    const store = new DurableObjectQuotaStore(
      actor,
      this.ctx.storage,
      // The DO input gate serializes each RPC turn for this actor instance.
      { run: async <T>(operation: () => Promise<T>): Promise<T> => operation() },
      STORAGE_OPTIONS,
    );
    return new QuotaCoordinator(new QuotaEngine(FIXTURE_CONFIG), store, { now: () => Date.now() });
  }

  async recordRequest(actor: VerifiedQuotaActor) {
    return this.coordinator(actor).recordRequest(actor);
  }

  async reserveAdmission(actor: VerifiedQuotaActor, reservationId: Parameters<QuotaCoordinator['reserveAdmission']>[1]) {
    return this.coordinator(actor).reserveAdmission(actor, reservationId);
  }

  async beginSave(actor: VerifiedQuotaActor, reservationId: Parameters<QuotaCoordinator['beginSave']>[1]) {
    return this.coordinator(actor).beginSave(actor, reservationId);
  }

  async finalize(actor: VerifiedQuotaActor, reservationId: Parameters<QuotaCoordinator['finalize']>[1], outcome: Parameters<QuotaCoordinator['finalize']>[2]) {
    return this.coordinator(actor).finalize(actor, reservationId, outcome);
  }

  async expire(actor: VerifiedQuotaActor) {
    return this.coordinator(actor).expire(actor);
  }

  async reconcile(actor: VerifiedQuotaActor, reservationId: Parameters<QuotaCoordinator['reconcile']>[1], observation: Parameters<QuotaCoordinator['reconcile']>[2]) {
    return this.coordinator(actor).reconcile(actor, reservationId, observation);
  }
}

export default {
  fetch(): Response {
    return new Response(null, { status: 404 });
  },
};

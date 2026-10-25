import { DurableObject } from 'cloudflare:workers';
import {
  DurableObjectQuotaStore,
  QuotaCoordinator,
  QuotaEngine,
  quotaConfigFromSource,
  type VerifiedQuotaActor,
} from '@heisei/domain';

export interface QuotaDoEnv {
  QUOTA_ACTOR: DurableObjectNamespace<QuotaActor>;
  [name: string]: string | DurableObjectNamespace<QuotaActor> | undefined;
}

const MAX_STORED_RESERVATIONS = 256;

/** Local-runtime-only actor. It has no public fetch route for quota operations. */
export class QuotaActor extends DurableObject<QuotaDoEnv> {
  private coordinator(actor: VerifiedQuotaActor): QuotaCoordinator {
    const store = new DurableObjectQuotaStore(
      actor,
      this.ctx.storage,
      // The DO input gate serializes each RPC turn for this actor instance.
      { run: async <T>(operation: () => Promise<T>): Promise<T> => operation() },
      { maxStoredReservations: MAX_STORED_RESERVATIONS },
    );
    return new QuotaCoordinator(new QuotaEngine(quotaConfigFromSource(this.env as unknown as Record<string, string | undefined>)), store, { now: () => Date.now() });
  }

  async recordRequest(actor: VerifiedQuotaActor) {
    return this.coordinator(actor).recordRequest(actor);
  }

  async reserveAdmission(actor: VerifiedQuotaActor, reservationId: Parameters<QuotaCoordinator['reserveAdmission']>[1], evidence?: Parameters<QuotaCoordinator['reserveAdmission']>[2]) {
    return this.coordinator(actor).reserveAdmission(actor, reservationId, evidence);
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

  async inspect(actor: VerifiedQuotaActor, limit = 50, cursor?: string) {
    const store = new DurableObjectQuotaStore(actor, this.ctx.storage, { run: async <T>(operation: () => Promise<T>) => operation() }, { maxStoredReservations: MAX_STORED_RESERVATIONS });
    return store.inspect(actor.userId, limit, cursor);
  }
}

export default {
  fetch(): Response {
    return new Response(null, { status: 404 });
  },
};

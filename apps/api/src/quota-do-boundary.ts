import type { ReportQuotaBoundary } from './index.js';
import type { QuotaCoordinator, ReportOutcome, VerifiedQuotaActor } from '@heisei/domain';

type QuotaActorRpc = {
  recordRequest(actor: VerifiedQuotaActor): ReturnType<QuotaCoordinator['recordRequest']>;
  reserveAdmission(actor: VerifiedQuotaActor, reservationId: Parameters<QuotaCoordinator['reserveAdmission']>[1]): ReturnType<QuotaCoordinator['reserveAdmission']>;
  beginSave(actor: VerifiedQuotaActor, reservationId: Parameters<QuotaCoordinator['beginSave']>[1]): ReturnType<QuotaCoordinator['beginSave']>;
  finalize(actor: VerifiedQuotaActor, reservationId: Parameters<QuotaCoordinator['finalize']>[1], outcome: ReportOutcome): ReturnType<QuotaCoordinator['finalize']>;
};

export type QuotaActorNamespace = {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): QuotaActorRpc;
};

/** Production-shaped adapter; the caller still supplies the approved DO binding. */
export class DurableObjectQuotaBoundary implements ReportQuotaBoundary {
  constructor(private readonly namespace: QuotaActorNamespace) {}

  private actor(user: VerifiedQuotaActor): QuotaActorRpc {
    return this.namespace.get(this.namespace.idFromName(user.userId.toLowerCase()));
  }

  recordRequest(actor: VerifiedQuotaActor) { return this.actor(actor).recordRequest(actor); }
  reserveAdmission(actor: VerifiedQuotaActor, reservationId: Parameters<QuotaCoordinator['reserveAdmission']>[1]) { return this.actor(actor).reserveAdmission(actor, reservationId); }
  beginSave(actor: VerifiedQuotaActor, reservationId: Parameters<QuotaCoordinator['beginSave']>[1]) { return this.actor(actor).beginSave(actor, reservationId); }
  finalize(actor: VerifiedQuotaActor, reservationId: Parameters<QuotaCoordinator['finalize']>[1], outcome: ReportOutcome) { return this.actor(actor).finalize(actor, reservationId, outcome); }
}

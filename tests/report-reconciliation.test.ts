import { describe, expect, it, vi } from 'vitest';
import {
  QuotaCoordinator,
  QuotaEngine,
  QuotaReconciliationCoordinator,
  ReportReadOnlyReconciler,
  InMemoryFixtureStore,
  fixtureQuotaActor,
  fixtureReservationId,
  type ReadOnlyReportLookup,
  type ReconciliationCandidate,
} from '../packages/domain/src/index.js';

const actor = fixtureQuotaActor('00000000-0000-4000-8000-000000000001');
const reservation = fixtureReservationId('00000000-0000-4000-8000-000000000101');
const candidate: ReconciliationCandidate = { keyVersion: 'hmac-v1', scopeHex: 'a'.repeat(64), payloadHex: 'b'.repeat(64) };
const config = { shortWindowMs: 100, shortRequestLimit: 2, longWindowMs: 1000, longRequestLimit: 4, admissionWindowMs: 1000, newAdmissionLimit: 2, reservationTtlMs: 50, maxActiveReservations: 2, stateRetentionMs: 200 } as const;

function lookup(result: Awaited<ReturnType<ReadOnlyReportLookup['lookup']>>): ReadOnlyReportLookup {
  return { lookup: vi.fn().mockResolvedValue(result) };
}

describe('read-only report reconciliation boundary', () => {
  it('accepts stored evidence only when the complete candidate tuple matches', async () => {
    expect(await new ReportReadOnlyReconciler(lookup({ result: 'stored', candidate })).reconcile(actor, [candidate])).toBe('stored');
    expect(await new ReportReadOnlyReconciler(lookup({ result: 'stored', candidate: { ...candidate, payloadHex: 'c'.repeat(64) } })).reconcile(actor, [candidate])).toBe('unknown');
  });

  it('never turns an ordinary empty lookup into proof of non-storage', async () => {
    expect(await new ReportReadOnlyReconciler(lookup({ result: 'not_found' })).reconcile(actor, [candidate])).toBe('unknown');
    expect(await new ReportReadOnlyReconciler(lookup({ result: 'not_stored_proven' })).reconcile(actor, [candidate])).toBe('not_stored');
  });

  it('preserves unavailable and missing-key uncertainty and rejects malformed input', async () => {
    expect(await new ReportReadOnlyReconciler(lookup({ result: 'unavailable' })).reconcile(actor, [candidate])).toBe('unavailable');
    expect(await new ReportReadOnlyReconciler(lookup({ result: 'key_missing' })).reconcile(actor, [candidate])).toBe('key_missing');
    expect(await new ReportReadOnlyReconciler(lookup({ result: 'stored', candidate })).reconcile(actor, [{ ...candidate, scopeHex: 'bad' }])).toBe('unknown');
    expect(await new ReportReadOnlyReconciler(lookup({ result: 'stored', candidate })).reconcile(actor, [candidate, candidate])).toBe('unknown');
  });

  it('keeps an uncertain reservation occupied when reconciliation is unavailable', async () => {
    const clock = { now: () => 1000 };
    const coordinator = new QuotaCoordinator(new QuotaEngine(config), new InMemoryFixtureStore(), clock);
    expect((await coordinator.reserveAdmission(actor, reservation)).result).toBe('reserved');
    expect((await coordinator.beginSave(actor, reservation)).result).toBe('started');
    const service = new QuotaReconciliationCoordinator(coordinator, new ReportReadOnlyReconciler(lookup({ result: 'not_found' })));
    expect((await service.reconcile(actor, reservation, [candidate])).result).toBe('uncertain');
  });

  it('does not expose raw key or description to the lookup boundary', async () => {
    const spy = vi.fn().mockResolvedValue({ result: 'not_found' } as const);
    const service = new ReportReadOnlyReconciler({ lookup: spy });
    await service.reconcile(actor, [candidate]);
    expect(spy).toHaveBeenCalledWith({ actorUserId: actor.userId, candidates: [candidate] });
    expect(JSON.stringify(spy.mock.calls[0])).not.toContain('idempotency');
  });
});

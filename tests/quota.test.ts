import { describe, expect, it } from 'vitest';
import {
  fixtureQuotaActor,
  fixtureReservationId,
  InMemoryFixtureStore,
  QuotaCoordinator,
  QuotaEngine,
  type QuotaConfig,
  type QuotaState,
} from '../packages/domain/src/index.js';

const actor = fixtureQuotaActor('00000000-0000-4000-8000-000000000001');
const otherActor = fixtureQuotaActor('00000000-0000-4000-8000-000000000002');
const r1 = fixtureReservationId('00000000-0000-4000-8000-000000000101');
const r2 = fixtureReservationId('00000000-0000-4000-8000-000000000102');
const r3 = fixtureReservationId('00000000-0000-4000-8000-000000000103');

const config: QuotaConfig = {
  shortWindowMs: 100,
  shortRequestLimit: 2,
  longWindowMs: 1_000,
  longRequestLimit: 4,
  admissionWindowMs: 1_000,
  newAdmissionLimit: 2,
  reservationTtlMs: 50,
  maxActiveReservations: 2,
  stateRetentionMs: 200,
};

class FixtureClock {
  constructor(public value = 1_000) {}
  now(): number { return this.value; }
  advance(ms: number): void { this.value += ms; }
}

function unwrap<T>(value: { result: T } | { result: 'unavailable' }): T {
  if (value.result === 'unavailable') throw new Error('unexpected unavailable fixture result');
  return value.result;
}

function setup(fail?: ConstructorParameters<typeof InMemoryFixtureStore>[0]) {
  const clock = new FixtureClock();
  const store = new InMemoryFixtureStore(fail);
  const coordinator = new QuotaCoordinator(new QuotaEngine(config), store, clock);
  return { clock, store, coordinator };
}

describe('QuotaEngine and local coordinator', () => {
  it('allows requests within the short and long limits, then limits them', async () => {
    const { clock, coordinator } = setup();
    expect(unwrap(await coordinator.recordRequest(actor))).toBe('allowed');
    expect(unwrap(await coordinator.recordRequest(actor))).toBe('allowed');
    expect(unwrap(await coordinator.recordRequest(actor))).toBe('rate_limited');
    clock.advance(100);
    expect(unwrap(await coordinator.recordRequest(actor))).toBe('allowed');
    expect(unwrap(await coordinator.recordRequest(actor))).toBe('rate_limited');
    clock.advance(1_000);
    expect(unwrap(await coordinator.recordRequest(actor))).toBe('allowed');
  });

  it('reserves and commits new admission quota exactly once', async () => {
    const { coordinator, store } = setup();
    expect(unwrap(await coordinator.reserveAdmission(actor, r1))).toBe('reserved');
    expect(unwrap(await coordinator.reserveAdmission(actor, r1))).toBe('replayed');
    expect(unwrap(await coordinator.beginSave(actor, r1))).toBe('started');
    expect(unwrap(await coordinator.finalize(actor, r1, 'accepted'))).toBe('committed');
    expect(unwrap(await coordinator.finalize(actor, r1, 'accepted'))).toBe('replayed');
    expect((await store.load(actor.userId))?.confirmedAdmissionCount).toBe(1);
  });

  it('cancels denied, duplicate, and conflict reservations without consuming quota', async () => {
    const { coordinator, store } = setup();
    expect(unwrap(await coordinator.reserveAdmission(actor, r1))).toBe('reserved');
    expect(unwrap(await coordinator.finalize(actor, r1, 'duplicate'))).toBe('cancelled');
    expect(unwrap(await coordinator.finalize(actor, r1, 'duplicate'))).toBe('idempotency_conflict');
    expect((await store.load(actor.userId))?.reservedAdmissionCount).toBe(0);
    expect(unwrap(await coordinator.reserveAdmission(actor, r2))).toBe('reserved');
    expect(unwrap(await coordinator.finalize(actor, r2, 'denied'))).toBe('cancelled');
    expect(unwrap(await coordinator.reserveAdmission(actor, r3))).toBe('reserved');
    expect(unwrap(await coordinator.finalize(actor, r3, 'idempotency_conflict'))).toBe('cancelled');
  });

  it('expires a reservation and restores its admission capacity', async () => {
    const { clock, coordinator, store } = setup();
    expect(unwrap(await coordinator.reserveAdmission(actor, r1))).toBe('reserved');
    clock.advance(50);
    expect(unwrap(await coordinator.expire(actor))).toBe('expired');
    expect((await store.load(actor.userId))?.reservedAdmissionCount).toBe(0);
    expect(unwrap(await coordinator.reserveAdmission(actor, r2))).toBe('reserved');
  });

  it('keeps unknown_commit reservations uncertain and never releases them automatically', async () => {
    const { clock, coordinator, store } = setup();
    expect(unwrap(await coordinator.reserveAdmission(actor, r1))).toBe('reserved');
    expect(unwrap(await coordinator.finalize(actor, r1, 'unknown_commit'))).toBe('uncertain');
    clock.advance(1_000);
    expect(unwrap(await coordinator.expire(actor))).toBe('unchanged');
    expect(unwrap(await coordinator.reserveAdmission(actor, r1))).toBe('idempotency_conflict');
    expect((await store.load(actor.userId))?.reservations[r1]?.status).toBe('uncertain');
  });

  it('moves a reservation to in_flight before storage and never expires it into free capacity', async () => {
    const { clock, coordinator, store } = setup();
    expect(unwrap(await coordinator.reserveAdmission(actor, r1))).toBe('reserved');
    expect(unwrap(await coordinator.beginSave(actor, r1))).toBe('started');
    clock.advance(50);
    expect(unwrap(await coordinator.expire(actor))).toBe('expired');
    const state = await store.load(actor.userId);
    expect(state?.reservations[r1]?.status).toBe('uncertain');
    expect(state?.reservedAdmissionCount).toBe(0);
    expect(state?.uncertainAdmissionCount).toBe(1);
    expect(unwrap(await coordinator.reconcile(actor, r1, 'unavailable'))).toBe('uncertain');
    expect(unwrap(await coordinator.reconcile(actor, r1, 'stored'))).toBe('committed');
  });

  it('allows safe cancellation only before storage begins', async () => {
    const { coordinator, store } = setup();
    expect(unwrap(await coordinator.reserveAdmission(actor, r1))).toBe('reserved');
    expect(unwrap(await coordinator.finalize(actor, r1, 'denied'))).toBe('cancelled');
    expect((await store.load(actor.userId))?.reservations[r1]?.status).toBe('cancelled');
  });

  it('keeps in-flight failures uncertain and does not release quota', async () => {
    const { coordinator, store } = setup();
    expect(unwrap(await coordinator.reserveAdmission(actor, r1))).toBe('reserved');
    expect(unwrap(await coordinator.beginSave(actor, r1))).toBe('started');
    expect(unwrap(await coordinator.finalize(actor, r1, 'unavailable'))).toBe('uncertain');
    expect((await store.load(actor.userId))?.uncertainAdmissionCount).toBe(1);
    expect(unwrap(await coordinator.finalize(actor, r1, 'unknown_commit'))).toBe('uncertain');
  });

  it('releases an in-flight reservation when the repository definitively replays or duplicates', async () => {
    const { coordinator, store } = setup();
    expect(unwrap(await coordinator.reserveAdmission(actor, r1))).toBe('reserved');
    expect(unwrap(await coordinator.beginSave(actor, r1))).toBe('started');
    expect(unwrap(await coordinator.finalize(actor, r1, 'replayed'))).toBe('cancelled');
    expect((await store.load(actor.userId))?.uncertainAdmissionCount).toBe(0);
    expect(unwrap(await coordinator.reserveAdmission(actor, r2))).toBe('reserved');
  });

  it('keeps unresolved reservations across an admission window reset', async () => {
    const smallConfig = { ...config, admissionWindowMs: 10, newAdmissionLimit: 1 };
    const clock = new FixtureClock();
    const store = new InMemoryFixtureStore();
    const coordinator = new QuotaCoordinator(new QuotaEngine(smallConfig), store, clock);
    expect(unwrap(await coordinator.reserveAdmission(actor, r1))).toBe('reserved');
    expect(unwrap(await coordinator.beginSave(actor, r1))).toBe('started');
    clock.advance(100);
    expect(unwrap(await coordinator.expire(actor))).toBe('expired');
    expect((await store.load(actor.userId))?.uncertainAdmissionCount).toBe(1);
    expect(unwrap(await coordinator.reserveAdmission(actor, r2))).toBe('rate_limited');
  });

  it('restores and validates state versions and corruption fail-closed', async () => {
    const { coordinator, store } = setup();
    const invalid = {
      version: 999,
      actorId: actor.userId,
      shortWindowStartedAt: 1_000,
      shortRequestCount: 0,
      longWindowStartedAt: 1_000,
      longRequestCount: 0,
      admissionWindowStartedAt: 1_000,
      confirmedAdmissionCount: 0,
      reservedAdmissionCount: 0,
      uncertainAdmissionCount: 0,
      reservations: {},
      updatedAt: 1_000,
    } as unknown as QuotaState;
    await store.seed(invalid);
    expect((await coordinator.recordRequest(actor)).result).toBe('unavailable');
  });

  it('does not permit another actor to finalize an existing reservation', async () => {
    const { coordinator } = setup();
    expect(unwrap(await coordinator.reserveAdmission(actor, r1))).toBe('reserved');
    expect((await coordinator.finalize(otherActor, r1, 'accepted')).result).toBe('unavailable');
  });

  it('serializes concurrent requests and reservations for one actor', async () => {
    const { coordinator } = setup();
    const requestResults = await Promise.all(Array.from({ length: 5 }, () => coordinator.recordRequest(actor)));
    expect(requestResults.filter((value) => value.result === 'allowed')).toHaveLength(2);
    expect(requestResults.filter((value) => value.result === 'rate_limited')).toHaveLength(3);
    const reservationResults = await Promise.all([r1, r2, r3].map((id) => coordinator.reserveAdmission(actor, id)));
    expect(reservationResults.filter((value) => value.result === 'reserved')).toHaveLength(2);
    expect(reservationResults.filter((value) => value.result === 'rate_limited')).toHaveLength(1);
  });

  it('restores state through the store and prunes released tombstones after retention', async () => {
    const first = setup();
    expect(unwrap(await first.coordinator.reserveAdmission(actor, r1))).toBe('reserved');
    expect(unwrap(await first.coordinator.finalize(actor, r1, 'unavailable'))).toBe('cancelled');
    const restored = new QuotaCoordinator(new QuotaEngine(config), first.store, first.clock);
    expect(unwrap(await restored.reserveAdmission(actor, r1))).toBe('idempotency_conflict');
    first.clock.advance(200);
    expect(unwrap(await restored.expire(actor))).toBe('unchanged');
    expect((await first.store.load(actor.userId))?.reservations[r1]).toBeUndefined();
  });

  it('fails closed when the state store is unavailable', async () => {
    const loadFailure = setup({ load: true });
    expect((await loadFailure.coordinator.recordRequest(actor)).result).toBe('unavailable');
    const saveFailure = setup({ save: true });
    expect((await saveFailure.coordinator.reserveAdmission(actor, r1)).result).toBe('unavailable');
  });

  it('rejects invalid or client-shaped actor and reservation identifiers', () => {
    expect(() => fixtureQuotaActor('not-an-actor')).toThrow();
    expect(() => fixtureReservationId('client-id')).toThrow();
  });
});

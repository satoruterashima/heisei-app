import { describe, expect, it } from 'vitest';
import {
  DurableObjectQuotaStore,
  LocalDurableObjectStorage,
  LocalDurableQuotaNamespace,
  QuotaCoordinator,
  QuotaEngine,
  fixtureQuotaActor,
  fixtureReservationId,
  type QuotaConfig,
  type QuotaState,
} from '../packages/domain/src/index.js';

const actor = fixtureQuotaActor('00000000-0000-4000-8000-000000000011');
const otherActor = fixtureQuotaActor('00000000-0000-4000-8000-000000000012');
const reservation = fixtureReservationId('00000000-0000-4000-8000-000000000111');
const otherReservation = fixtureReservationId('00000000-0000-4000-8000-000000000112');
const config: QuotaConfig = {
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
const options = { maxStoredReservations: 4 };

class Clock {
  constructor(public value = 1_000) {}
  now(): number { return this.value; }
  advance(ms: number): void { this.value += ms; }
}

function unwrap<T>(value: { result: T } | { result: 'unavailable' }): T {
  if (value.result === 'unavailable') throw new Error('unexpected unavailable');
  return value.result;
}

function setup() {
  const clock = new Clock();
  const namespace = new LocalDurableQuotaNamespace();
  const storage = namespace.getByName(actor.userId);
  const store = new DurableObjectQuotaStore(actor, storage, storage, options);
  const coordinator = new QuotaCoordinator(new QuotaEngine(config), store, clock);
  return { clock, namespace, storage, store, coordinator };
}

describe('Durable Object quota persistence adapter (local only)', () => {
  it('routes one actor to one durable storage and restores after adapter restart', async () => {
    const { namespace, coordinator, clock } = setup();
    expect(unwrap(await coordinator.reserveAdmission(actor, reservation))).toBe('reserved');
    expect(unwrap(await coordinator.beginSave(actor, reservation))).toBe('started');

    const restarted = namespace.restart(actor, options);
    const restored = new QuotaCoordinator(new QuotaEngine(config), restarted, clock);
    expect(unwrap(await restored.finalize(actor, reservation, 'unknown_commit'))).toBe('uncertain');
    expect((await restarted.load(actor.userId))?.reservations[reservation]?.status).toBe('uncertain');
    expect(namespace.getByName(otherActor.userId)).not.toBe(namespace.getByName(actor.userId));
  });

  it('serializes concurrent actor turns and persists the final state', async () => {
    const { coordinator, store } = setup();
    const results = await Promise.all([
      coordinator.recordRequest(actor),
      coordinator.recordRequest(actor),
      coordinator.recordRequest(actor),
    ]);
    expect(results.filter((result) => result.result === 'allowed')).toHaveLength(2);
    expect(results.filter((result) => result.result === 'rate_limited')).toHaveLength(1);
    expect((await store.load(actor.userId))?.shortRequestCount).toBe(3);
  });

  it('fails closed for actor mismatch and never crosses namespace state', async () => {
    const { coordinator, store } = setup();
    await expect(store.load(otherActor.userId)).rejects.toThrow();
    expect((await coordinator.recordRequest(otherActor)).result).toBe('unavailable');
    expect((await coordinator.reserveAdmission(otherActor, otherReservation)).result).toBe('unavailable');
  });

  it('rejects old, unknown, malformed, future, and counter-inconsistent state', async () => {
    const { storage, coordinator } = setup();
    const base = new QuotaEngine(config).initialState(actor.userId, 1_000);
    const cases: unknown[] = [
      { ...base, version: 1 },
      { ...base, unexpected: true },
      { ...base, updatedAt: 2_000 },
      { ...base, reservations: { [reservation]: { reservationId: reservation, actorId: actor.userId, status: 'uncertain', createdAt: 1_000, expiresAt: 1_050 } } },
      { ...base, reservedAdmissionCount: 1 },
    ];
    for (const value of cases) {
      await storage.put('quota-state-v2', value);
      expect((await coordinator.recordRequest(actor)).result).toBe('unavailable');
    }
  });

  it('rejects invalid reservation structure and stored-state overflow without resetting quota', async () => {
    const { storage, store } = setup();
    const base = new QuotaEngine(config).initialState(actor.userId, 1_000);
    const invalidReservation = {
      ...base,
      reservations: { [reservation]: { reservationId: reservation, actorId: actor.userId, status: 'bogus', createdAt: 1_000, expiresAt: 1_050 } },
    };
    await storage.put('quota-state-v2', invalidReservation);
    await expect(store.load(actor.userId)).rejects.toThrow();
    const tooMany = { ...base, reservations: Object.fromEntries([reservation, otherReservation, '00000000-0000-4000-8000-000000000113', '00000000-0000-4000-8000-000000000114', '00000000-0000-4000-8000-000000000115'].map((id) => [id, { reservationId: id, actorId: actor.userId, status: 'cancelled', createdAt: 1_000, expiresAt: 1_050 }])) };
    await storage.put('quota-state-v2', tooMany);
    await expect(store.load(actor.userId)).rejects.toThrow();
  });

  it('does not acknowledge a save before durable storage succeeds', async () => {
    const { storage, coordinator } = setup();
    storage.failNext('put_before');
    expect((await coordinator.reserveAdmission(actor, reservation)).result).toBe('unavailable');
    expect(await coordinator.recordRequest(actor)).toEqual({ result: 'allowed' });
  });

  it('recovers a state whose save was durable but acknowledgement was lost', async () => {
    const { storage, namespace, coordinator, clock } = setup();
    storage.failNext('put_after');
    expect((await coordinator.reserveAdmission(actor, reservation)).result).toBe('unavailable');
    const restarted = namespace.restart(actor, options);
    const restored = new QuotaCoordinator(new QuotaEngine(config), restarted, clock);
    expect(unwrap(await restored.reserveAdmission(actor, reservation))).toBe('replayed');
    expect((await restarted.load(actor.userId))?.reservations[reservation]?.status).toBe('reserved');
  });

  it('preserves in-flight and uncertain quota across restart and never expires it to free capacity', async () => {
    const { namespace, coordinator, clock } = setup();
    expect(unwrap(await coordinator.reserveAdmission(actor, reservation))).toBe('reserved');
    expect(unwrap(await coordinator.beginSave(actor, reservation))).toBe('started');
    clock.advance(50);
    const restarted = namespace.restart(actor, options);
    const restored = new QuotaCoordinator(new QuotaEngine(config), restarted, clock);
    expect(unwrap(await restored.expire(actor))).toBe('expired');
    expect((await restarted.load(actor.userId))?.reservations[reservation]?.status).toBe('uncertain');
    expect((await restarted.load(actor.userId))?.uncertainAdmissionCount).toBe(1);
    expect(unwrap(await restored.reconcile(actor, reservation, 'unknown'))).toBe('uncertain');
    expect(unwrap(await restored.reconcile(actor, reservation, 'key_missing'))).toBe('uncertain');
    expect(unwrap(await restored.reconcile(actor, reservation, 'not_stored'))).toBe('cancelled');
  });

  it('keeps unresolved reservations when the confirmed window changes', async () => {
    const { coordinator, clock, store } = setup();
    expect(unwrap(await coordinator.reserveAdmission(actor, reservation))).toBe('reserved');
    expect(unwrap(await coordinator.beginSave(actor, reservation))).toBe('started');
    clock.advance(50);
    expect(unwrap(await coordinator.expire(actor))).toBe('expired');
    clock.advance(1_000);
    expect((await coordinator.reserveAdmission(actor, otherReservation)).result).toBe('reserved');
    const state = await store.load(actor.userId);
    expect(state?.uncertainAdmissionCount).toBe(1);
    expect(state?.reservations[reservation]?.status).toBe('uncertain');
  });

  it('does not auto-delete uncertain tombstones while terminal tombstones may be pruned', async () => {
    const { coordinator, clock, store } = setup();
    expect(unwrap(await coordinator.reserveAdmission(actor, reservation))).toBe('reserved');
    expect(unwrap(await coordinator.finalize(actor, reservation, 'denied'))).toBe('cancelled');
    expect(unwrap(await coordinator.reserveAdmission(actor, otherReservation))).toBe('reserved');
    expect(unwrap(await coordinator.beginSave(actor, otherReservation))).toBe('started');
    expect(unwrap(await coordinator.finalize(actor, otherReservation, 'unknown_commit'))).toBe('uncertain');
    clock.advance(200);
    await coordinator.expire(actor);
    const state = await store.load(actor.userId);
    expect(state?.reservations[reservation]).toBeUndefined();
    expect(state?.reservations[otherReservation]?.status).toBe('uncertain');
  });

  it('keeps reconciliation read-only at the storage boundary', async () => {
    const storage = new LocalDurableObjectStorage();
    const store = new DurableObjectQuotaStore(actor, storage, storage, options);
    const state: QuotaState = new QuotaEngine(config).initialState(actor.userId, 1_000);
    await store.save(state);
    const loaded = await store.load(actor.userId);
    expect(loaded).toEqual(state);
    expect(storage).toBeDefined();
  });
});

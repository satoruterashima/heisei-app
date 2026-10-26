import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Hono } from 'hono';
import { DurableObjectQuotaBoundary } from '../apps/api/src/quota-do-boundary.js';
import type { QuotaActor } from '../apps/api/src/quota-do-worker.js';
import { fixtureQuotaActor, fixtureReservationId, type QuotaState } from '../packages/domain/src/index.js';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    QUOTA_ACTOR: DurableObjectNamespace<QuotaActor>;
  }
}

const actor = fixtureQuotaActor('00000000-0000-4000-8000-000000000021');
const otherActor = fixtureQuotaActor('00000000-0000-4000-8000-000000000022');
const reservation = fixtureReservationId('00000000-0000-4000-8000-000000000121');
const otherReservation = fixtureReservationId('00000000-0000-4000-8000-000000000122');
const apiActorId = '00000000-0000-4000-8000-000000000031';

function stub(userId: string) {
  return env.QUOTA_ACTOR.get(env.QUOTA_ACTOR.idFromName(userId));
}

async function persistedState(name: string): Promise<unknown> {
  return runInDurableObject(stub(name), async (_instance, state) => state.storage.get('quota-state-v2'));
}

async function seedState(name: string, stateValue: unknown): Promise<void> {
  await runInDurableObject(stub(name), async (_instance, state) => {
    await state.storage.put('quota-state-v2', stateValue);
  });
}

describe('real local Durable Object quota runtime', () => {
  it('connects an internal Hono flow to the real DO RPC boundary', async () => {
    const app = new Hono();
    const boundary = new DurableObjectQuotaBoundary(env.QUOTA_ACTOR);
    app.post('/internal/report', async (c) => {
      const actor = fixtureQuotaActor(apiActorId);
      const reservation = fixtureReservationId('00000000-0000-4000-8000-000000000032');
      if ((await boundary.recordRequest(actor)).result !== 'allowed') return c.json({ error: 'unavailable' }, 503);
      if ((await boundary.reserveAdmission(actor, reservation)).result !== 'reserved') return c.json({ error: 'unavailable' }, 503);
      if ((await boundary.beginSave(actor, reservation)).result !== 'started') return c.json({ error: 'unavailable' }, 503);
      const result = await boundary.finalize(actor, reservation, 'accepted');
      return c.json({ result: result.result }, result.result === 'committed' ? 202 : 503);
    });
    const response = await app.request('/internal/report', { method: 'POST' });
    expect(response.status).toBe(202);
    const state = await persistedState(apiActorId) as QuotaState;
    expect(state.confirmedAdmissionCount).toBe(1);
    expect(state.reservedAdmissionCount).toBe(0);
  });

  it('keeps Hono-facing errors generic when the real DO state is corrupt', async () => {
    const corruptActorId = '00000000-0000-4000-8000-000000000035';
    await seedState(corruptActorId, { version: 1 });
    const result = await new DurableObjectQuotaBoundary(env.QUOTA_ACTOR).recordRequest(fixtureQuotaActor(corruptActorId));
    expect(result.result).toBe('unavailable');
  });

  it('uses the DO input gate for same-actor parallel requests', async () => {
    const results = await Promise.all(Array.from({ length: 3 }, () => stub(actor.userId).recordRequest(actor)));
    expect(results.filter((result) => result.result === 'allowed')).toHaveLength(2);
    expect(results.filter((result) => result.result === 'rate_limited')).toHaveLength(1);
    expect((await persistedState(actor.userId) as QuotaState).shortRequestCount).toBe(3);
  });

  it('serializes same-reservation operations and keeps one durable reservation', async () => {
    const results = await Promise.all(Array.from({ length: 3 }, () => stub(otherActor.userId).reserveAdmission(otherActor, otherReservation)));
    expect(results.filter((result) => result.result === 'reserved')).toHaveLength(1);
    expect(results.filter((result) => result.result === 'replayed')).toHaveLength(2);
    expect(Object.keys((await persistedState(otherActor.userId) as QuotaState).reservations)).toEqual([otherReservation]);
  });

  it('keeps actors isolated and exposes no quota operation over HTTP', async () => {
    const actorResult = await stub(actor.userId).recordRequest(actor);
    const otherState = await persistedState(otherActor.userId) as QuotaState;
    expect(actorResult.result).toBe('rate_limited');
    expect(otherState.actorId).toBe(otherActor.userId);
  });

  it('restores persistent state through a newly acquired stub', async () => {
    const first = stub('00000000-0000-4000-8000-000000000023');
    const firstResult = await first.reserveAdmission(fixtureQuotaActor('00000000-0000-4000-8000-000000000023'), reservation);
    expect(firstResult.result).toBe('reserved');
    const second = stub('00000000-0000-4000-8000-000000000023');
    const secondResult = await second.reserveAdmission(fixtureQuotaActor('00000000-0000-4000-8000-000000000023'), reservation);
    expect(secondResult.result).toBe('replayed');
  });

  it('fails closed on corrupted state without auto-initializing it', async () => {
    const corruptedActor = fixtureQuotaActor('00000000-0000-4000-8000-000000000024');
    await seedState(corruptedActor.userId, { version: 1, actorId: corruptedActor.userId });
    expect((await stub(corruptedActor.userId).recordRequest(corruptedActor)).result).toBe('unavailable');
    expect(await persistedState(corruptedActor.userId)).toEqual({ version: 1, actorId: corruptedActor.userId });
  });

  it('moves expired in-flight state to uncertain and retains it across runtime access', async () => {
    const uncertainActor = fixtureQuotaActor('00000000-0000-4000-8000-000000000025');
    const now = Date.now();
    const state: QuotaState = {
      version: 2,
      actorId: uncertainActor.userId,
      shortWindowStartedAt: now,
      shortRequestCount: 0,
      longWindowStartedAt: now,
      longRequestCount: 0,
      admissionWindowStartedAt: now,
      confirmedAdmissionCount: 0,
      reservedAdmissionCount: 1,
      uncertainAdmissionCount: 0,
      reservations: {
        [reservation]: { reservationId: reservation, actorId: uncertainActor.userId, status: 'in_flight', createdAt: now - 100, expiresAt: now - 1 },
      },
      updatedAt: now,
    };
    await seedState(uncertainActor.userId, state);
    expect((await stub(uncertainActor.userId).expire(uncertainActor)).result).toBe('expired');
    const after = await persistedState(uncertainActor.userId) as QuotaState;
    expect(after.reservations[reservation].status).toBe('uncertain');
    expect(after.uncertainAdmissionCount).toBe(1);
    expect((await stub(uncertainActor.userId).reconcile(uncertainActor, reservation, 'unknown')).result).toBe('uncertain');
  });

  it('rejects reservation count overflow and unknown reservation structure', async () => {
    const invalidActor = fixtureQuotaActor('00000000-0000-4000-8000-000000000026');
    const now = Date.now();
    const ids = Array.from({ length: 257 }, (_, index) => `00000000-0000-4000-8000-${String(0x131 + index).padStart(12, '0')}`);
    const invalid = {
      version: 2,
      actorId: invalidActor.userId,
      shortWindowStartedAt: now,
      shortRequestCount: 0,
      longWindowStartedAt: now,
      longRequestCount: 0,
      admissionWindowStartedAt: now,
      confirmedAdmissionCount: 0,
      reservedAdmissionCount: 0,
      uncertainAdmissionCount: 0,
      reservations: Object.fromEntries(ids.map((id) => [id, { reservationId: id, actorId: invalidActor.userId, status: 'cancelled', createdAt: now, expiresAt: now + 1 }])),
      updatedAt: now,
    };
    await seedState(invalidActor.userId, invalid);
    expect((await stub(invalidActor.userId).recordRequest(invalidActor)).result).toBe('unavailable');
    expect(await persistedState(invalidActor.userId)).toEqual(invalid);
  });
});

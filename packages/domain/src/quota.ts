const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

declare const verifiedQuotaActorBrand: unique symbol;
declare const reservationIdBrand: unique symbol;

/** Must be created only from the server-side identity loader, never from HTTP input. */
export type VerifiedQuotaActor = {
  userId: string;
  readonly [verifiedQuotaActorBrand]: true;
};

/** An opaque server-generated UUID, not a client Idempotency-Key. */
export type QuotaReservationId = string & { readonly [reservationIdBrand]: true };

export type QuotaConfig = {
  shortWindowMs: number;
  shortRequestLimit: number;
  longWindowMs: number;
  longRequestLimit: number;
  admissionWindowMs: number;
  newAdmissionLimit: number;
  reservationTtlMs: number;
  maxActiveReservations: number;
  stateRetentionMs: number;
};

export type ReservationStatus = 'reserved' | 'committed' | 'cancelled' | 'expired' | 'uncertain';

export type QuotaReservation = {
  reservationId: string;
  actorId: string;
  status: ReservationStatus;
  createdAt: number;
  expiresAt: number;
};

export type QuotaState = {
  version: 1;
  actorId: string;
  shortWindowStartedAt: number;
  shortRequestCount: number;
  longWindowStartedAt: number;
  longRequestCount: number;
  admissionWindowStartedAt: number;
  admissionCount: number;
  reservations: Record<string, QuotaReservation>;
  updatedAt: number;
};

export type RequestGateResult = 'allowed' | 'rate_limited';
export type ReservationResult = 'reserved' | 'replayed' | 'idempotency_conflict' | 'rate_limited';
export type ReportOutcome = 'accepted' | 'replayed' | 'duplicate' | 'denied' | 'idempotency_conflict' | 'unavailable' | 'unknown_commit';
export type FinalizeResult = 'committed' | 'cancelled' | 'uncertain' | 'replayed' | 'idempotency_conflict' | 'unavailable';

export type QuotaStep<T> = { state: QuotaState; result: T };

export interface QuotaClock {
  now(): number;
}

export interface QuotaStore {
  load(actorId: string): Promise<QuotaState | null>;
  save(state: QuotaState): Promise<void>;
  withActorLock<T>(actorId: string, operation: () => Promise<T>): Promise<T>;
}

function assertTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid quota clock');
}

function assertConfig(config: QuotaConfig): void {
  for (const value of Object.values(config)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('invalid quota configuration');
  }
}

function normalizeActorId(actorId: string): string {
  const normalized = actorId.toLowerCase();
  if (!UUID_V4.test(normalized)) throw new Error('invalid verified actor');
  return normalized;
}

function assertReservationId(reservationId: string): asserts reservationId is QuotaReservationId {
  if (!UUID_V4.test(reservationId)) throw new Error('invalid internal reservation id');
}

function resetWindow(startedAt: number, count: number, now: number, windowMs: number): { startedAt: number; count: number } {
  return now - startedAt >= windowMs ? { startedAt: now, count: 0 } : { startedAt, count };
}

function cloneState(state: QuotaState): QuotaState {
  return { ...state, reservations: Object.fromEntries(Object.entries(state.reservations).map(([key, value]) => [key, { ...value }])) };
}

/** Pure quota and reservation state transitions. It has no network or storage dependency. */
export class QuotaEngine {
  constructor(private readonly config: QuotaConfig) {
    assertConfig(config);
  }

  initialState(actorId: string, now: number): QuotaState {
    const actor = normalizeActorId(actorId);
    assertTime(now);
    return {
      version: 1,
      actorId: actor,
      shortWindowStartedAt: now,
      shortRequestCount: 0,
      longWindowStartedAt: now,
      longRequestCount: 0,
      admissionWindowStartedAt: now,
      admissionCount: 0,
      reservations: {},
      updatedAt: now,
    };
  }

  recordRequest(input: QuotaState, now: number): QuotaStep<RequestGateResult> {
    assertTime(now);
    const state = cloneState(input);
    const short = resetWindow(state.shortWindowStartedAt, state.shortRequestCount, now, this.config.shortWindowMs);
    const long = resetWindow(state.longWindowStartedAt, state.longRequestCount, now, this.config.longWindowMs);
    state.shortWindowStartedAt = short.startedAt;
    state.shortRequestCount = short.count + 1;
    state.longWindowStartedAt = long.startedAt;
    state.longRequestCount = long.count + 1;
    state.updatedAt = now;
    const limited = short.count >= this.config.shortRequestLimit || long.count >= this.config.longRequestLimit;
    return { state, result: limited ? 'rate_limited' : 'allowed' };
  }

  reserveAdmission(input: QuotaState, reservationId: string, now: number): QuotaStep<ReservationResult> {
    assertTime(now);
    assertReservationId(reservationId);
    const state = this.expireReservations(input, now).state;
    const existing = state.reservations[reservationId];
    if (existing) {
      if (existing.actorId !== state.actorId) return { state, result: 'idempotency_conflict' };
      if (existing.status === 'reserved' || existing.status === 'uncertain') return { state, result: existing.status === 'uncertain' ? 'idempotency_conflict' : 'replayed' };
      return { state, result: 'idempotency_conflict' };
    }
    const admission = resetWindow(state.admissionWindowStartedAt, state.admissionCount, now, this.config.admissionWindowMs);
    state.admissionWindowStartedAt = admission.startedAt;
    state.admissionCount = admission.count;
    const activeReservations = Object.values(state.reservations).filter((value) => value.status === 'reserved' || value.status === 'uncertain').length;
    if (activeReservations >= this.config.maxActiveReservations || admission.count >= this.config.newAdmissionLimit) {
      state.updatedAt = now;
      return { state, result: 'rate_limited' };
    }
    state.admissionCount += 1;
    state.reservations[reservationId] = {
      reservationId,
      actorId: state.actorId,
      status: 'reserved',
      createdAt: now,
      expiresAt: now + this.config.reservationTtlMs,
    };
    state.updatedAt = now;
    return { state, result: 'reserved' };
  }

  finalize(input: QuotaState, reservationId: string, outcome: ReportOutcome, now: number): QuotaStep<FinalizeResult> {
    assertTime(now);
    assertReservationId(reservationId);
    const state = cloneState(input);
    const reservation = state.reservations[reservationId];
    if (!reservation || reservation.actorId !== state.actorId) return { state, result: 'unavailable' };
    if (reservation.status === 'committed' && outcome === 'accepted') return { state, result: 'replayed' };
    if (reservation.status === 'uncertain') return { state, result: 'uncertain' };
    if (reservation.status !== 'reserved') return { state, result: 'idempotency_conflict' };
    if (outcome === 'unknown_commit') {
      reservation.status = 'uncertain';
      state.updatedAt = now;
      return { state, result: 'uncertain' };
    }
    if (outcome === 'accepted') {
      reservation.status = 'committed';
      state.updatedAt = now;
      return { state, result: 'committed' };
    }
    reservation.status = 'cancelled';
    state.admissionCount = Math.max(0, state.admissionCount - 1);
    state.updatedAt = now;
    return { state, result: 'cancelled' };
  }

  expireReservations(input: QuotaState, now: number): QuotaStep<'expired' | 'unchanged'> {
    assertTime(now);
    const state = cloneState(input);
    let expired = false;
    for (const reservation of Object.values(state.reservations)) {
      if (reservation.status === 'reserved' && reservation.expiresAt <= now) {
        reservation.status = 'expired';
        state.admissionCount = Math.max(0, state.admissionCount - 1);
        expired = true;
      }
    }
    for (const [id, reservation] of Object.entries(state.reservations)) {
      if (reservation.status !== 'reserved' && reservation.status !== 'uncertain' && now - reservation.createdAt >= this.config.stateRetentionMs) delete state.reservations[id];
    }
    state.updatedAt = now;
    return { state, result: expired ? 'expired' : 'unchanged' };
  }
}

export type CoordinatorResult<T> = { result: T } | { result: 'unavailable' };

/** Storage-backed coordinator. The store lock is the local equivalent of a DO actor turn. */
export class QuotaCoordinator {
  constructor(private readonly engine: QuotaEngine, private readonly store: QuotaStore, private readonly clock: QuotaClock) {}

  async recordRequest(actor: VerifiedQuotaActor): Promise<CoordinatorResult<RequestGateResult>> {
    return this.withState(actor, (state, now) => this.engine.recordRequest(state, now));
  }

  async reserveAdmission(actor: VerifiedQuotaActor, reservationId: QuotaReservationId): Promise<CoordinatorResult<ReservationResult>> {
    return this.withState(actor, (state, now) => this.engine.reserveAdmission(state, reservationId, now));
  }

  async finalize(actor: VerifiedQuotaActor, reservationId: QuotaReservationId, outcome: ReportOutcome): Promise<CoordinatorResult<FinalizeResult>> {
    return this.withState(actor, (state, now) => this.engine.finalize(state, reservationId, outcome, now));
  }

  async expire(actor: VerifiedQuotaActor): Promise<CoordinatorResult<'expired' | 'unchanged'>> {
    return this.withState(actor, (state, now) => this.engine.expireReservations(state, now));
  }

  private async withState<T>(actor: VerifiedQuotaActor, transition: (state: QuotaState, now: number) => QuotaStep<T>): Promise<CoordinatorResult<T>> {
    try {
      const actorId = normalizeActorId(actor.userId);
      return await this.store.withActorLock(actorId, async () => {
        const now = this.clock.now();
        assertTime(now);
        const current = await this.store.load(actorId) ?? this.engine.initialState(actorId, now);
        if (current.actorId !== actorId || current.version !== 1) return { result: 'unavailable' };
        const step = transition(current, now);
        await this.store.save(step.state);
        return { result: step.result };
      });
    } catch {
      return { result: 'unavailable' };
    }
  }
}

/** Local fixture store; production DO storage must provide the same atomic actor turn. */
export class InMemoryFixtureStore implements QuotaStore {
  private readonly states = new Map<string, QuotaState>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly fail?: { load?: boolean; save?: boolean }) {}

  async load(actorId: string): Promise<QuotaState | null> {
    if (this.fail?.load) throw new Error('fixture load failed');
    const state = this.states.get(actorId);
    return state ? cloneState(state) : null;
  }

  async save(state: QuotaState): Promise<void> {
    if (this.fail?.save) throw new Error('fixture save failed');
    this.states.set(state.actorId, cloneState(state));
  }

  async withActorLock<T>(actorId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(actorId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(actorId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(actorId) === current) this.locks.delete(actorId);
    }
  }
}

export function fixtureQuotaActor(userId: string): VerifiedQuotaActor {
  return { userId: normalizeActorId(userId) } as VerifiedQuotaActor;
}

export function fixtureReservationId(value: string): QuotaReservationId {
  assertReservationId(value);
  return value;
}

/** Production callers must generate reservation IDs server-side; never derive them from HTTP keys. */
export function createQuotaReservationId(): QuotaReservationId {
  const value = crypto.randomUUID();
  assertReservationId(value);
  return value;
}

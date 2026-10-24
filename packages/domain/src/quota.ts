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

export type ReservationStatus = 'reserved' | 'in_flight' | 'committed' | 'cancelled' | 'expired' | 'uncertain';

export type QuotaReservation = {
  reservationId: string;
  actorId: string;
  status: ReservationStatus;
  createdAt: number;
  expiresAt: number;
};

export type QuotaState = {
  version: 2;
  actorId: string;
  shortWindowStartedAt: number;
  shortRequestCount: number;
  longWindowStartedAt: number;
  longRequestCount: number;
  admissionWindowStartedAt: number;
  confirmedAdmissionCount: number;
  reservedAdmissionCount: number;
  uncertainAdmissionCount: number;
  reservations: Record<string, QuotaReservation>;
  updatedAt: number;
};

export type RequestGateResult = 'allowed' | 'rate_limited';
export type ReservationResult = 'reserved' | 'replayed' | 'idempotency_conflict' | 'rate_limited';
export type BeginSaveResult = 'started' | 'replayed' | 'uncertain' | 'unavailable';
export type ReportOutcome = 'accepted' | 'replayed' | 'duplicate' | 'denied' | 'idempotency_conflict' | 'unavailable' | 'unknown_commit';
export type FinalizeResult = 'committed' | 'cancelled' | 'uncertain' | 'replayed' | 'idempotency_conflict' | 'unavailable';
export type ReconciliationObservation = 'stored' | 'not_stored' | 'unavailable' | 'unknown' | 'key_missing';

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

const RESERVATION_STATUSES: readonly ReservationStatus[] = ['reserved', 'in_flight', 'committed', 'cancelled', 'expired', 'uncertain'];

/** Strict persisted-state validation used by both fixture and durable adapters. */
export function validateQuotaState(value: unknown, actorId: string, now?: number, maxStoredReservations?: number): value is QuotaState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  const expectedKeys = ['version', 'actorId', 'shortWindowStartedAt', 'shortRequestCount', 'longWindowStartedAt', 'longRequestCount', 'admissionWindowStartedAt', 'confirmedAdmissionCount', 'reservedAdmissionCount', 'uncertainAdmissionCount', 'reservations', 'updatedAt'];
  if (Object.keys(state).some((key) => !expectedKeys.includes(key)) || expectedKeys.some((key) => !(key in state))) return false;
  if (state.version !== 2 || state.actorId !== actorId || !UUID_V4.test(actorId)) return false;
  const nonNegativeIntegers = ['shortWindowStartedAt', 'shortRequestCount', 'longWindowStartedAt', 'longRequestCount', 'admissionWindowStartedAt', 'confirmedAdmissionCount', 'reservedAdmissionCount', 'uncertainAdmissionCount', 'updatedAt'];
  if (nonNegativeIntegers.some((key) => !Number.isSafeInteger(state[key]) || (state[key] as number) < 0)) return false;
  if (now !== undefined && (!Number.isSafeInteger(now) || (state.updatedAt as number) > now || (state.shortWindowStartedAt as number) > now || (state.longWindowStartedAt as number) > now || (state.admissionWindowStartedAt as number) > now)) return false;
  if (!state.reservations || typeof state.reservations !== 'object' || Array.isArray(state.reservations)) return false;
  const reservations = state.reservations as Record<string, unknown>;
  if (maxStoredReservations !== undefined && Object.keys(reservations).length > maxStoredReservations) return false;
  let reserved = 0;
  let uncertain = 0;
  for (const [key, raw] of Object.entries(reservations)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const reservation = raw as Record<string, unknown>;
    const reservationKeys = ['reservationId', 'actorId', 'status', 'createdAt', 'expiresAt'];
    if (Object.keys(reservation).some((field) => !reservationKeys.includes(field)) || reservationKeys.some((field) => !(field in reservation))) return false;
    if (reservation.reservationId !== key || typeof reservation.reservationId !== 'string' || !UUID_V4.test(reservation.reservationId)) return false;
    if (reservation.actorId !== actorId || typeof reservation.actorId !== 'string') return false;
    if (typeof reservation.status !== 'string' || !RESERVATION_STATUSES.includes(reservation.status as ReservationStatus)) return false;
    if (!Number.isSafeInteger(reservation.createdAt) || !Number.isSafeInteger(reservation.expiresAt) || (reservation.createdAt as number) < 0 || (reservation.expiresAt as number) < (reservation.createdAt as number)) return false;
    if (now !== undefined && (reservation.createdAt as number) > now) return false;
    if (reservation.status === 'reserved' || reservation.status === 'in_flight') reserved += 1;
    if (reservation.status === 'uncertain') uncertain += 1;
  }
  return state.reservedAdmissionCount === reserved && state.uncertainAdmissionCount === uncertain;
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
      version: 2,
      actorId: actor,
      shortWindowStartedAt: now,
      shortRequestCount: 0,
      longWindowStartedAt: now,
      longRequestCount: 0,
      admissionWindowStartedAt: now,
      confirmedAdmissionCount: 0,
      reservedAdmissionCount: 0,
      uncertainAdmissionCount: 0,
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
    const admission = resetWindow(state.admissionWindowStartedAt, state.confirmedAdmissionCount, now, this.config.admissionWindowMs);
    state.admissionWindowStartedAt = admission.startedAt;
    state.confirmedAdmissionCount = admission.count;
    const activeReservations = state.reservedAdmissionCount + state.uncertainAdmissionCount;
    if (activeReservations >= this.config.maxActiveReservations || admission.count + activeReservations >= this.config.newAdmissionLimit) {
      state.updatedAt = now;
      return { state, result: 'rate_limited' };
    }
    state.reservedAdmissionCount += 1;
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

  beginSave(input: QuotaState, reservationId: string, now: number): QuotaStep<BeginSaveResult> {
    assertTime(now);
    assertReservationId(reservationId);
    const state = cloneState(input);
    const reservation = state.reservations[reservationId];
    if (!reservation || reservation.actorId !== state.actorId) return { state, result: 'unavailable' };
    if (reservation.status === 'reserved') {
      reservation.status = 'in_flight';
      state.updatedAt = now;
      return { state, result: 'started' };
    }
    if (reservation.status === 'in_flight') return { state, result: 'replayed' };
    if (reservation.status === 'uncertain') return { state, result: 'uncertain' };
    return { state, result: 'unavailable' };
  }

  finalize(input: QuotaState, reservationId: string, outcome: ReportOutcome, now: number): QuotaStep<FinalizeResult> {
    assertTime(now);
    assertReservationId(reservationId);
    const state = cloneState(input);
    const reservation = state.reservations[reservationId];
    if (!reservation || reservation.actorId !== state.actorId) return { state, result: 'unavailable' };
    if (reservation.status === 'committed' && outcome === 'accepted') return { state, result: 'replayed' };
    if (reservation.status === 'uncertain') return { state, result: 'uncertain' };
    if (reservation.status !== 'reserved' && reservation.status !== 'in_flight') return { state, result: 'idempotency_conflict' };
    if (outcome === 'unknown_commit') {
      reservation.status = 'uncertain';
      state.reservedAdmissionCount = Math.max(0, state.reservedAdmissionCount - 1);
      state.uncertainAdmissionCount += 1;
      state.updatedAt = now;
      return { state, result: 'uncertain' };
    }
    if (outcome === 'accepted') {
      if (reservation.status !== 'in_flight') return { state, result: 'unavailable' };
      reservation.status = 'committed';
      state.reservedAdmissionCount = Math.max(0, state.reservedAdmissionCount - 1);
      const admission = resetWindow(state.admissionWindowStartedAt, state.confirmedAdmissionCount, now, this.config.admissionWindowMs);
      state.admissionWindowStartedAt = admission.startedAt;
      state.confirmedAdmissionCount = admission.count + 1;
      state.updatedAt = now;
      return { state, result: 'committed' };
    }
    if (reservation.status === 'in_flight') {
      reservation.status = 'uncertain';
      state.reservedAdmissionCount = Math.max(0, state.reservedAdmissionCount - 1);
      state.uncertainAdmissionCount += 1;
      state.updatedAt = now;
      return { state, result: 'uncertain' };
    }
    reservation.status = 'cancelled';
    state.reservedAdmissionCount = Math.max(0, state.reservedAdmissionCount - 1);
    state.updatedAt = now;
    return { state, result: 'cancelled' };
  }

  reconcile(input: QuotaState, reservationId: string, observation: ReconciliationObservation, now: number): QuotaStep<'committed' | 'cancelled' | 'uncertain' | 'replayed'> {
    assertTime(now);
    assertReservationId(reservationId);
    const state = cloneState(input);
    const reservation = state.reservations[reservationId];
    if (!reservation || reservation.actorId !== state.actorId) return { state, result: 'uncertain' };
    if (reservation.status === 'committed') return { state, result: 'replayed' };
    if (reservation.status === 'cancelled' || reservation.status === 'expired') return { state, result: 'cancelled' };
    if (observation === 'stored') {
      if (reservation.status === 'uncertain') state.uncertainAdmissionCount = Math.max(0, state.uncertainAdmissionCount - 1);
      else state.reservedAdmissionCount = Math.max(0, state.reservedAdmissionCount - 1);
      const admission = resetWindow(state.admissionWindowStartedAt, state.confirmedAdmissionCount, now, this.config.admissionWindowMs);
      state.admissionWindowStartedAt = admission.startedAt;
      state.confirmedAdmissionCount = admission.count + 1;
      reservation.status = 'committed';
      state.updatedAt = now;
      return { state, result: 'committed' };
    }
    if (observation === 'not_stored') {
      if (reservation.status === 'uncertain') state.uncertainAdmissionCount = Math.max(0, state.uncertainAdmissionCount - 1);
      else state.reservedAdmissionCount = Math.max(0, state.reservedAdmissionCount - 1);
      reservation.status = 'cancelled';
      state.updatedAt = now;
      return { state, result: 'cancelled' };
    }
    if (reservation.status === 'reserved' || reservation.status === 'in_flight') {
      state.reservedAdmissionCount = Math.max(0, state.reservedAdmissionCount - 1);
      state.uncertainAdmissionCount += 1;
    }
    reservation.status = 'uncertain';
    state.updatedAt = now;
    return { state, result: 'uncertain' };
  }

  expireReservations(input: QuotaState, now: number): QuotaStep<'expired' | 'unchanged'> {
    assertTime(now);
    const state = cloneState(input);
    let expired = false;
    for (const reservation of Object.values(state.reservations)) {
      if (reservation.status === 'reserved' && reservation.expiresAt <= now) {
        reservation.status = 'expired';
        state.reservedAdmissionCount = Math.max(0, state.reservedAdmissionCount - 1);
        expired = true;
      } else if (reservation.status === 'in_flight' && reservation.expiresAt <= now) {
        reservation.status = 'uncertain';
        state.reservedAdmissionCount = Math.max(0, state.reservedAdmissionCount - 1);
        state.uncertainAdmissionCount += 1;
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

  async beginSave(actor: VerifiedQuotaActor, reservationId: QuotaReservationId): Promise<CoordinatorResult<BeginSaveResult>> {
    return this.withState(actor, (state, now) => this.engine.beginSave(state, reservationId, now));
  }

  async reconcile(actor: VerifiedQuotaActor, reservationId: QuotaReservationId, observation: ReconciliationObservation): Promise<CoordinatorResult<'committed' | 'cancelled' | 'uncertain' | 'replayed'>> {
    return this.withState(actor, (state, now) => this.engine.reconcile(state, reservationId, observation, now));
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
        if (!validateQuotaState(current, actorId, now)) return { result: 'unavailable' };
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

  async seed(state: QuotaState): Promise<void> {
    this.states.set(state.actorId, cloneState(state));
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

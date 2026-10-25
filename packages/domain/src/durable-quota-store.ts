import {
  fixtureQuotaActor,
  type QuotaState,
  type ReconciliationEvidence,
  type QuotaStore,
  type VerifiedQuotaActor,
  validateQuotaState,
} from './quota.js';

const STATE_KEY = 'quota-state-v2';

export type DurableQuotaStateSummary = {
  actorId: string;
  updatedAt: number;
  uncertainCount: number;
  reservations: Array<{ reservationId: string; status: QuotaState['reservations'][string]['status']; createdAt: number; expiresAt: number; reconciliationEvidence?: ReconciliationEvidence }>;
  nextCursor?: string;
};

/** The small subset of DO Storage used by this adapter. */
export interface DurableQuotaStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

/**
 * A DO input-gate/turn boundary. A real Durable Object supplies this boundary
 * through its serialized RPC handler; the fixture supplies a queued turn.
 */
export interface DurableQuotaTurn {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export type DurableQuotaStoreOptions = {
  maxStoredReservations: number;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalActor(actorId: string): string {
  return fixtureQuotaActor(actorId).userId;
}

/**
 * Persistent actor-scoped QuotaStore. It does not use an in-memory lock to
 * provide correctness: the caller's DurableQuotaTurn is the DO input gate.
 */
export class DurableObjectQuotaStore implements QuotaStore {
  private readonly actorId: string;

  constructor(
    actor: VerifiedQuotaActor,
    private readonly storage: DurableQuotaStorageLike,
    private readonly turn: DurableQuotaTurn,
    private readonly options: DurableQuotaStoreOptions,
  ) {
    this.actorId = canonicalActor(actor.userId);
    if (!Number.isSafeInteger(options.maxStoredReservations) || options.maxStoredReservations <= 0) {
      throw new Error('invalid durable quota storage configuration');
    }
  }

  async load(actorId: string): Promise<QuotaState | null> {
    this.assertActor(actorId);
    const raw = await this.storage.get<unknown>(STATE_KEY);
    if (raw === undefined) return null;
    if (!validateQuotaState(raw, this.actorId, undefined, this.options.maxStoredReservations)) {
      throw new Error('invalid durable quota state');
    }
    return clone(raw);
  }

  async save(state: QuotaState): Promise<void> {
    if (!validateQuotaState(state, this.actorId, undefined, this.options.maxStoredReservations)) {
      throw new Error('invalid durable quota state');
    }
    await this.storage.put(STATE_KEY, clone(state));
  }

  async inspect(actorId: string, limit: number, cursor?: string): Promise<DurableQuotaStateSummary> {
    this.assertActor(actorId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('invalid inspection limit');
    const raw = await this.storage.get<unknown>(STATE_KEY);
    if (raw === undefined) return { actorId: this.actorId, updatedAt: 0, uncertainCount: 0, reservations: [] };
    if (!validateQuotaState(raw, this.actorId, undefined, this.options.maxStoredReservations)) throw new Error('invalid durable quota state');
    const ids = Object.keys(raw.reservations).sort();
    const start = cursor ? ids.findIndex((id) => id > cursor) : 0;
    const offset = start < 0 ? ids.length : start;
    const selected = ids.slice(offset, offset + limit);
    const reservations = selected.map((reservationId) => {
      const reservation = raw.reservations[reservationId]!;
      return { reservationId, status: reservation.status, createdAt: reservation.createdAt, expiresAt: reservation.expiresAt, ...(reservation.reconciliationEvidence === undefined ? {} : { reconciliationEvidence: reservation.reconciliationEvidence }) };
    });
    return { actorId: this.actorId, updatedAt: raw.updatedAt, uncertainCount: raw.uncertainAdmissionCount, reservations, ...(offset + selected.length < ids.length ? { nextCursor: selected.at(-1) } : {}) };
  }

  async withActorLock<T>(actorId: string, operation: () => Promise<T>): Promise<T> {
    this.assertActor(actorId);
    return this.turn.run(operation);
  }

  private assertActor(actorId: string): void {
    if (canonicalActor(actorId) !== this.actorId) throw new Error('actor storage mismatch');
  }
}

type FailurePoint = 'load' | 'put_before' | 'put_after';

/**
 * Local-only DO storage simulator. The backing map represents durable DO
 * storage and survives creation of a new adapter instance. `run` models the
 * serialized input gate, while get/put clone values to expose mutation bugs.
 */
export class LocalDurableObjectStorage implements DurableQuotaStorageLike, DurableQuotaTurn {
  private readonly values = new Map<string, unknown>();
  private pending: Promise<void> = Promise.resolve();
  private failure: FailurePoint | undefined;

  failNext(point: FailurePoint): void {
    this.failure = point;
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (this.failure === 'load') {
      this.failure = undefined;
      throw new Error('simulated durable load failure');
    }
    const value = this.values.get(key);
    return value === undefined ? undefined : clone(value) as T;
  }

  async put<T>(key: string, value: T): Promise<void> {
    if (this.failure === 'put_before') {
      this.failure = undefined;
      throw new Error('simulated durable save failure');
    }
    this.values.set(key, clone(value));
    if (this.failure === 'put_after') {
      this.failure = undefined;
      throw new Error('simulated durable save acknowledgement loss');
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

/** Deterministic local namespace simulator: one durable storage per actor name. */
export class LocalDurableQuotaNamespace {
  private readonly storages = new Map<string, LocalDurableObjectStorage>();

  getByName(actorName: string): LocalDurableObjectStorage {
    const actorId = canonicalActor(actorName);
    let storage = this.storages.get(actorId);
    if (!storage) {
      storage = new LocalDurableObjectStorage();
      this.storages.set(actorId, storage);
    }
    return storage;
  }

  restart(actor: VerifiedQuotaActor, options: DurableQuotaStoreOptions): DurableObjectQuotaStore {
    const storage = this.getByName(actor.userId);
    return new DurableObjectQuotaStore(actor, storage, storage, options);
  }
}

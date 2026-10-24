interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
}

interface DurableObjectNamespace<T> {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub<T>;
}

interface DurableObjectId {
  toString(): string;
}

type DurableObjectStub<T> = T;

declare module 'cloudflare:workers' {
  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}

declare module 'cloudflare:test' {
  interface ProvidedEnv {}
  export const env: ProvidedEnv;
  export function runInDurableObject<O, R>(stub: DurableObjectStub<O>, callback: (instance: O, state: DurableObjectState) => R | Promise<R>): Promise<R>;
}

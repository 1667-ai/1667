import { ApiError, type StoryApi } from "./api.js";

export interface ConnectionState {
  down: boolean;
  attempt: number;
  nextRetryAt: number | null;
  error: string | null;
}

const ONLINE: ConnectionState = { down: false, attempt: 0, nextRetryAt: null, error: null };

export function connectionFailed(state: ConnectionState, error: unknown, now: number): ConnectionState {
  const attempt = Math.min(5, state.down ? state.attempt + 1 : 1);
  return {
    down: true,
    attempt,
    nextRetryAt: attempt < 5 ? now + 3_000 : null,
    error: error instanceof Error ? error.message : String(error)
  };
}

export function connectionSucceeded(): ConnectionState {
  return { ...ONLINE };
}

export function retrySeconds(state: ConnectionState, now: number): number {
  return state.nextRetryAt === null ? 0 : Math.max(0, Math.ceil((state.nextRetryAt - now) / 1_000));
}

export interface ConnectionMonitor {
  api: StoryApi;
  state(): ConnectionState;
  retryNow(): Promise<boolean>;
  subscribe(listener: (state: ConnectionState) => void): () => void;
  dispose(): void;
}

export function createConnectionMonitor(raw: StoryApi): ConnectionMonitor {
  let current = connectionSucceeded();
  // A transport failure only describes the connectivity observed when its
  // request began. Any success that completes later supersedes that evidence,
  // even when the older request is still in flight.
  let successVersion = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<(state: ConnectionState) => void>();
  const publish = (state: ConnectionState) => {
    current = state;
    for (const listener of listeners) listener({ ...current });
  };
  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    if (current.nextRetryAt === null) return void (timer = null);
    timer = setTimeout(() => void retryNow(), Math.max(0, current.nextRetryAt - Date.now()));
    timer.unref?.();
  };
  const failed = (error: unknown) => {
    publish(connectionFailed(current, error, Date.now()));
    schedule();
  };
  const succeeded = () => {
    successVersion += 1;
    if (!current.down) return;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    publish(connectionSucceeded());
  };
  const retryNow = async (): Promise<boolean> => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const startedAtSuccessVersion = successVersion;
    try {
      await raw.listStories();
      succeeded();
      return true;
    } catch (error) {
      if (successVersion === startedAtSuccessVersion) {
        failed(error);
        return false;
      }
      return !current.down;
    }
  };
  const api = new Proxy(raw, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const startedAtSuccessVersion = successVersion;
        try {
          const result = await Reflect.apply(value, target, args);
          succeeded();
          return result;
        } catch (error) {
          const last = args.at(-1);
          const aborted = last instanceof AbortSignal && last.aborted;
          if (!aborted && !(error instanceof ApiError)
            && successVersion === startedAtSuccessVersion) failed(error);
          throw error;
        }
      };
    }
  }) as StoryApi;
  return {
    api,
    state: () => ({ ...current }),
    retryNow,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { if (timer !== null) clearTimeout(timer); listeners.clear(); }
  };
}

import { pushToast } from "./toasts.js";
import type { AppState } from "./state.js";
import type { Store } from "./store.js";

export const ACTIONS_FAILED_TOAST = "This part of the app did not load. Check the connection, then try again.";

type Fallbacks<T> = { readonly [K in keyof T]?: T[K] extends (...args: never[]) => infer R ? () => R : never };

/**
 * Actions whose code downloads at first use. The first call loads the module
 * and then runs; calls made before it arrives run in the order they were
 * made. A method that answers at once ("is there a run to stop?") lists a
 * `whenUnloaded` answer: before the module loads, nothing can be running.
 * A failed download is a toast, and the next call tries again.
 */
export function lazyActions<T extends object>(
  store: Store<AppState>,
  load: () => Promise<T>,
  whenUnloaded: Fallbacks<T> = {}
): T {
  return lazyActionsOf(lazyLoader(store, load), whenUnloaded);
}

export interface LazyLoader<T> {
  /** Starts the download if needed; a failure is a toast and a rejection. */
  readonly ensure: () => Promise<T>;
  readonly loaded: () => T | null;
}

export function lazyLoader<T>(store: Store<AppState>, load: () => Promise<T>): LazyLoader<T> {
  let loaded: T | null = null;
  let pending: Promise<T> | null = null;
  const ensure = (): Promise<T> => {
    pending ??= load().then(
      (module) => (loaded = module),
      (error: unknown) => {
        pending = null;
        pushToast(store, ACTIONS_FAILED_TOAST);
        throw error;
      }
    );
    return pending;
  };
  return { ensure, loaded: () => loaded };
}

const loaders = new WeakMap<object, LazyLoader<unknown>>();

/** Waits until the code behind these actions has loaded, so their methods run
 * at once. For a test that asserts right after a call. */
export async function loadLazyActions(...actions: readonly object[]): Promise<void> {
  await Promise.all(actions.map((one) => loaders.get(one)?.ensure()));
}

export function lazyActionsOf<T extends object>(loader: LazyLoader<T>, whenUnloaded: Fallbacks<T> = {}): T {
  const { ensure } = loader;
  const proxy = new Proxy({} as T, {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      return (...args: unknown[]): unknown => {
        const method = (module: T): unknown => (module as Record<string, (...a: unknown[]) => unknown>)[key]!(...args);
        const loaded = loader.loaded();
        if (loaded !== null) return method(loaded);
        const fallback = (whenUnloaded as Record<string, (() => unknown) | undefined>)[key];
        if (fallback !== undefined) return fallback();
        return ensure().then(method, () => undefined);
      };
    }
  });
  loaders.set(proxy, loader);
  return proxy;
}

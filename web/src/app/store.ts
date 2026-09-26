import { useSyncExternalStore } from "react";

/**
 * A hand-rolled store (~40 lines, no Zustand): one mutable cell, a listener
 * set, and `useSyncExternalStore` for the React binding. `set` always
 * receives the previous state and returns the next one, so a caller never
 * has to re-read `get()` mid-update to avoid clobbering a concurrent
 * change — there is no concurrency here (single-threaded, synchronous
 * dispatch), but the shape still rules out the mistake.
 */
export interface Store<S> {
  get(): S;
  set(update: (state: S) => S): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<S>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (update) => {
      const next = update(state);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

/** `select` should return an existing reference when nothing the caller
 * cares about changed (a sub-object of `state`, or `state` itself) — that is
 * what lets `useSyncExternalStore` skip a re-render, and is why actions
 * always replace the slice they change rather than mutating it in place. */
export function useStore<S, T>(store: Store<S>, select: (state: S) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}

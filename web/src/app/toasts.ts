import { apiErrorCode } from "../../../client/api-error.js";
import type { AppState, Toast } from "./state.js";
import type { Store } from "./store.js";

const TOAST_LIFETIME_MS = 6_000;
let nextToastId = 0;

export function pushToast(store: Store<AppState>, message: string): void {
  const id = `toast-${(nextToastId += 1)}`;
  const toast: Toast = { id, message };
  store.set((state) => ({ ...state, toasts: [...state.toasts, toast] }));
  setTimeout(() => dismissToast(store, id), TOAST_LIFETIME_MS);
}

export function dismissToast(store: Store<AppState>, id: string): void {
  store.set((state) => ({ ...state, toasts: state.toasts.filter((toast) => toast.id !== id) }));
}

/**
 * Runs `fn`; on failure, pushes a toast `"<label> failed: <message>"` and
 * rethrows, so a caller that also needs to react (keep a dialog open, skip a
 * navigation) still can — this never swallows the error, only reports it.
 */
export async function runAction<T>(
  store: Store<AppState>,
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    pushToast(store, `${label} failed: ${errorMessage(error)}`);
    throw error;
  }
}

/** `known` maps a `client/api-error.ts` `FailureCode` this call site expects
 * to a message in place of the raw one — used where the generic message
 * would be accurate but a specific code has a clearer, situation-aware
 * phrasing (e.g. deleting a story that is already gone). */
export function errorMessage(error: unknown, known: Readonly<Record<string, string>> = {}): string {
  const code = apiErrorCode(error);
  if (code !== null && code in known) return known[code]!;
  if (error instanceof Error) return error.message;
  return String(error);
}

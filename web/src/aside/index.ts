import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import { createAsideActions, type AsideActions } from "./actions.js";
import { createAsideUseActions, type AsideUseActions } from "./use-actions.js";

/** Aside's actions, the questions and the use of an answer, as one object. */
export function createAllAsideActions(
  store: Store<AppState>,
  deps: Parameters<typeof createAsideActions>[1] & Parameters<typeof createAsideUseActions>[1]
): AsideActions & AsideUseActions {
  return { ...createAsideActions(store, deps), ...createAsideUseActions(store, deps) };
}

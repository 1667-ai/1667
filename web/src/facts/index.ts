import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import { createFactEditorActions, type FactEditorActionDependencies, type FactEditorActions } from "./actions.js";
import { createFactListActions, type FactListActions } from "./list-actions.js";

export type FactActions = FactEditorActions & FactListActions;

/** The Facts view's actions: the editor's and the list's, as one object. */
export function createFactActions(store: Store<AppState>, deps: FactEditorActionDependencies): FactActions {
  const editor = createFactEditorActions(store, deps);
  const list = createFactListActions(store, { story: deps.story, editor });
  return { ...editor, ...list };
}

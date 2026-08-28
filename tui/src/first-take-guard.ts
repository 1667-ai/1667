import type { RuntimeState } from "./state.js";

export const UNCERTAIN_FIRST_TAKE_TOAST =
  "first take save is uncertain · reopen the story before retrying";

/** Block a retry from the retained first-take editor even when background
 * reconciliation has made the committed root visible. */
export function blockUncertainFirstTakeRetry(
  state: Pick<RuntimeState, "payload" | "toast" | "uncertainFirstTakeStoryId">
): boolean {
  if (state.uncertainFirstTakeStoryId !== state.payload.id) return false;
  state.toast = UNCERTAIN_FIRST_TAKE_TOAST;
  return true;
}

/** Block every root-creation path until a full story reopen resolves an
 * unknown manual first-take outcome. */
export function blockUncertainRootCreation(
  state: Pick<RuntimeState, "payload" | "toast" | "uncertainFirstTakeStoryId">
): boolean {
  return state.payload.path.length === 0 && blockUncertainFirstTakeRetry(state);
}

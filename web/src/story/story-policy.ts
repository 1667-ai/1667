import type { AppState } from "../app/state.js";
import { lockedToast, storyRunLocked } from "../app/run-lock.js";

/**
 * Refusals that belong to the story as a whole, not to one part: the tag and
 * chapter saves ask here (`story/part-policy.ts` asks for the part actions).
 * Pure, like the part policy: it returns the toast, or `null`.
 */

export const NOT_CONNECTED_TOAST = "Not connected.";
export const SUMMARY_EDITOR_OPEN_TOAST = "Finish or cancel the summary edit first.";
export const LAST_CHAPTER_RAW_TOAST = "The last chapter stays raw until it ends.";

/** Why a change to the story `storyId` is refused right now: no connection,
 * or a run that holds the story. A refused save keeps its draft. */
export function storyChangeRefusal(state: AppState, storyId: string): string | null {
  if (state.connection.kind !== "connected") return NOT_CONNECTED_TOAST;
  return storyRunLocked(state, storyId) ? lockedToast(state, storyId) : null;
}

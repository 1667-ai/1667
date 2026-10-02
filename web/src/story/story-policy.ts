import type { AppState } from "../app/state.js";
import { lockedToast, runBusyToast, storyRunLocked } from "../app/run-lock.js";
import { editorDirty } from "../editor/state.js";

/**
 * Refusals that belong to the story as a whole, not to one part: the tag and
 * chapter saves ask here (`story/part-policy.ts` asks for the part actions).
 * Pure, like the part policy: it returns the toast, or `null`.
 */

export const NOT_CONNECTED_TOAST = "Not connected.";
export const SUMMARY_EDITOR_OPEN_TOAST = "Finish or cancel the summary edit first.";
export const SWITCHING_TOAST = "A take is still switching. Try again in a moment.";
export const LAST_CHAPTER_RAW_TOAST = "The last chapter stays raw until it ends.";

/** Why a change to the story `storyId` is refused right now: no connection,
 * or a run that holds the story. A refused save keeps its draft. */
export function storyChangeRefusal(state: AppState, storyId: string): string | null {
  if (state.connection.kind !== "connected") return NOT_CONNECTED_TOAST;
  return storyRunLocked(state, storyId) ? lockedToast(state, storyId) : null;
}

/** Why a chapter summary may not start right now, or `null`. A summary needs
 * a closed chapter ("The last chapter stays raw until it ends."), a free run
 * slot, no half-edited summary, and no take switch in flight. */
export function summarizeRefusal(state: AppState, storyId: string, chapter: { readonly closed: boolean }): string | null {
  if (state.connection.kind !== "connected") return NOT_CONNECTED_TOAST;
  if (!chapter.closed) return LAST_CHAPTER_RAW_TOAST;
  const busy = runBusyToast(state, storyId);
  if (busy !== null) return busy;
  if (state.editor?.mode === "summary" && editorDirty(state.editor)) return SUMMARY_EDITOR_OPEN_TOAST;
  return state.story.kind === "loaded" && state.story.switching !== null ? SWITCHING_TOAST : null;
}

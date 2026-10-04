import { generationLocks } from "../generation/state.js";
import type { AppState } from "./state.js";

/**
 * Whether something is running that owns a story: a generation (writing into
 * it, or holding unsaved text for it) or a chapter summary. Pure — it reads
 * `AppState` and returns the toast to show. `story/part-policy.ts`, the
 * generation start, the tag and chapter saves, and the bottom bar all ask
 * here, so they can never disagree about what is busy.
 */

/** A generation or a summary is writing into, or saving into, this story. */
export const STORY_LOCKED_TOAST = "Writing… Esc stops it first.";
export const SUMMARY_LOCKED_TOAST = "Summarizing… Esc stops it first.";

/** An Aside answer is being written, or an Aside session change is saving. */
export const ASIDE_LOCKED_TOAST = "Aside is answering… Esc stops it first.";

/** A generation's text is not saved yet; nothing may start or remove the
 * part it hangs below until the writer retries or discards it. */
export const UNSAVED_TOAST = "The last text is not saved yet. Retry or discard it first.";

/** True while a generation is running or settling in `storyId`, or a chapter
 * summary is running there. `"unsaved"` text does not lock: nothing is
 * running any more. */
export function storyRunLocked(state: AppState, storyId: string): boolean {
  return generationLocks(state.generation, storyId)
    || state.chapters.summaryRun?.storyId === storyId
    || state.aside.run?.storyId === storyId;
}

/** The toast for a change refused because `storyId` is locked. */
export function lockedToast(state: AppState, storyId: string): string {
  if (generationLocks(state.generation, storyId)) return STORY_LOCKED_TOAST;
  if (state.chapters.summaryRun?.storyId === storyId) return SUMMARY_LOCKED_TOAST;
  return state.aside.run?.storyId === storyId ? ASIDE_LOCKED_TOAST : STORY_LOCKED_TOAST;
}

/** Why a start of a run in `storyId` is refused by a run that already exists
 * (in any story), or `null` when none does. */
export function runBusyToast(state: AppState, storyId: string): string | null {
  const generation = state.generation;
  if (generation.kind !== "idle") {
    if (generation.storyId !== storyId) return `Already writing in ${generation.storyTitle}. Esc stops it.`;
    return generation.kind === "unsaved" ? UNSAVED_TOAST : STORY_LOCKED_TOAST;
  }
  const run = state.chapters.summaryRun;
  if (run !== null) {
    return run.storyId === storyId ? SUMMARY_LOCKED_TOAST : `Already summarizing in ${run.storyTitle}. Esc stops it.`;
  }
  const aside = state.aside.run;
  if (aside === null) return null;
  return aside.storyId === storyId ? ASIDE_LOCKED_TOAST : `Aside is answering in ${aside.storyTitle}. Esc stops it.`;
}

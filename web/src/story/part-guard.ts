import type { StoryState } from "./state.js";

type LoadedStoryState = Extract<StoryState, { kind: "loaded" }>;

/** Shown when a part action meets a part the reader is still switching
 * takes on, or that sits below such a part. */
export const PART_SWITCHING_TOAST = "A take is still switching. Try again in a moment.";

/** Shown when `e` meets the leaf a Continue is still appending to. */
export const PART_WRITING_TOAST = "This part is still being written.";

/** A part below a pending switch belongs to the line that switch replaces;
 * switching it would queue a take on a branch that is about to disappear
 * (and, once the ancestor lands, restore it). The mouse controls are
 * disabled there; keys get the same rule. */
export function belowPendingSwitch(story: LoadedStoryState, partId: string): boolean {
  if (story.switching === null || story.switching.partId === partId) return false;
  const path = story.payload.path;
  const anchor = path.findIndex((node) => node.id === story.switching!.partId);
  const target = path.findIndex((node) => node.id === partId);
  return anchor >= 0 && target > anchor;
}

/** True while a take switch is in flight on this part or above it. */
export function partSwitchPending(story: LoadedStoryState, partId: string): boolean {
  return story.switching !== null && (story.switching.partId === partId || belowPendingSwitch(story, partId));
}

/** The toast a change to this part is refused with, or `null` when it may
 * go ahead. `locked` is true while a generation is writing (or saving) in
 * this story; a take switch in flight refuses for the same reason a second
 * switch does — the part may be about to change under the change. */
export function partChangeRefusal(
  story: LoadedStoryState,
  partId: string,
  locked: boolean,
  lockedToast: string
): string | null {
  if (locked) return lockedToast;
  if (partSwitchPending(story, partId)) return PART_SWITCHING_TOAST;
  return null;
}

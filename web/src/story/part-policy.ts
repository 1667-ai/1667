import { continuationIntent } from "../../../shared/continuation-intent.js";
import { chapterWord } from "../../../shared/chapter-labels.js";
import { createManuscriptModel } from "../../../shared/manuscript-model.js";
import type { PartActionId } from "../../../shared/part-actions.js";
import { runBusyToast, storyRunLocked, lockedToast, STORY_LOCKED_TOAST, UNSAVED_TOAST } from "../app/run-lock.js";
import type { AppState } from "../app/state.js";
import type { GenerationPlan } from "../generation/plan.js";
import { appendingTo } from "../generation/state.js";
import { editorDirty, inPartSlot } from "../editor/state.js";
import type { LineSwitch } from "./line-switch.js";
import { effectiveFocusedPartId, type StoryState } from "./state.js";
import { NOT_CONNECTED_TOAST, SWITCHING_TOAST as PART_SWITCHING_TOAST } from "./story-policy.js";

export { STORY_LOCKED_TOAST, UNSAVED_TOAST, NOT_CONNECTED_TOAST, PART_SWITCHING_TOAST };

/** The part actions the web UI has: the TUI's, plus the ones that are only
 * web-local (`C` ends a chapter at the part). */
export type WebPartActionId = PartActionId | "end-chapter";

/**
 * The one policy for what a part action may do right now — read by the keys,
 * the `···` menu, the composer, and the generation start, so they can never
 * disagree. It is pure: it reads `AppState` and returns the toast to show, or
 * `null` when the action may go ahead. The order of the checks is fixed (see
 * `partActionRefusal`), and every toast the writing loop refuses with lives
 * in this file.
 */

type LoadedStoryState = Extract<StoryState, { kind: "loaded" }>;

export const PART_UNAVAILABLE_TOAST = "That part is no longer on the story line.";
export const PART_WRITING_TOAST = "This part is still being written.";
export const SUMMARY_RETAKE_TOAST = "Summaries are rewritten, not retaken.";
export const EDITOR_OPEN_TOAST = "Finish or cancel the open editor first.";
export const LINE_GONE_TOAST = "That line is no longer there. The story was reloaded.";

/** Shown when a retake's part left the line (or became a summary) between
 * the writer opening the retake and sending it. */
export const RETAKE_GONE_TOAST = "That part is no longer available to retake. Draft kept.";

/** A part below a pending switch belongs to the line that switch replaces;
 * switching it would queue a take on a branch that is about to disappear
 * (and, once the ancestor lands, restore it). */
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

/** True when the open editor sits in `partId` or in a part below it on the
 * line, so a switch, retake, or delete of `partId` would take the edited part
 * away. */
export function editorBlocksChange(state: AppState, partId: string): boolean {
  const editor = state.editor;
  const story = state.story;
  if (editor === null || story.kind !== "loaded" || editor.storyId !== story.payload.id || !inPartSlot(editor)) {
    return false;
  }
  const path = story.payload.path;
  const editorIndex = path.findIndex((node) => node.id === editor.base.id);
  const changeIndex = path.findIndex((node) => node.id === partId);
  return editorIndex >= 0 && changeIndex >= 0 && editorIndex >= changeIndex;
}

/**
 * Whether a planned generation would replace or change the part an open
 * editor sits in. A retake hides the retaken part and everything below it; a
 * take from the middle hides what follows the focused part; an append changes
 * the leaf. The generation start asks this twice — before it begins and
 * after its async preparation — so an editor opened in between is respected.
 */
export function generationEditorRefusal(
  state: AppState,
  plan: { readonly focusedPartId: string | null; readonly instruction: string; readonly retakeOf?: string }
): string | null {
  const editor = state.editor;
  const story = state.story;
  if (editor === null || story.kind !== "loaded" || editor.storyId !== story.payload.id) return null;
  // The first-part editor sits where the first generated part would stream:
  // a changed one is never hidden by it.
  if (!inPartSlot(editor)) return editorDirty(editor) ? EDITOR_OPEN_TOAST : null;
  const path = story.payload.path;
  const editorIndex = path.findIndex((node) => node.id === editor.base.id);
  if (editorIndex < 0) return null;
  if (plan.retakeOf !== undefined) {
    const retakeIndex = path.findIndex((node) => node.id === plan.retakeOf);
    return retakeIndex >= 0 && editorIndex >= retakeIndex ? EDITOR_OPEN_TOAST : null;
  }
  const intent = continuationIntent(story.payload, plan.focusedPartId, plan.instruction);
  if (intent.appendLast) return editorIndex === path.length - 1 ? EDITOR_OPEN_TOAST : null;
  if (intent.fromSeam) return editorIndex > intent.focusPathIndex ? EDITOR_OPEN_TOAST : null;
  return null;
}

/**
 * The same question as `generationEditorRefusal`, asked of the plan a start
 * actually built: its target and the seam it hides everything after. The start
 * asks it after its async preparation, so what is checked is what will run —
 * not a plan recomputed from wherever focus has moved to meanwhile.
 */
export function planEditorRefusal(
  state: AppState,
  storyId: string,
  plan: Pick<GenerationPlan, "target" | "seamPathIndex">
): string | null {
  const editor = state.editor;
  const story = state.story;
  if (editor === null || story.kind !== "loaded" || story.payload.id !== storyId || editor.storyId !== storyId) {
    return null;
  }
  if (!inPartSlot(editor)) return editorDirty(editor) ? EDITOR_OPEN_TOAST : null;
  const path = story.payload.path;
  const editorIndex = path.findIndex((node) => node.id === editor.base.id);
  if (editorIndex < 0) return null;
  if (plan.target.mode === "append") {
    const appendIndex = path.findIndex((node) => node.id === (plan.target as { appendTo: string }).appendTo);
    return editorIndex === appendIndex ? EDITOR_OPEN_TOAST : null;
  }
  return editorIndex > plan.seamPathIndex ? EDITOR_OPEN_TOAST : null;
}

/**
 * The toast a part action is refused with right now, or `null`. The checks
 * run in this fixed order, and the first one that applies wins:
 *
 * 1. the part is not on the open story's line;
 * 2. a summary is never retaken;
 * 3. the connection (actions that change the story at once);
 * 4. a generation: Continue, Retake, and Delete wait for one that exists
 *    (Delete only for one in this story, including unsaved text, which hangs
 *    below the part); Edit waits for the leaf being appended;
 * 5. a take switch in flight on the part or above it (not for Direct);
 * 6. the editor: a change that would take the edited part away, or opening a
 *    second editor over a changed one.
 */
export function partActionRefusal(state: AppState, partId: string, action: WebPartActionId): string | null {
  const story = state.story;
  if (state.route.kind !== "story" || story.kind !== "loaded" || story.payload.id !== state.route.id) {
    return PART_UNAVAILABLE_TOAST;
  }
  const storyId = story.payload.id;
  const node = story.payload.path.find((candidate) => candidate.id === partId);
  if (node === undefined) return PART_UNAVAILABLE_TOAST;

  if (node.role === "summary" && (action === "retake" || action === "retake-with-prompt")) {
    return SUMMARY_RETAKE_TOAST;
  }
  const changesNow = action === "continue" || action === "retake" || action === "prune" || action === "end-chapter";
  if (changesNow && state.connection.kind !== "connected") return NOT_CONNECTED_TOAST;

  if (action === "continue" || action === "retake") {
    const busy = runBusyToast(state, storyId);
    if (busy !== null) return busy;
  } else if (action === "prune" && (state.generation.kind !== "idle" && state.generation.storyId === storyId
    || state.chapters.summaryRun?.storyId === storyId)) {
    return runBusyToast(state, storyId);
  } else if (action === "end-chapter" && storyRunLocked(state, storyId)) {
    return lockedToast(state, storyId);
  } else if (action === "edit" && appendingTo(state.generation, storyId) === partId) {
    return PART_WRITING_TOAST;
  }

  if (action !== "direct" && partSwitchPending(story, partId)) return PART_SWITCHING_TOAST;

  switch (action) {
    case "continue":
      return generationEditorRefusal(state, { focusedPartId: partId, instruction: "" });
    case "retake":
      return generationEditorRefusal(state, { focusedPartId: partId, instruction: "", retakeOf: partId });
    case "retake-with-prompt":
    case "prune":
      return editorBlocksChange(state, partId) ? EDITOR_OPEN_TOAST : null;
    case "write":
    case "edit": {
      const editor = state.editor;
      if (editor !== null && inPartSlot(editor) && editor.base.id === partId) return null;
      return editor !== null && editorDirty(editor) ? EDITOR_OPEN_TOAST : null;
    }
    case "end-chapter": {
      const chapter = createManuscriptModel(story.payload).chapters.find((candidate) =>
        candidate.closedBy?.parentPartId === partId);
      return chapter === undefined ? null : `Chapter ${chapterWord(chapter.number)} already ends here.`;
    }
    default:
      return null;
  }
}

/**
 * The toast a switch to another line is refused with right now, or `null`.
 * Fixed order, first match wins: the story is not open; not connected; a
 * generation writing into (or saving into) this story; a switch already in
 * flight; the open editor sits on a part the switch replaces (skipped when the
 * line only grows past its leaf).
 */
export function lineSwitchRefusal(state: AppState, plan: LineSwitch): string | null {
  const story = state.story;
  if (state.route.kind !== "story" || story.kind !== "loaded" || story.payload.id !== state.route.id) {
    return PART_UNAVAILABLE_TOAST;
  }
  if (state.connection.kind !== "connected") return NOT_CONNECTED_TOAST;
  if (storyRunLocked(state, story.payload.id)) return lockedToast(state, story.payload.id);
  if (story.switching !== null) return PART_SWITCHING_TOAST;
  if (!plan.extendsLeaf && editorBlocksChange(state, plan.anchorId)) return EDITOR_OPEN_TOAST;
  return null;
}

/** The part Space continues from: the focused part, or `null` on an empty
 * story. Exported so every caller derives it the same way. */
export function focusedPartOf(state: AppState): string | null {
  return state.story.kind === "loaded" ? effectiveFocusedPartId(state.story) : null;
}

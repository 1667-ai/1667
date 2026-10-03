import { chapterWord } from "../../../shared/chapter-labels.js";
import { manuscriptModelOf } from "../story/manuscript-model.js";
import type { StoryNode } from "../../../shared/types.js";
import type { EditorSaveRequest } from "./save.js";
import type { AppState } from "../app/state.js";

/**
 * The one inline editor the web UI can have open (#409 step 6), kept in the
 * store so the draft survives a re-render, a route change, and a failed save.
 *
 * - `edit` (`e`): changes an existing part. `base` is the part as it was when
 *   the editor opened, and is replaced by the reloaded part after a conflict.
 * - `write` (`w`): the writer's own take, a sibling of `base`, whose slot it
 *   sits in. Empty when it opens.
 * - `first` (`w` on an empty story): the first part. It has no `base`.
 * - `summary`: a chapter's summary text, edited in the summary card. It has
 *   no `base` either: it is not a part of the line.
 */
interface EditorFields {
  readonly storyId: string;
  readonly text: string;
  readonly instruction: string;
  readonly saving: boolean;
  /** A conflict reloaded the part; the next Save overwrites the new text. */
  readonly overwriteArmed: boolean;
  /** The first Escape on a changed editor; the second one discards. */
  readonly discardArmed: boolean;
  /** A create that may have committed, whose check could not finish. The next
   * Save settles it before it sends anything, so the text is never written
   * twice. */
  readonly pending: EditorSaveRequest | null;
}

/** The summary being edited, as it was when the editor opened (`text` is
 * replaced by the reloaded one after a conflict). */
export interface SummaryTarget {
  readonly id: string;
  readonly breakId: string;
  readonly chapterNumber: number;
  readonly text: string;
}

export type EditorState =
  | (EditorFields & { readonly mode: "edit" | "write"; readonly base: StoryNode })
  | (EditorFields & { readonly mode: "first" })
  | (EditorFields & { readonly mode: "summary"; readonly summary: SummaryTarget });

/** The editors that sit in a part's slot (`edit` and `write`). */
export type PartSlotEditor = Extract<EditorState, { readonly base: StoryNode }>;

export function inPartSlot(editor: EditorState): editor is PartSlotEditor {
  return editor.mode === "edit" || editor.mode === "write";
}

export function openSummaryEditorState(storyId: string, summary: SummaryTarget): EditorState {
  return {
    storyId, saving: false, overwriteArmed: false, discardArmed: false, pending: null,
    mode: "summary", summary, text: summary.text, instruction: ""
  };
}

/** One way to open an editor: `node` is the part to edit, or the part to write
 * next to; it is `null` only for `first`. */
export function openEditorState(
  storyId: string,
  mode: Exclude<EditorState["mode"], "summary">,
  node: StoryNode | null
): EditorState {
  const fields = { storyId, saving: false, overwriteArmed: false, discardArmed: false, pending: null };
  if (mode === "first" || node === null) return { ...fields, mode: "first", text: "", instruction: "" };
  return {
    ...fields,
    mode,
    base: node,
    text: mode === "edit" ? node.text : "",
    instruction: mode === "edit" ? node.instruction : ""
  };
}

/** The part whose slot the editor sits in; `null` for `first`. */
export function editorPartId(editor: EditorState | null): string | null {
  return editor === null || !inPartSlot(editor) ? null : editor.base.id;
}

/** True when the writer has typed something that Cancel would throw away. */
export function editorDirty(editor: EditorState): boolean {
  if (editor.mode === "summary") return editor.text !== editor.summary.text;
  if (editor.mode === "edit") {
    return editor.text !== editor.base.text || editor.instruction !== editor.base.instruction;
  }
  return editor.text.trim().length > 0;
}

/** The title above the editor. */
export function editorTitle(editor: EditorState, partNumber: number): string {
  if (editor.mode === "edit") return `Edit part ${partNumber}`;
  if (editor.mode === "first") return "Your first part";
  if (editor.mode === "summary") return `Edit Chapter ${chapterWord(editor.summary.chapterNumber)} summary`;
  return `Your take of part ${partNumber}`;
}

/** True when the open editor belongs to `storyId`, but has no slot on that
 * story's line any more: the part it sits in left the line (another window
 * deleted it or switched the line away), or it was the first-part editor and
 * the story now has parts. The editor keeps the writer's text;
 * `EditorRecovery` shows it. */
export function editorIsOffLine(state: AppState, storyId: string): boolean {
  const editor = state.editor;
  if (editor === null || editor.storyId !== storyId) return false;
  if (state.story.kind !== "loaded" || state.story.payload.id !== storyId) return false;
  const path = state.story.payload.path;
  if (editor.mode === "first") return path.length > 0;
  if (editor.mode === "summary") {
    // The summary has a card only while its chapter is closed and it stands in.
    const id = editor.summary.id;
    return !manuscriptModelOf(state.story.payload).chapters.some((chapter) => chapter.summary?.id === id);
  }
  return !path.some((node) => node.id === editor.base.id);
}

/** Everything the editor holds, as one text to copy: the direction (when it
 * has one) above the prose. */
export function editorCopyText(editor: EditorState): string {
  return editor.mode === "edit" && editor.instruction.length > 0
    ? `Direction: ${editor.instruction}\n\n${editor.text}`
    : editor.text;
}

import type { StoryNode } from "../../../shared/types.js";

/**
 * The one inline editor the web UI can have open (#409 step 6), kept in the
 * store so the draft survives a re-render, a route change, and a failed save.
 *
 * - `edit` (`e`): changes an existing part. `base` is the part as it was when
 *   the editor opened, and is replaced by the reloaded part after a conflict.
 * - `write` (`w`): the writer's own take, a sibling of the part whose slot it
 *   sits in. Empty when it opens.
 * - `first` (`w` on an empty story): the first part.
 */
export type EditorMode = "edit" | "write" | "first";

export interface EditorState {
  readonly storyId: string;
  readonly mode: EditorMode;
  /** The part whose slot the editor sits in; `null` for `first`. */
  readonly partId: string | null;
  /** `edit`: the part to change. `write`: the part the new take is a sibling
   * of. `first`: `null`. */
  readonly base: StoryNode | null;
  readonly text: string;
  readonly instruction: string;
  readonly saving: boolean;
  /** A conflict reloaded the part; the next Save overwrites the new text. */
  readonly overwriteArmed: boolean;
  /** The first Escape on a changed editor; the second one discards. */
  readonly discardArmed: boolean;
}

export function openEditorState(
  storyId: string,
  mode: EditorMode,
  base: StoryNode | null
): EditorState {
  return {
    storyId,
    mode,
    partId: base === null ? null : base.id,
    base,
    text: mode === "edit" ? base?.text ?? "" : "",
    instruction: mode === "edit" ? base?.instruction ?? "" : "",
    saving: false,
    overwriteArmed: false,
    discardArmed: false
  };
}

/** True when the writer has typed something that Cancel would throw away. */
export function editorDirty(editor: EditorState): boolean {
  if (editor.mode === "edit") {
    return editor.text !== (editor.base?.text ?? "") || editor.instruction !== (editor.base?.instruction ?? "");
  }
  return editor.text.trim().length > 0;
}

/** The title above the editor. */
export function editorTitle(editor: EditorState, partNumber: number): string {
  if (editor.mode === "edit") return `Edit part ${partNumber}`;
  if (editor.mode === "first") return "Your first part";
  return `Your take of part ${partNumber}`;
}

/** Shown when a change would remove or replace the part an open editor sits
 * in. The writer finishes or cancels the editor first. */
export const EDITOR_OPEN_TOAST = "Finish or cancel the open editor first.";

/** True when `editor` sits in `partId` or in a part below it on the line, so a
 * switch, retake, or delete of `partId` would take the edited part away. */
export function editorBlocksChange(
  editor: EditorState | null,
  storyId: string,
  path: readonly StoryNode[],
  partId: string
): boolean {
  if (editor === null || editor.storyId !== storyId || editor.partId === null) return false;
  const editorIndex = path.findIndex((node) => node.id === editor.partId);
  const changeIndex = path.findIndex((node) => node.id === partId);
  return editorIndex >= 0 && changeIndex >= 0 && editorIndex >= changeIndex;
}

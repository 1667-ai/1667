import type { StoryNode } from "../../../shared/types.js";
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
}

export type EditorState =
  | (EditorFields & { readonly mode: "edit" | "write"; readonly base: StoryNode })
  | (EditorFields & { readonly mode: "first" });

/** One way to open an editor: `node` is the part to edit, or the part to write
 * next to; it is `null` only for `first`. */
export function openEditorState(
  storyId: string,
  mode: EditorState["mode"],
  node: StoryNode | null
): EditorState {
  const fields = { storyId, saving: false, overwriteArmed: false, discardArmed: false };
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
  return editor === null || editor.mode === "first" ? null : editor.base.id;
}

/** True when the writer has typed something that Cancel would throw away. */
export function editorDirty(editor: EditorState): boolean {
  if (editor.mode === "edit") {
    return editor.text !== editor.base.text || editor.instruction !== editor.base.instruction;
  }
  return editor.text.trim().length > 0;
}

/** The title above the editor. */
export function editorTitle(editor: EditorState, partNumber: number): string {
  if (editor.mode === "edit") return `Edit part ${partNumber}`;
  if (editor.mode === "first") return "Your first part";
  return `Your take of part ${partNumber}`;
}

/** True when the open editor belongs to `storyId`, but the part it sits in is
 * no longer on that story's line — another window deleted it, or switched the
 * line away. The editor keeps the writer's text; `EditorRecovery` shows it. */
export function editorIsOffLine(state: AppState, storyId: string): boolean {
  const id = state.editor !== null && state.editor.storyId === storyId ? editorPartId(state.editor) : null;
  return id !== null && state.story.kind === "loaded" && state.story.payload.id === storyId
    && !state.story.payload.path.some((node) => node.id === id);
}

import { clampAuthorsNoteDepth } from "../../shared/authors-note.js";
import type { ResolvedKey } from "./keys.js";
import type { DocumentEditorSession } from "./state.js";

/** Author's Note grammar owns the depth control, so the editor dispatcher
 *  stays target-agnostic. Returns false when this target or this key is not
 *  its business. */
export function handleAuthorsNoteCommand(
  resolved: ResolvedKey,
  editor: DocumentEditorSession
): boolean {
  if (resolved.action !== "note-depth-decrease" && resolved.action !== "note-depth-increase") {
    return false;
  }
  if (editor.kind !== "document" || editor.target.kind !== "authors-note") return false;
  const delta = resolved.action === "note-depth-decrease" ? -1 : 1;
  editor.target.depth = clampAuthorsNoteDepth(editor.target.depth + delta);
  return true;
}

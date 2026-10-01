import type { ReferenceBinding } from "../../../shared/reference-bindings.js";
import { activatesOnEnterOrSpace } from "../app/keymap-dom.js";
import type { ContentActions } from "../app/content-actions.js";
import { effectiveFocusedPartId, type StoryState } from "./state.js";

/**
 * The writing keys of the manuscript: the TUI's `r`, `R`, `w`, `e`, `x`, `D`,
 * and Enter / `i`. `StoryView.tsx` calls this for every binding it does not
 * handle itself, so the screen keeps its reading keys and this file keeps
 * the keys that change the story. Returns whether the key was handled.
 *
 * A held key never repeats an action: the first press acts, and the rest
 * are ignored. A focused button keeps Enter for its own click.
 */
export function handleWritingKey(
  binding: ReferenceBinding,
  event: KeyboardEvent,
  story: Extract<StoryState, { kind: "loaded" }>,
  actions: ContentActions
): boolean {
  if (event.repeat) return false;
  const partId = effectiveFocusedPartId(story);
  switch (binding.action) {
    case "compose":
      // Enter on a focused button or link keeps its own meaning (a take
      // arrow activates). `preventDefault` (via the return) keeps an `i`
      // from being typed into the box it opens.
      if (activatesOnEnterOrSpace()) return false;
      actions.compose.requestFocus();
      return true;
    case "write":
      // An empty story has no focused part: `w` writes part 1.
      actions.editor.openWrite(partId);
      return true;
    case "edit":
      if (partId === null) return false;
      actions.editor.openEdit(partId);
      return true;
    case "retake-with-prompt":
      if (partId === null) return false;
      actions.compose.startRetake(partId);
      return true;
    case "regenerate":
      if (partId === null) return false;
      actions.part.retake(partId);
      return true;
    default:
      return false;
  }
}

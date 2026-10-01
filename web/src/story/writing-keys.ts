import type { ReferenceBinding } from "../../../shared/reference-bindings.js";
import type { PartActionId } from "../../../shared/part-actions.js";
import type { ContentActions } from "../app/content-actions.js";
import { activatesOnEnterOrSpace } from "../app/keymap-dom.js";
import { focusComposer } from "../compose/dom.js";
import { effectiveFocusedPartId, type StoryState } from "./state.js";

/** The TUI key actions that are one part action each. */
const PART_ACTION_OF_KEY: Readonly<Record<string, PartActionId>> = {
  "regenerate": "retake",
  "retake-with-prompt": "retake-with-prompt",
  "write": "write",
  "edit": "edit",
  "prune": "prune"
};

/**
 * The writing keys of the manuscript: the TUI's `r`, `R`, `w`, `e`, `x`, `D`,
 * and Enter / `i`. `StoryView.tsx` calls this for every binding it does not
 * handle itself, so the screen keeps its reading keys and this file keeps
 * the keys that change the story. It only maps a key to a part action and
 * hands it to `actions.part.run`, which asks the one policy. Returns whether
 * the key was handled.
 *
 * A held key never repeats an action: the first press acts, and the rest
 * are ignored. A focused button keeps Enter for its own click; `i` is not
 * Enter, so it always reaches the composer.
 */
export function handleWritingKey(
  binding: ReferenceBinding,
  event: KeyboardEvent,
  story: Extract<StoryState, { kind: "loaded" }>,
  actions: ContentActions
): boolean {
  if (event.repeat) return false;
  const partId = effectiveFocusedPartId(story);
  if (binding.action === "compose") {
    if (event.key === "Enter" && activatesOnEnterOrSpace()) return false;
    focusComposer();
    return true;
  }
  if (binding.action === "write" && partId === null) {
    // An empty story has no focused part: `w` writes part 1.
    actions.editor.openWrite(null);
    return true;
  }
  if (partId === null) return false;
  if (binding.action === "open-actions") {
    actions.part.openMenu(partId);
    return true;
  }
  const id = PART_ACTION_OF_KEY[binding.action];
  if (id === undefined) return false;
  actions.part.run(id, partId);
  return true;
}

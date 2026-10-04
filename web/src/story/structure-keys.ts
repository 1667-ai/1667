import type { ReferenceBinding } from "../../../shared/reference-bindings.js";
import type { ContentActions } from "../app/content-actions.js";
import { effectiveFocusedPartId, type StoryState } from "./state.js";

/** The key actions this file handles; keys help lists only handled actions. */
export const STRUCTURE_KEY_ACTIONS: readonly string[] = [
  "tag", "create-chapter", "open-chapters", "open-facts", "open-aside", "toggle-rail", "undo"
];

/**
 * The keys that change the story's structure rather than its prose: the TUI's
 * `t` (tag the line), `C` (end the chapter here), `c`, `f` and `a` (the chapters, facts and Aside panels), `F` (dock the facts panel),
 * and `u` (undo a chapter-break change). `writing-keys.ts` hands every binding
 * it does not own to this file. The part actions go through `actions.part.run`
 * and so through the one policy; the panel and the undo have no part.
 * Returns whether the key was handled.
 */
export function handleStructureKey(
  binding: ReferenceBinding,
  story: Extract<StoryState, { kind: "loaded" }>,
  actions: ContentActions
): boolean {
  const partId = effectiveFocusedPartId(story);
  switch (binding.action) {
    case "tag":
      if (partId === null) return false;
      actions.part.run("tag", partId);
      return true;
    case "create-chapter":
      if (partId === null) return false;
      actions.part.run("end-chapter", partId);
      return true;
    case "open-chapters":
      actions.panel.open("chapters");
      return true;
    case "open-facts":
      actions.panel.open("facts");
      return true;
    case "open-aside":
      actions.aside.open();
      return true;
    case "toggle-rail":
      actions.panel.toggleFactsDock();
      return true;
    case "undo":
      void actions.chapters.undo();
      return true;
    default:
      return false;
  }
}

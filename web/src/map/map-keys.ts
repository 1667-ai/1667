import type { ReferenceBinding } from "../../../shared/reference-bindings.js";
import type { StoryPayload } from "../../../shared/types.js";
import { movePathCursor } from "../../../shared/path-layout.js";
import { acrossTreeCursor, moveTreeCursor, type MapViewKind, type PathModel, type TreeModel } from "./map-view-model.js";

/** What a map key needs to know, read fresh on every key press. */
export interface MapKeyContext {
  readonly view: MapViewKind;
  readonly payload: StoryPayload;
  readonly tree: TreeModel | null;
  readonly path: PathModel | null;
  /** The cursor's node id (the row id of a tree row that stands for a node). */
  readonly cursorId: string | null;
  readonly showSketches: boolean;
  readonly setCursor: (nodeId: string) => void;
  readonly toggleView: () => void;
  readonly toggleSketches: () => void;
  readonly act: () => void;
  readonly close: () => void;
}

/** The key actions `handleMapKey` handles; keys help lists only handled actions. */
export const MAP_KEY_ACTIONS: readonly string[] = [
  "cancel", "cycle-map-view", "toggle-sketches", "toggle-path-takes", "apply",
  "focus-next", "focus-previous", "take-next", "take-previous"
];

/** The map's keys, after `keymap-dom.ts` resolved them through the TUI's MAP
 * table. Returns whether the key was used (and so should not scroll the list
 * or do anything else natively). */
export function handleMapKey(binding: ReferenceBinding, ctx: MapKeyContext): boolean {
  switch (binding.action) {
    case "cancel": ctx.close(); return true;
    case "cycle-map-view": ctx.toggleView(); return true;
    case "toggle-sketches":
    case "toggle-path-takes": ctx.toggleSketches(); return true;
    case "apply": ctx.act(); return true;
    case "focus-next":
    case "focus-previous": {
      if (ctx.cursorId === null) return true;
      const direction = binding.action === "focus-next" ? 1 : -1;
      if (ctx.view === "tree" && ctx.tree !== null) ctx.setCursor(moveTreeCursor(ctx.tree, ctx.cursorId, direction));
      else if (ctx.view === "path") ctx.setCursor(movePathCursor(ctx.payload, ctx.cursorId, direction, 0, ctx.showSketches));
      return true;
    }
    case "take-next":
    case "take-previous": {
      if (ctx.cursorId === null) return true;
      const direction = binding.action === "take-next" ? 1 : -1;
      if (ctx.view === "tree" && ctx.tree !== null) {
        const across = acrossTreeCursor(ctx.tree, ctx.cursorId, direction);
        if (across !== null) ctx.setCursor(across);
      } else if (ctx.view === "path") {
        ctx.setCursor(movePathCursor(ctx.payload, ctx.cursorId, 0, direction, ctx.showSketches));
      }
      return true;
    }
    default: return false;
  }
}

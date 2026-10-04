import type { ReferenceBinding } from "../../../shared/reference-bindings.js";
import type { StoryPayload } from "../../../shared/types.js";
import { movePathCursor } from "../../../shared/path-layout.js";
import {
  acrossTreeCursor,
  moveMassCursor,
  moveTreeCursor,
  type MapViewKind,
  type MassModel,
  type PathModel,
  type TreeModel
} from "./map-view-model.js";

/** What a map key needs to know, read fresh on every key press. */
export interface MapKeyContext {
  readonly view: MapViewKind;
  readonly payload: StoryPayload;
  readonly tree: TreeModel | null;
  readonly path: PathModel | null;
  readonly mass: MassModel | null;
  /** True while the Fact lens is open: Esc, Tab and Enter mean the lens's own. */
  readonly lensActive: boolean;
  /** The cursor's node id (the row id of a tree row that stands for a node). */
  readonly cursorId: string | null;
  readonly showSketches: boolean;
  readonly setCursor: (nodeId: string) => void;
  readonly toggleView: () => void;
  readonly toggleSketches: () => void;
  readonly act: () => void;
  readonly close: () => void;
  /** `Tab` in the tree: hides the lanes, opening the cursor's row in the path view. */
  readonly hideLanes: () => void;
  /** `l`: follows the line (tree) or opens it in the path view (mass). */
  readonly follow: () => void;
  readonly cycleSort: () => void;
  readonly openLens: () => void;
  readonly closeLens: () => void;
  readonly cycleLens: () => void;
  readonly openLensAnchor: () => void;
  readonly editLensState: () => void;
  /** `D` and `t` in the path view. */
  readonly askDelete: () => void;
  readonly tagLine: () => void;
  /** Opens the generation records of the cursor's take. */
  readonly openRecords: () => void;
}

/** The key actions `handleMapKey` handles; keys help lists only handled actions. */
export const MAP_KEY_ACTIONS: readonly string[] = [
  "cancel", "cycle-map-view", "toggle-sketches", "toggle-path-takes", "apply",
  "focus-next", "focus-previous", "take-next", "take-previous",
  "map-hide-lanes", "map-follow", "map-cycle-sort", "open-fact-lens", "prune", "tag", "open-records"
];

/** The map's keys, after `keymap-dom.ts` resolved them through the TUI's MAP
 * table. Returns whether the key was used (and so should not scroll the list
 * or do anything else natively). */
export function handleMapKey(binding: ReferenceBinding, ctx: MapKeyContext): boolean {
  switch (binding.action) {
    case "cancel":
      if (ctx.lensActive) ctx.closeLens();
      else ctx.close();
      return true;
    case "cycle-map-view": ctx.toggleView(); return true;
    case "map-hide-lanes":
      if (ctx.lensActive) ctx.cycleLens();
      else ctx.hideLanes();
      return true;
    case "map-follow": ctx.follow(); return true;
    case "map-cycle-sort": ctx.cycleSort(); return true;
    // `f` again, with the lens open, goes on to the next Fact.
    case "open-fact-lens":
      if (ctx.lensActive) ctx.cycleLens();
      else ctx.openLens();
      return true;
    case "prune": ctx.askDelete(); return true;
    case "tag": ctx.tagLine(); return true;
    case "open-records":
      if (ctx.openRecords === undefined) return false;
      ctx.openRecords();
      return true;
    // `e` (the NAV table's edit) means "edit state" while the lens is open.
    case "edit":
      if (!ctx.lensActive) return false;
      ctx.editLensState();
      return true;
    case "toggle-sketches":
    case "toggle-path-takes": ctx.toggleSketches(); return true;
    case "apply":
      if (ctx.lensActive) ctx.openLensAnchor();
      else ctx.act();
      return true;
    case "focus-next":
    case "focus-previous": {
      if (ctx.cursorId === null) return true;
      const direction = binding.action === "focus-next" ? 1 : -1;
      if (ctx.view === "tree" && ctx.tree !== null) ctx.setCursor(moveTreeCursor(ctx.tree, ctx.cursorId, direction));
      else if (ctx.view === "mass" && ctx.mass !== null) ctx.setCursor(moveMassCursor(ctx.mass, ctx.cursorId, direction));
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

import { createStoryIndex, rememberedLeafId } from "../../shared/story-model.js";
import { openFactEditor } from "./editor-action.js";
import { factLensAnchorForRows, factLensStateAtNode } from "./map-fact-lens.js";
import type { AppSource } from "./app.js";
import { createAtlasLayout, moveAtlasCursor } from "./atlas-layout.js";
import {
  createLaneLayout,
  followLane,
  laneSelectable,
  laneLayoutOptions,
  laneTakeId,
  moveLaneCursor,
  moveLaneCursorAcross,
  type LaneRow
} from "./lane-layout.js";
import type { ResolvedKey } from "./keys.js";
import { initialPathCursor, movePathCursor, visiblePathSiblings } from "./path-layout.js";
import type { MapState } from "./map-state.js";
import { nextMapView, nextMassSort } from "./map-state.js";
import { createStoryViewModel, rowIndexForNode, rowPart } from "./model.js";
import type { RuntimeState } from "./state.js";
import { projectStreamedPayload } from "./stream-projection.js";
import type { ActionContext } from "./action-context.js";

export interface MapActionContext extends ActionContext {
  reroute: (
    state: RuntimeState,
    source: AppSource,
    context: ActionContext,
    nodeId: string | null
  ) => Promise<void>;
  armPrune: (state: RuntimeState) => void;
  openTag: (state: RuntimeState) => void;
}

export function openMap(state: RuntimeState): void {
  const payload = mapPayload(state);
  const focused = rowPart(createStoryViewModel(payload), state.focusIndex);
  const cursor = initialPathCursor(payload, focused?.pathIndex ?? payload.path.length - 1);
  if (cursor === null) {
    state.toast = "nothing to map yet · write a first part";
    return;
  }
  state.map = {
    view: "path",
    pathCursorId: cursor,
    pathShowAllTakes: true,
    treeCursorId: payload.path.at(-1)?.id ?? cursor,
    rowIds: [],
    showSketches: true,
    openedColdFolds: new Set(),
    massSort: "size"
  };
  state.mode = "MAP";
}

export async function mapAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: MapActionContext
): Promise<void> {
  const map = state.map;
  if (map === null) return;
  const lensPayload = mapPayload(state);
  if (resolved.action === "cancel") {
    if (map.factLensFactId !== undefined && map.factLensFactId !== null) {
      map.factLensFactId = null;
      return;
    }
    state.map = null;
    state.mode = "NAV";
    return;
  }
  if (resolved.action === "cycle-map-view") {
    map.view = nextMapView(map.view);
    if (map.view !== "tree") map.factLensFactId = null;
    return;
  }
  if (resolved.action === "set-map-view" && resolved.view !== undefined) {
    map.view = resolved.view;
    if (map.view !== "tree") map.factLensFactId = null;
    return;
  }
  if (resolved.action === "open-fact-lens") {
    if (map.view !== "tree") return;
    const firstFact = lensPayload.facts[0];
    if (firstFact === undefined) {
      state.toast = "no Facts to lens";
      return;
    }
    map.factLensFactId = firstFact.id;
    return;
  }
  if (map.view === "tree" && map.factLensFactId !== undefined && map.factLensFactId !== null) {
    const fact = lensPayload.facts.find(({ id }) => id === map.factLensFactId) ?? null;
    if (fact === null) {
      map.factLensFactId = null;
      return;
    }
    if (resolved.action === "cycle-fact-lens") {
      const index = lensPayload.facts.findIndex(({ id }) => id === fact.id);
      map.factLensFactId = lensPayload.facts[(index + 1) % lensPayload.facts.length]?.id ?? null;
      return;
    }
    const layout = createLaneLayout(lensPayload, laneLayoutOptions(state, map));
    const rows = layout.rows.filter(laneSelectable);
    const anchor = factLensAnchorForRows(fact, rows, map.treeCursorId);
    if (resolved.action === "open-fact-lens-anchor" || resolved.action === "open-selected") {
      if (anchor === null) {
        state.toast = "this Fact has no visible anchor";
        return;
      }
      map.factLensFactId = null;
      state.map = null;
      state.mode = "NAV";
      const view = createStoryViewModel(lensPayload);
      const row = rowIndexForNode(view, anchor.nodeId);
      if (row >= 0) state.focusIndex = row;
      return;
    }
    if (resolved.action === "edit-fact-lens") {
      const selected = factLensStateAtNode(fact, lensPayload, map.treeCursorId);
      if (selected === null) {
        state.toast = "this Fact has no state here";
        return;
      }
      openFactEditor(state, fact, {
        stateId: selected.id,
        returnMode: "MAP"
      });
      return;
    }
  }
  if (resolved.action === "toggle-sketches") {
    map.showSketches = !map.showSketches;
    return;
  }
  if (resolved.action === "toggle-path-takes") {
    map.pathShowAllTakes = !map.pathShowAllTakes;
    return;
  }
  if (resolved.action === "map-cycle-sort") {
    map.massSort = nextMassSort(map.massSort);
    return;
  }
  if (map.view === "path") return await pathAction(resolved, state, source, context);
  if (map.view === "tree") return await treeAction(resolved, state, source, context);
  return await massAction(resolved, state, source, context);
}

async function pathAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: MapActionContext
): Promise<void> {
  const map = state.map!;
  const payload = mapPayload(state);
  const showAllTakes = map.pathShowAllTakes;
  if (resolved.action === "focus-index") {
    const id = map.rowIds[Math.max(0, Math.min(map.rowIds.length - 1, resolved.index ?? 0))];
    if (id !== undefined) map.pathCursorId = id;
  } else if (resolved.action === "focus-next") {
    map.pathCursorId = movePathCursor(payload, map.pathCursorId, 1, 0, showAllTakes);
  } else if (resolved.action === "focus-previous") {
    map.pathCursorId = movePathCursor(payload, map.pathCursorId, -1, 0, showAllTakes);
  } else if (resolved.action === "take-next") {
    map.pathCursorId = movePathCursor(payload, map.pathCursorId, 0, 1, showAllTakes);
  } else if (resolved.action === "take-previous") {
    map.pathCursorId = movePathCursor(payload, map.pathCursorId, 0, -1, showAllTakes);
  } else if (resolved.action === "prune") {
    context.armPrune(state);
  } else if (resolved.action === "tag") {
    context.openTag(state);
  } else if (resolved.action === "apply" && resolved.take !== undefined) {
    const rowNode = payload.nodes.find((node) => node.id === map.rowIds[resolved.index ?? -1]);
    const target = rowNode === undefined ? undefined
      : visiblePathSiblings(payload, rowNode.parentId, showAllTakes)[resolved.take - 1];
    if (target !== undefined) {
      if (map.pathCursorId === target.id) await context.reroute(state, source, context, target.id);
      else map.pathCursorId = target.id;
    }
  } else if (resolved.action === "apply" || resolved.action === "open-selected") {
    await context.reroute(state, source, context, map.pathCursorId);
  }
}

/** The shared fast path for `focus-index` and an in-window `focus-next`/
 *  `focus-previous`: both tree and mass move the cursor along the painted
 *  `map.rowIds` window — whose canonical ids came from the last layout —
 *  before ever rebuilding one. Returns whether it handled the action;
 *  a move that crosses the window edge falls through so the caller rebuilds. */
function moveWithinWindow(map: MapState, resolved: ResolvedKey): boolean {
  if (resolved.action === "focus-index") {
    const visibleId = map.rowIds[Math.max(0, Math.min(map.rowIds.length - 1, resolved.index ?? 0))];
    if (visibleId !== undefined) map.treeCursorId = visibleId;
    return true;
  }
  if (resolved.action === "focus-next" || resolved.action === "focus-previous") {
    const at = Math.max(0, map.rowIds.indexOf(map.treeCursorId ?? ""));
    const direction = resolved.action === "focus-next" ? 1 : -1;
    const nearby = map.rowIds[at + direction];
    if (nearby !== undefined) {
      map.treeCursorId = nearby;
      return true;
    }
  }
  return false;
}

/** The `pathCursorId = …; view = "path"` pair shared by `map-hide-lanes` and
 *  an off-lane `map-follow`. Path view hides a sketch entirely in its default
 *  branches-only mode, so opening one there must widen to all takes first —
 *  otherwise `createPathLayout` resolves the cursor to a different node. */
function openRowInPath(map: MapState, row: LaneRow): void {
  map.pathCursorId = row.id;
  if (row.kind === "sketch") map.pathShowAllTakes = true;
  map.view = "path";
}

/** Doc "10a": the tree is the lane graph — every row a `LaneRow` on a fixed
 *  gutter, never the local-camera one `createAtlasLayout` still draws for mass. */
async function treeAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: MapActionContext
): Promise<void> {
  const map = state.map!;
  const payload = mapPayload(state);
  if (moveWithinWindow(map, resolved)) return;
  const layout = createLaneLayout(payload, laneLayoutOptions(state, map));
  const row = layout.allRows.find((candidate) => candidate.cursor) ?? null;
  if ((resolved.action === "map-follow" || resolved.action === "open-selected") && row?.kind === "cold") {
    map.openedColdFolds.add(row.id);
    map.treeCursorId = rememberedLeafId(payload, row.id, createStoryIndex(payload));
    return;
  }
  switch (resolved.action) {
    case "focus-next":
    case "focus-previous":
      map.treeCursorId = moveLaneCursor(layout, resolved.action === "focus-next" ? 1 : -1);
      break;
    case "take-next":
    case "take-previous": {
      // `←→` jumps to the nearest row one lane over; a cursor with no such
      // neighbour (spec's example: the rightmost lane-0 row) just stays put.
      const across = moveLaneCursorAcross(layout, resolved.action === "take-next" ? 1 : -1);
      if (across !== null) map.treeCursorId = across;
      break;
    }
    case "map-hide-lanes":
      // A cold row's own id is its anchor node's — a fine path cursor, unlike
      // `apply`/`open-selected`'s reroute target, which a folded subtree has
      // no single take to name.
      if (row !== null) openRowInPath(map, row);
      else map.view = "path";
      break;
    case "map-follow":
      // Lane 0 is the reading line: `l` walks it down. Any other lane has
      // nowhere further to walk within the tree, so it opens in path instead.
      if (row !== null && row.lane === 0) map.treeCursorId = followLane(layout);
      else if (row !== null) openRowInPath(map, row);
      break;
    case "apply":
    case "open-selected": {
      const takeId = row === null ? null : laneTakeId(row);
      if (takeId !== null) await context.reroute(state, source, context, takeId);
      break;
    }
    default:
      break;
  }
}

async function massAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: MapActionContext
): Promise<void> {
  const map = state.map!;
  const payload = mapPayload(state);
  if (moveWithinWindow(map, resolved)) return;
  const layout = createAtlasLayout(payload, {
    now: state.now,
    cursorId: map.treeCursorId,
    showSketches: map.showSketches,
    sort: map.massSort
  });
  const row = layout.allRows.find((candidate) => candidate.cursor) ?? null;
  if (resolved.action === "focus-next" || resolved.action === "focus-previous") {
    map.treeCursorId = moveAtlasCursor(layout, resolved.action === "focus-next" ? 1 : -1);
  } else if (resolved.action === "map-follow" && row !== null) {
    map.pathCursorId = row.id;
    map.view = "path";
  } else if ((resolved.action === "apply" || resolved.action === "open-selected")
    && row !== null && (row.kind === "node" || row.kind === "sketch")) {
    await context.reroute(state, source, context, row.id);
  }
}

/** The node id `h` targets from MAP mode: the path cursor in Path view, or
 *  the cursor row's node in Tree/Mass — a folded "cold" row names a whole
 *  subtree, not one take, so it names nothing. Map logic, so it lives here
 *  rather than in `generation-record-actions.ts`, which just calls it. */
export function mapCursorNodeId(state: RuntimeState): string | null {
  const map = state.map;
  if (map === null) return null;
  if (map.view === "path") return map.pathCursorId;
  const payload = mapPayload(state);
  if (map.view === "tree") {
    const layout = createLaneLayout(payload, laneLayoutOptions(state, map));
    const row = layout.allRows.find((candidate) => candidate.cursor) ?? null;
    return row === null ? null : laneTakeId(row);
  }
  const layout = createAtlasLayout(payload, {
    now: state.now,
    cursorId: map.treeCursorId,
    showSketches: map.showSketches,
    sort: map.massSort
  });
  const row = layout.allRows.find((candidate) => candidate.cursor) ?? null;
  return row !== null && (row.kind === "node" || row.kind === "sketch") ? row.id : null;
}

function mapPayload(state: Pick<RuntimeState, "payload" | "stream">) {
  return projectStreamedPayload(state.payload, state.stream, { includePendingTake: true });
}

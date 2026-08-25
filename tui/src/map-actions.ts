import { createStoryIndex, rememberedLeafId } from "../../shared/story-model.js";
import type { AppSource } from "./app.js";
import { createAtlasLayout, moveAtlasCursor } from "./atlas-layout.js";
import {
  createLaneLayout,
  followLane,
  laneSelectable,
  moveLaneCursor,
  moveLaneCursorAcross
} from "./lane-layout.js";
import type { ResolvedKey } from "./keys.js";
import { initialPathCursor, movePathCursor, visiblePathSiblings } from "./path-layout.js";
import { nextMapView, nextMassSort } from "./map-state.js";
import { createStoryViewModel, rowPart } from "./model.js";
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
  if (resolved.action === "cancel") {
    state.map = null;
    state.mode = "NAV";
    return;
  }
  if (resolved.action === "cycle-map-view") {
    map.view = nextMapView(map.view);
    return;
  }
  if (resolved.action === "set-map-view" && resolved.view !== undefined) {
    map.view = resolved.view;
    return;
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
  if (resolved.action === "focus-index") {
    const visibleId = map.rowIds[Math.max(0, Math.min(map.rowIds.length - 1, resolved.index ?? 0))];
    if (visibleId !== undefined) map.treeCursorId = visibleId;
    return;
  }
  if (resolved.action === "focus-next" || resolved.action === "focus-previous") {
    const at = Math.max(0, map.rowIds.indexOf(map.treeCursorId ?? ""));
    const direction = resolved.action === "focus-next" ? 1 : -1;
    const nearby = map.rowIds[at + direction];
    // Most arrow moves stay inside the painted window, whose canonical IDs
    // came from the last layout. Rebuild only when crossing that window edge.
    if (nearby !== undefined) {
      map.treeCursorId = nearby;
      return;
    }
  }
  const layout = createLaneLayout(payload, {
    now: state.now,
    cursorId: map.treeCursorId,
    showSketches: map.showSketches,
    openedColdFolds: map.openedColdFolds
  });
  const row = layout.allRows.find((candidate) => candidate.cursor) ?? null;
  if (resolved.action === "focus-next" || resolved.action === "focus-previous") {
    map.treeCursorId = moveLaneCursor(layout, resolved.action === "focus-next" ? 1 : -1);
  } else if (resolved.action === "take-next" || resolved.action === "take-previous") {
    // `←→` jumps to the nearest row one lane over; a cursor with no such
    // neighbour (spec's example: the rightmost lane-0 row) just stays put.
    const across = moveLaneCursorAcross(layout, resolved.action === "take-next" ? 1 : -1);
    if (across !== null) map.treeCursorId = across;
  } else if (resolved.action === "map-hide-lanes") {
    if (row !== null && laneSelectable(row) && row.kind !== "cold") map.pathCursorId = row.id;
    map.view = "path";
  } else if ((resolved.action === "map-follow" || resolved.action === "open-selected") && row?.kind === "cold") {
    map.openedColdFolds.add(row.id);
    map.treeCursorId = rememberedLeafId(payload, row.id, createStoryIndex(payload));
  } else if (resolved.action === "map-follow" && row !== null && row.lane === 0) {
    // Lane 0 is the reading line: `l` walks it down. Any other lane has
    // nowhere further to walk within the tree, so it opens in path instead.
    map.treeCursorId = followLane(layout);
  } else if (resolved.action === "map-follow" && row !== null) {
    map.pathCursorId = row.id;
    map.view = "path";
  } else if ((resolved.action === "apply" || resolved.action === "open-selected")
    && row !== null && laneSelectable(row) && row.kind !== "cold") {
    await context.reroute(state, source, context, row.id);
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
  if (resolved.action === "focus-index") {
    const visibleId = map.rowIds[Math.max(0, Math.min(map.rowIds.length - 1, resolved.index ?? 0))];
    if (visibleId !== undefined) map.treeCursorId = visibleId;
    return;
  }
  if (resolved.action === "focus-next" || resolved.action === "focus-previous") {
    const at = Math.max(0, map.rowIds.indexOf(map.treeCursorId ?? ""));
    const direction = resolved.action === "focus-next" ? 1 : -1;
    const nearby = map.rowIds[at + direction];
    if (nearby !== undefined) {
      map.treeCursorId = nearby;
      return;
    }
  }
  const layout = createAtlasLayout(payload, {
    now: state.now,
    cursorId: map.treeCursorId,
    showSketches: map.showSketches,
    openedColdFolds: map.openedColdFolds,
    sort: map.massSort
  });
  const row = layout.allRows.find((candidate) => candidate.cursor) ?? null;
  if (resolved.action === "focus-next" || resolved.action === "focus-previous") {
    map.treeCursorId = moveAtlasCursor(layout, resolved.action === "focus-next" ? 1 : -1);
  } else if ((resolved.action === "map-follow" || resolved.action === "open-selected") && row?.kind === "cold") {
    map.openedColdFolds.add(row.id);
    map.treeCursorId = rememberedLeafId(payload, row.id, createStoryIndex(payload));
  } else if (resolved.action === "map-follow" && row !== null) {
    map.pathCursorId = row.id;
    map.view = "path";
  } else if ((resolved.action === "apply" || resolved.action === "open-selected")
    && row !== null && (row.kind === "node" || row.kind === "sketch")) {
    await context.reroute(state, source, context, row.id);
  }
}

function mapPayload(state: Pick<RuntimeState, "payload" | "stream">) {
  return projectStreamedPayload(state.payload, state.stream, { includePendingTake: true });
}

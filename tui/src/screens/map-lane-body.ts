import type { FrameDeadlineCollector } from "../animation-deadline.js";
import { createLaneLayout, laneLayoutOptions, laneSelectable, type LaneLayout, type LaneRow } from "../lane-layout.js";
import { factLensNode } from "../map-fact-lens.js";
import { factName } from "../facts-model.js";
import { createStoryIndex } from "../../../shared/story-model.js";
import type { HitRow } from "../hit.js";
import type { MapState } from "../map-state.js";
import type { StoryScreenState } from "../state.js";
import { renderLaneMarker, renderLaneRow } from "./map-lane-row.js";
import { appendMapPreview } from "./map-preview.js";
import { type FrameLine } from "./story/frame.js";
import type { MapScreenDerived } from "./map.js";

export interface LaneMapBody {
  lines: FrameLine[];
  hits: Array<HitRow | null>;
  stats: string;
  crumb: string;
  derived: MapScreenDerived;
}

/** The tree body, redrawn as the whole story in lanes (doc "10a") instead of
 *  the local-camera graph doc 20c drew. `map.ts` owns the shell (title, keyline,
 *  breadcrumb); this owns everything between them. */
export function renderLaneTreeBody(
  state: StoryScreenState,
  map: MapState,
  width: number,
  bodyHeight: number,
  deadlines?: FrameDeadlineCollector
): LaneMapBody {
  const reserve = (width >= 100 ? 2 : 0) + 2;
  const layout = createLaneLayout(state.payload, {
    ...laneLayoutOptions(state, map),
    maxRows: Math.max(1, bodyHeight - reserve),
    deadlines
  });

  const rowIds = layout.rows.filter(laneSelectable).map((row) => row.id);
  const indexById = new Map(rowIds.map((id, index) => [id, index] as const));

  const lines: FrameLine[] = [];
  const hits: Array<HitRow | null> = [];
  const streamTargetId = state.stream?.targetId ?? null;
  const lensFact = map.factLensFactId === undefined || map.factLensFactId === null
    ? null
    : state.payload.facts.find(({ id }) => id === map.factLensFactId) ?? null;
  const lensIndex = lensFact === null ? null : createStoryIndex(state.payload);

  if (layout.visibleStart > 0) {
    lines.push(renderLaneMarker(layout.rows[0]!.alive, `▲ ${layout.visibleStart} above`, layout, width));
    hits.push(null);
  }
  for (const row of layout.rows) {
    const lens = lensFact === null || lensIndex === null || !laneSelectable(row) || row.kind === "sketches"
      ? null
      : factLensNode(lensFact, lensIndex, row.id);
    lines.push(renderLaneRow(row, layout, width, streamTargetId, lens));
    hits.push(hitForRow(row, indexById, width));
  }
  if (layout.moreRows > 0) {
    // Symmetric with the top marker's `layout.rows[0].alive`: the alive set of
    // the first *hidden* row, not the last visible one — a `close` row's own
    // `alive` still names the lanes it closes (alive is "before the row's own
    // effect"), so the last visible row would draw `│` in a lane that just ended.
    const belowAlive = layout.allRows[layout.visibleEnd]?.alive ?? [];
    lines.push(renderLaneMarker(belowAlive, `▼ ${layout.moreRows} below`, layout, width));
    hits.push(null);
  }
  appendLanePreview(lines, hits, layout, width);

  const cursor = layout.allRows.find((row) => row.cursor) ?? null;
  const hot = Math.max(0, layout.totalLines - layout.coldLines);
  const cold = layout.coldLines > 0 ? ` ━ ${hot} hot · ${layout.coldLines} folded cold` : "";
  const windowSuffix = layout.totalRows > layout.rows.length
    ? ` ━ rows ${layout.visibleStart + 1}–${layout.visibleEnd} of ${layout.totalRows}` : "";
  const lensTitle = lensFact === null ? null : factName(
    lensFact,
    state.payload.path.map(({ id }) => id)
  );
  return {
    lines, hits,
    stats: `${lensTitle === null ? state.payload.title : `fact lens: ${lensTitle}`} ━ ${layout.totalLines} lines · ${layout.totalParts} parts · ${layout.forkCount} forks${cold}${windowSuffix}`,
    crumb: cursor === null ? "tree" : `¶ ${cursor.depth}`,
    derived: { rowIds, pathCursorId: map.pathCursorId, treeCursorId: layout.cursorId }
  };
}

function hitForRow(row: LaneRow, indexById: ReadonlyMap<string, number>, width: number): HitRow | null {
  if (row.kind === "sketches") return { target: { kind: "action", action: "toggle-sketches" }, left: 0, right: width };
  if (!laneSelectable(row)) return null;
  const index = indexById.get(row.id);
  if (index === undefined) return null;
  const kind = row.kind === "node" || row.kind === "end" ? "node" : row.kind === "sketch" ? "sketch" : "cold";
  return { target: { kind: "list", index, mapRow: { id: row.id, kind } }, left: 0, right: width };
}

/** Same shape as the mass/path preview pair — ¶ depth and the row's own
 *  words — but the cursor row can be node, end, or sketch here. */
function appendLanePreview(
  lines: FrameLine[],
  hits: Array<HitRow | null>,
  layout: LaneLayout,
  width: number
): void {
  const cursor = layout.allRows.find(isPreviewCursor) ?? null;
  appendMapPreview(lines, hits, cursor, width);
}

function isPreviewCursor(
  row: LaneRow
): row is Extract<LaneRow, { kind: "node" } | { kind: "end" } | { kind: "sketch" }> {
  return row.cursor && (row.kind === "node" || row.kind === "end" || row.kind === "sketch");
}

import type { FrameDeadlineCollector } from "../animation-deadline.js";
import { createLaneLayout, laneSelectable, type LaneLayout, type LaneRow } from "../lane-layout.js";
import type { HitRow } from "../hit.js";
import type { MapState } from "../map-state.js";
import type { StoryScreenState } from "../state.js";
import { renderLaneMarker, renderLaneRow } from "./map-lane-row.js";
import { formatMapWords } from "./map-row-labels.js";
import { segment, truncate, visibleWidth, type FrameLine } from "./story/frame.js";
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
    now: state.now,
    cursorId: map.treeCursorId,
    showSketches: map.showSketches,
    openedColdFolds: map.openedColdFolds,
    maxRows: Math.max(1, bodyHeight - reserve),
    deadlines
  });

  const rowIds = layout.rows.filter(laneSelectable).map((row) => row.id);
  const indexById = new Map(rowIds.map((id, index) => [id, index] as const));

  const lines: FrameLine[] = [];
  const hits: Array<HitRow | null> = [];
  const streamTargetId = state.stream?.targetId ?? null;

  if (layout.visibleStart > 0) {
    lines.push(renderLaneMarker(layout.rows[0]!.alive, `▲ ${layout.visibleStart} above`, layout, width));
    hits.push(null);
  }
  for (const row of layout.rows) {
    lines.push(renderLaneRow(row, layout, width, streamTargetId));
    hits.push(hitForRow(row, indexById, width));
  }
  if (layout.moreRows > 0) {
    const last = layout.rows[layout.rows.length - 1]!;
    lines.push(renderLaneMarker(markerAlive(last), `▼ ${layout.moreRows} below`, layout, width));
    hits.push(null);
  }
  appendLanePreview(lines, hits, layout, width);

  const cursor = layout.allRows.find((row) => row.cursor) ?? null;
  const hot = Math.max(0, layout.totalLines - layout.coldLines);
  const cold = layout.coldLines > 0 ? ` ━ ${hot} hot · ${layout.coldLines} folded cold` : "";
  const windowSuffix = layout.totalRows > layout.rows.length
    ? ` ━ rows ${layout.visibleStart + 1}–${layout.visibleEnd} of ${layout.totalRows}` : "";
  return {
    lines, hits,
    stats: `${state.payload.title} ━ ${layout.totalLines} lines · ${layout.totalParts} parts · ${layout.forkCount} forks${cold}${windowSuffix}`,
    crumb: cursor === null ? "tree" : `¶ ${cursor.depth}`,
    derived: { rowIds, pathCursorId: map.pathCursorId, treeCursorId: layout.cursorId }
  };
}

/** A close row's own `lane` names a lane that is closing right there, so it
 *  must not read as still alive below the window; every other kind's own
 *  lane already belongs to `alive`, but the union is harmless and cheap. */
function markerAlive(row: LaneRow): readonly boolean[] {
  if (row.kind === "close" || row.lane < 0) return row.alive;
  if (row.alive[row.lane] === true) return row.alive;
  const alive = [...row.alive];
  alive[row.lane] = true;
  return alive;
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
  if (width < 100) return;
  const cursor = layout.allRows.find(isPreviewCursor);
  if (cursor === undefined) return;
  const detail = `¶ ${cursor.depth} · ${formatMapWords(cursor.node.words)}`;
  const preview = truncate(
    cursor.node.preview.replace(/\s+/g, " ").trim(),
    Math.max(8, width - visibleWidth(detail) - 8)
  );
  lines.push([], [segment("  ‥ ", "summary"), segment(preview, "summary"),
    segment(" ".repeat(Math.max(1, width - visibleWidth(preview) - visibleWidth(detail) - 5))), segment(detail, "chrome")]);
  hits.push(null, null);
}

function isPreviewCursor(
  row: LaneRow
): row is Extract<LaneRow, { kind: "node" } | { kind: "end" } | { kind: "sketch" }> {
  return row.cursor && (row.kind === "node" || row.kind === "end" || row.kind === "sketch");
}

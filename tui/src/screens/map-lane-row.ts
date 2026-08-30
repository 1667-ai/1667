import type { LaneLayout, LaneRow } from "../lane-layout.js";
import type { FactLensNode } from "../map-fact-lens.js";
import { tagGlyph, tagRole, formatMapWordsBare, mapLineLabel, opening } from "./map-row-labels.js";
import {
  padCells,
  segment,
  truncate,
  visibleWidth,
  type DisplayRole,
  type FrameLine,
  type FrameSegment
} from "./story/frame.js";

type LaneGeometry = Pick<LaneLayout, "laneCount" | "overflow">;
/** Every row that carries a label: everything but `fork` and `close`, which
 *  draw connectors only. Named so `appendLabel` keeps the narrowing
 *  `renderLaneRow`'s two early returns already established. */
type LabelledRow = Exclude<LaneRow, { kind: "fork" } | { kind: "close" }>;

/** One lane row (doc "10a"). Columns 0–1 are the cursor slot; two cells per
 *  lane from column 2; a 4-cell overflow column only when the story ever
 *  parks a line. Every row returns exactly one `FrameLine` — width fitting
 *  happens once, at the map screen level, same as every other map body row. */
export function renderLaneRow(
  row: LaneRow,
  layout: LaneGeometry,
  width: number,
  streamTargetId: string | null,
  lens: FactLensNode | null = null
): FrameLine {
  if (row.kind === "fork") return renderForkRow(row, layout);
  if (row.kind === "close") return renderCloseRow(row, layout);
  const line: FrameLine = [segment(row.cursor ? "▸ " : "  ", row.cursor ? "focus / accent" : "prose")];
  const { text: glyph, role } = ownGlyph(row, streamTargetId, lens);
  const override = row.lane === -1 ? undefined : { lane: row.lane, cell: segment(glyph, role) };
  line.push(...laneCells(row.alive, layout.laneCount, override, lens));
  const overflow = overflowCell(layout, row.lane === -1 ? -1 : row.parked, "dimmed page");
  if (overflow !== null) line.push(overflow);
  appendLabel(line, row, width, lens);
  return line;
}

/** The two window-marker rows `map-lane-body.ts` prepends/appends: the alive
 *  lanes as `│`, the caption at the label column. */
export function renderLaneMarker(
  alive: readonly boolean[],
  text: string,
  layout: LaneGeometry,
  width: number
): FrameLine {
  const line: FrameLine = [segment("  "), ...laneCells(alive, layout.laneCount)];
  const overflow = overflowCell(layout, 0, "dimmed page");
  if (overflow !== null) line.push(overflow);
  line.push(segment(truncate(text, Math.max(1, width - lineWidthOf(line))), "dimmed page"));
  return line;
}

/** Lane cells for one row: `│` where a lane is alive, blank otherwise, with at
 *  most one lane's cell swapped for something else — the row's own glyph.
 *  Fork and close rows draw richer, multi-lane connectors of their own and
 *  build their cells directly instead. */
function laneCells(
  alive: readonly boolean[],
  laneCount: number,
  override?: { lane: number; cell: FrameSegment },
  lens: FactLensNode | null = null
): FrameSegment[] {
  const cells: FrameSegment[] = [];
  const role = lens?.kind === "off-path" || lens?.kind === "dead"
    ? "dimmed page"
    : lens?.kind === "later" ? lensInkRole(lens) : "dimmed page";
  for (let lane = 0; lane < laneCount; lane += 1) {
    if (override !== undefined && lane === override.lane) { cells.push(override.cell); continue; }
    cells.push(alive[lane] === true ? segment("│ ", role) : segment("  "));
  }
  return cells;
}

/** The shared 4-cell overflow column: `null` when the story never parks a
 *  line, blank when nothing parked here, a bare `⋯` when the row's own line
 *  is the parked one (`count < 0`), else the parked count. */
function overflowCell(layout: LaneGeometry, count: number, role: DisplayRole): FrameSegment | null {
  if (!layout.overflow) return null;
  if (count < 0) return segment(padCells("⋯", 4), role);
  return count > 0 ? segment(padCells(`⋯${count}`, 4), role) : segment("    ");
}

function lineWidthOf(line: FrameLine): number {
  return line.reduce((sum, part) => sum + visibleWidth(part.text), 0);
}

function ownGlyph(
  row: LaneRow,
  streamTargetId: string | null,
  lens: FactLensNode | null = null
): { text: string; role: "focus / accent" | "accent · deep" | "prose · dim" | "dimmed page" | "fresh 1" | "fresh 2" } {
  const streaming = row.kind === "node" || row.kind === "end" ? row.node.id === streamTargetId : false;
  const pad = streaming ? "⟳" : " ";
  if (lens !== null) {
    if (lens.end) return { text: `✕${pad}`, role: "prose · dim" };
    if (lens.kind === "dead") return { text: "╌ ", role: "dimmed page" };
    if (lens.anchor) {
      return { text: `◆${pad}`, role: lens.kind === "later" ? lensInkRole(lens) : "focus / accent" };
    }
    if (lens.kind === "off-path") return { text: `·${pad}`, role: "dimmed page" };
    return {
      text: row.kind === "node" && row.active ? `◉${pad}` : `●${pad}`,
      role: lens.kind === "later" ? lensInkRole(lens) : "accent · deep"
    };
  }
  if (row.kind === "node") {
    return row.active ? { text: `◉${pad}`, role: "focus / accent" } : { text: `●${pad}`, role: "accent · deep" };
  }
  if (row.kind === "end") return { text: `●${pad}`, role: "prose · dim" };
  if (row.kind === "sketch") return { text: "○ ", role: "prose · dim" };
  return { text: "● ", role: "dimmed page" };
}

function appendLabel(line: FrameLine, row: LabelledRow, width: number, lens: FactLensNode | null = null): void {
  const remaining = () => Math.max(1, width - lineWidthOf(line));
  if (row.kind === "node") {
    const collapsed = row.node.preview.replace(/\s+/g, " ").trim();
    const role = lensRole(lens, row.cursor ? "prose" : "prose · dim");
    if (row.tag === null) {
      line.push(segment(truncate(collapsed, remaining()), role));
      return;
    }
    const tail = ` ${tagGlyph(row.tag.status)} ${row.tag.name}`;
    const previewBudget = Math.max(8, width - lineWidthOf(line) - visibleWidth(tail));
    line.push(segment(truncate(collapsed, previewBudget), role));
    line.push(segment(tail, tagRole(row.tag)));
    return;
  }
  if (row.kind === "end") {
    const label = mapLineLabel({ tag: row.tag, node: row.node });
    const role = lensRole(lens, row.cursor ? "prose" : tagRole(row.tag));
    const tail = row.words < 1_000 ? `${row.words}w` : formatMapWordsBare(row.words);
    const tailText = ` · ${tail}`;
    const labelBudget = Math.max(1, width - lineWidthOf(line) - visibleWidth(tailText));
    line.push(segment(truncate(label, labelBudget), role));
    line.push(segment(" · ", "chrome"));
    line.push(segment(tail, "chrome"));
    return;
  }
  if (row.kind === "sketch") {
    const label = `“${opening(row.node.preview)}‥”`;
    line.push(segment(truncate(label, remaining()), lensRole(lens, row.cursor ? "prose" : "prose · dim")));
    return;
  }
  if (row.kind === "sketches") {
    const label = `⌇ ${row.count} ${row.count === 1 ? "sketch" : "sketches"}`;
    line.push(segment(truncate(label, remaining()), "prose · dim"));
    return;
  }
  const label = `⋯ ×${row.lineCount} ${row.lineCount === 1 ? "line" : "lines"} · cold ${row.weeks} wks`;
  line.push(segment(truncate(label, remaining()), lensRole(lens, "prose · dim")));
}

function lensRole(lens: FactLensNode | null, fallback: DisplayRole): DisplayRole {
  if (lens === null) return fallback;
  if (lens.kind === "off-path" || lens.kind === "dead") return "dimmed page";
  if (lens.kind === "later") return lensInkRole(lens);
  if (lens.kind === "ended") return "prose · dim";
  return "accent · deep";
}

function lensInkRole(lens: FactLensNode): "fresh 1" | "fresh 2" {
  return (lens.stateIndex ?? 0) > 1 ? "fresh 2" : "fresh 1";
}

function renderForkRow(row: Extract<LaneRow, { kind: "fork" }>, layout: LaneGeometry): FrameLine {
  const line: FrameLine = [segment("  ")];
  const lastChildLane = row.toLanes.length > 0 ? row.toLanes[row.toLanes.length - 1]! : row.lane;
  const childLanes = new Set(row.toLanes);
  for (let lane = 0; lane < layout.laneCount; lane += 1) {
    if (lane < row.lane || lane > lastChildLane) {
      line.push(row.alive[lane] === true ? segment("│ ", "dimmed page") : segment("  "));
      continue;
    }
    const first = lane === row.lane ? "├"
      : lane === lastChildLane ? "╮"
        : childLanes.has(lane) ? "┬"
          : row.alive[lane] === true ? "┼"
            : "─";
    const continuesToOverflow = row.parkedCount > 0;
    const second = lane === lastChildLane ? (continuesToOverflow ? "─" : " ") : "─";
    line.push(segment(`${first}${second}`, "brass dim"));
  }
  const overflow = overflowCell(layout, row.parkedCount, "brass dim");
  if (overflow !== null) line.push(overflow);
  return line;
}

function renderCloseRow(row: Extract<LaneRow, { kind: "close" }>, layout: LaneGeometry): FrameLine {
  const line: FrameLine = [segment("  ")];
  const closing = new Set(row.lanes);
  for (let lane = 0; lane < layout.laneCount; lane += 1) {
    if (closing.has(lane)) line.push(segment("╵ ", "dimmed page"));
    else if (row.alive[lane] === true) line.push(segment("│ ", "dimmed page"));
    else line.push(segment("  "));
  }
  const overflow = overflowCell(layout, row.parked, "dimmed page");
  if (overflow !== null) line.push(overflow);
  return line;
}

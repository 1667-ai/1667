import type { LaneLayout, LaneRow } from "../lane-layout.js";
import { tagGlyph, tagRole, formatMapWordsBare, laneLineLabel } from "./map-row-labels.js";
import {
  padCells,
  segment,
  truncate,
  visibleWidth,
  type FrameLine
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
  streamTargetId: string | null
): FrameLine {
  if (row.kind === "fork") return renderForkRow(row, layout);
  if (row.kind === "close") return renderCloseRow(row, layout);
  const line: FrameLine = [segment(row.cursor ? "▸ " : "  ", row.cursor ? "focus / accent" : "prose")];
  const { text: glyph, role } = ownGlyph(row, streamTargetId);
  for (let lane = 0; lane < layout.laneCount; lane += 1) {
    if (row.lane !== -1 && lane === row.lane) line.push(segment(glyph, role));
    else if (row.alive[lane] === true) line.push(segment("│ ", "dimmed page"));
    else line.push(segment("  "));
  }
  if (layout.overflow) {
    if (row.lane === -1) line.push(segment(padCells("⋯", 4), "dimmed page"));
    else line.push(segment(row.parked > 0 ? padCells(`⋯${row.parked}`, 4) : "    ", "dimmed page"));
  }
  appendLabel(line, row, width);
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
  const line: FrameLine = [segment("  ")];
  for (let lane = 0; lane < layout.laneCount; lane += 1) {
    line.push(alive[lane] === true ? segment("│ ", "dimmed page") : segment("  "));
  }
  if (layout.overflow) line.push(segment("    "));
  line.push(segment(truncate(text, Math.max(1, width - lineWidthOf(line))), "dimmed page"));
  return line;
}

function lineWidthOf(line: FrameLine): number {
  return line.reduce((sum, part) => sum + visibleWidth(part.text), 0);
}

function ownGlyph(row: LaneRow, streamTargetId: string | null): { text: string; role: "focus / accent" | "accent · deep" | "prose · dim" | "dimmed page" } {
  const streaming = row.kind === "node" || row.kind === "end" ? row.node.id === streamTargetId : false;
  const pad = streaming ? "⟳" : " ";
  if (row.kind === "node") {
    return row.active ? { text: `◉${pad}`, role: "focus / accent" } : { text: `●${pad}`, role: "accent · deep" };
  }
  if (row.kind === "end") return { text: `●${pad}`, role: "prose · dim" };
  if (row.kind === "sketch") return { text: "○ ", role: "prose · dim" };
  return { text: "● ", role: "dimmed page" };
}

function appendLabel(line: FrameLine, row: LabelledRow, width: number): void {
  const remaining = () => Math.max(1, width - lineWidthOf(line));
  if (row.kind === "node") {
    const collapsed = row.node.preview.replace(/\s+/g, " ").trim();
    const role = row.cursor ? "prose" : "prose · dim";
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
    const label = laneLineLabel({ tag: row.tag, node: row.node });
    const role = row.cursor ? "prose" : tagRole(row.tag);
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
    line.push(segment(truncate(label, remaining()), row.cursor ? "prose" : "prose · dim"));
    return;
  }
  if (row.kind === "sketches") {
    const label = `⌇ ${row.count} ${row.count === 1 ? "sketch" : "sketches"}`;
    line.push(segment(truncate(label, remaining()), "prose · dim"));
    return;
  }
  const label = `⋯ ×${row.lineCount} ${row.lineCount === 1 ? "line" : "lines"} · cold ${row.weeks} wks`;
  line.push(segment(truncate(label, remaining()), "prose · dim"));
}

/** First six words of a preview, for a sketch's quoted opening — ported from
 *  `atlas-layout.ts` rather than exported: it is a display concern, not a
 *  layout one. */
function opening(value: string): string {
  return value.replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
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
  if (layout.overflow) {
    line.push(row.parkedCount > 0
      ? segment(padCells(`⋯${row.parkedCount}`, 4), "brass dim")
      : segment("    "));
  }
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
  if (layout.overflow) {
    line.push(row.parked > 0 ? segment(padCells(`⋯${row.parked}`, 4), "dimmed page") : segment("    "));
  }
  return line;
}

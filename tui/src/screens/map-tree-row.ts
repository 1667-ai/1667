import type { AtlasLayout, AtlasRow } from "../atlas-layout.js";
import { tagRole, formatMapWordsBare, mapLineLabel } from "./map-row-labels.js";
import {
  lineWidth,
  segment,
  truncate,
  visibleWidth,
  type DisplayRole,
  type FrameLine
} from "./story/frame.js";

/** Indentation carries depth, so these are the whole geometry: the reading line
 *  sits flush against the cursor column, its collapsed runs step in once, and a
 *  branch leaving it steps in again. */
const TRUNK_INDENT = "";
const RUN_INDENT = "  ";
const BRANCH_INDENT = "    ";

/** Full-bleed tree row (doc 20c). No box-drawing: depth is pure indentation,
 *  every branch carries one soft `↳`, and the line you are on is the only
 *  bright glyph on screen. */
export function renderMapTreeRow(
  row: AtlasRow,
  width: number,
  streamTargetId: string | null
): FrameLine {
  const line: FrameLine = [segment(row.cursor ? "▸ " : "  ", row.cursor ? "focus / accent" : "prose")];
  if (row.kind === "run") {
    line.push(segment(`${RUN_INDENT}⋯ ${row.run} ${row.run === 1 ? "part" : "parts"}`, "chrome"));
    return line;
  }
  if (row.branch) line.push(segment(`${BRANCH_INDENT}↳ `, "accent · deep"));
  else line.push(segment(TRUNK_INDENT));
  if (row.kind === "cold") {
    const cold = row.cold!;
    line.push(segment(`×${cold.lineCount} ${cold.lineCount === 1 ? "line" : "lines"} · cold ${cold.weeks} wks`, "prose · dim"));
    return line;
  }
  if (row.kind === "sketch") {
    line.push(segment(truncate(row.fragment ?? "", Math.max(1, width - lineWidth(line) - 4)),
      row.cursor ? "prose" : "prose · dim"));
    return line;
  }
  appendNode(line, row, streamTargetId, width);
  return line;
}

/** Doc 20c fuses what used to be two dense footnote lines into one: how many
 *  subtrees are folded away cold, how many lone sketches hang off the forks,
 *  and — in the same right gutter as every row above — what they weigh. */
export function mapTreeFoldFootnote(layout: AtlasLayout, showSketches: boolean): string {
  const pieces = [
    layout.coldSubtrees > 0
      ? `${layout.coldSubtrees} cold ${layout.coldSubtrees === 1 ? "subtree" : "subtrees"}` : "",
    layout.sketchCount === 0 ? ""
      : showSketches ? `${layout.sketchCount} sketches revealed · a hides`
        : `${layout.sketchCount} sketches · a reveals`
  ].filter((piece) => piece.length > 0);
  return pieces.join(" · ");
}

function appendNode(line: FrameLine, row: AtlasRow, streamTargetId: string | null, width: number): void {
  const streaming = row.node.id === streamTargetId;
  const current = row.active && row.lineEnd;
  if (!row.branch) {
    const glyph = current ? "◉" : row.active ? "●" : "○";
    line.push(segment(`${glyph}${streaming ? "⟳" : " "}`,
      current ? "focus / accent" : row.active ? "accent · deep" : "prose · dim"));
  }
  if (row.lineEnd) appendLineEnd(line, row, current, width);
  else appendForkNode(line, row, width);
}

/** A line's endpoint: its tag or name, total words at the right edge. The
 *  `◉` already says which line you are on, so nothing else needs to. */
function appendLineEnd(line: FrameLine, row: AtlasRow, current: boolean, width: number): void {
  appendLabelled(line, mapLineLabel(row), formatMapWordsBare(row.words), width,
    row.cursor ? "prose" : tagRole(row.tag), current ? "focus / accent" : "chrome");
}

/** A fork on the trunk: its prose preview, a `⑂n` badge riding the title where
 *  it branches, and its own words in the shared right gutter. */
function appendForkNode(line: FrameLine, row: AtlasRow, width: number): void {
  const preview = row.node.preview.replace(/\s+/g, " ").trim();
  const badge = row.forkCount > 1 ? ` ⑂${row.forkCount}` : "";
  appendLabelled(line, preview, formatMapWordsBare(row.ownWords), width,
    row.cursor ? "prose" : "summary", "chrome", badge);
}

/** Label from the current column, its word count right-aligned, with at least
 *  two cells between them at any width. */
function appendLabelled(
  line: FrameLine, label: string, tail: string, width: number,
  labelRole: DisplayRole, tailRole: DisplayRole, badge = ""
): void {
  const tailColumn = width - visibleWidth(tail) - 2;
  const labelWidth = Math.max(4, tailColumn - lineWidth(line) - visibleWidth(badge) - 2);
  line.push(segment(truncate(label, labelWidth), labelRole));
  if (badge.length > 0) line.push(segment(badge, "chrome"));
  padTo(line, tailColumn);
  line.push(segment(tail, tailRole));
}

function padTo(line: FrameLine, column: number): void {
  const padding = column - lineWidth(line);
  if (padding > 0) line.push(segment(" ".repeat(padding)));
}

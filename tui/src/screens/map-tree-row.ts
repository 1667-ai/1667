import type { AtlasLayout, AtlasRow } from "../atlas-layout.js";
import { bookmarkRole, formatMapWords, mapLineLabel } from "./map-row-labels.js";
import {
  segment,
  truncate,
  visibleWidth,
  type DisplayRole,
  type FrameLine
} from "./story/frame.js";


/** Full-bleed tree row. The reading line is the trunk at column 0; alternate
 *  lines are `└─` stubs one column right (spec §4). No panel chrome. */
export function renderMapTreeRow(
  row: AtlasRow,
  width: number,
  streamTargetId: string | null
): FrameLine {
  const line: FrameLine = [segment(row.cursor ? "▸ " : "  ", row.cursor ? "focus / accent" : "prose")];
  appendTrunk(line, row);
  if (row.kind === "spacer") return line;
  if (row.kind === "run") {
    line.push(segment(`·· ${row.run} ${row.run === 1 ? "part" : "parts"}`, "chrome"));
    return line;
  }
  if (row.branch) line.push(segment(`${row.connector}`, "chrome"));
  if (row.kind === "cold") {
    const cold = row.cold!;
    line.push(segment(`▸ ×${cold.lineCount} ${cold.lineCount === 1 ? "line" : "lines"} · cold ${cold.weeks} wks`, "prose · dim"));
    return line;
  }
  if (row.kind === "sketch") {
    line.push(
      segment(`○ ¶${row.depth}  `, "prose · dim"),
      segment(truncate(row.fragment ?? "", Math.max(1, width - lineWidth(line) - 4)), row.cursor ? "prose" : "prose · dim")
    );
    return line;
  }
  appendNode(line, row, streamTargetId, width);
  return line;
}
export function mapSketchFoldText(layout: AtlasLayout): string {
  return layout.sketchForkCount > 1
    ? `+ ${layout.sketchCount} sketches folded across ${layout.sketchForkCount} forks · a reveals`
    : `+ ${layout.sketchCount} sketches folded — single takes never continued · a reveals`;
}

/** The trunk cell: the reading line's rail (`│`) beside a branch or run, or its
 *  own glyph on a trunk node. Drawn in the active-line brass, lantern at `◉`. */
function appendTrunk(line: FrameLine, row: AtlasRow): void {
  if (row.branch || row.kind === "run" || row.kind === "spacer") {
    line.push(segment(row.hasTrunkColumn ? "│ " : "  ", "accent · deep"));
  }
}

function appendNode(line: FrameLine, row: AtlasRow, streamTargetId: string | null, width: number): void {
  const streaming = row.node.id === streamTargetId;
  const current = row.active && row.lineEnd;
  const glyph = row.branch ? "○"
    : current ? "◉" : row.active ? "●" : "○";
  const glyphRole: DisplayRole = current ? "focus / accent" : row.active ? "accent · deep" : "prose · dim";
  line.push(segment(`${glyph}${streaming ? "⟳" : " "}`, glyphRole));
  line.push(segment(`¶${row.depth}  `, current ? "focus / accent" : row.active ? "accent · deep" : "chrome"));
  if (row.lineEnd) appendLineEnd(line, row, current, width);
  else appendForkNode(line, row, width);
}

/** A line's endpoint: its bookmark/name beside the depth, total words at the
 *  right edge. The current reading line adds `‹ you`. */
function appendLineEnd(line: FrameLine, row: AtlasRow, current: boolean, width: number): void {
  const words = `${row.words.toLocaleString("en-US")} w`;
  const here = current ? "  ‹ you" : "";
  const tail = `${words}${here}`;
  appendLabelled(line, mapLineLabel(row), tail, width,
    row.cursor ? "prose" : bookmarkRole(row.bookmark), current ? "focus / accent" : "chrome");
}

/** A fork on the trunk: its prose preview beside the depth, then the fork count
 *  and its own words at the right edge. */
function appendForkNode(line: FrameLine, row: AtlasRow, width: number): void {
  const preview = row.node.preview.replace(/\s+/g, " ").trim();
  const words = formatMapWords(row.ownWords);
  const tail = row.forkCount > 1 ? `fork ×${row.forkCount}   ${words}` : words;
  appendLabelled(line, preview, tail, width, row.cursor ? "prose" : "summary", "chrome");
}

/** Label from the current column, its metadata right-aligned, with at least two
 *  cells between them at any width. */
function appendLabelled(
  line: FrameLine, label: string, tail: string, width: number,
  labelRole: DisplayRole, tailRole: DisplayRole
): void {
  const tailColumn = width - visibleWidth(tail) - 2;
  const labelWidth = Math.max(4, tailColumn - lineWidth(line) - 2);
  line.push(segment(truncate(label, labelWidth), labelRole));
  padTo(line, tailColumn);
  line.push(segment(tail, tailRole));
}

function lineWidth(line: FrameLine): number {
  return line.reduce((sum, part) => sum + visibleWidth(part.text), 0);
}

function padTo(line: FrameLine, column: number): void {
  const padding = column - lineWidth(line);
  if (padding > 0) line.push(segment(" ".repeat(padding)));
}

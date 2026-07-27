import type { PathCell, PathLayout } from "../path-layout.js";
import type { Bookmark } from "../../../shared/types.js";
import { bookmarkGlyph, bookmarkRole } from "./map-row-labels.js";
import {
  padCells,
  segment,
  truncate,
  visibleWidth,
  type DisplayRole,
  type FrameLine
} from "./story/frame.js";

export interface MapPathRow {
  depth: number;
  cursorHere: boolean;
  glyphs: FrameLine;
  glyphWidth: number;
  takeRegions: Array<{ left: number; right: number; take: number }>;
  currentTake: number;
  takeCount: number;
  counter: string;
  preview: string;
  previewRole: DisplayRole;
  words: string;
  badgeText: string;
  bookmark: Bookmark | null;
}

export function createMapPathRow(
  row: PathLayout["rows"][number],
  streamTargetId: string | null
): MapPathRow {
  const cursorCell = row.cells.find((cell) => cell.cursor);
  const shown = cursorCell?.node ?? row.pathNode;
  const glyphs: FrameLine = [];
  const takeRegions: MapPathRow["takeRegions"] = [];
  let glyphPosition = 0;
  if (row.hiddenBefore > 0) {
    const hidden = `‹${row.hiddenBefore} `;
    glyphs.push(segment(hidden, "chrome"));
    glyphPosition += visibleWidth(hidden);
  }
  for (const [offset, cell] of row.cells.entries()) {
    if (offset > 0) {
      glyphs.push(segment("─", "brass dim"));
      glyphPosition += 1;
    }
    const { glyph, role } = pathMarker(cell, streamTargetId);
    const marker = `${cell.cursor ? "▸" : ""}${glyph}`;
    glyphs.push(segment(marker, role));
    const markerWidth = visibleWidth(marker);
    takeRegions.push({ left: glyphPosition, right: glyphPosition + markerWidth, take: cell.take });
    glyphPosition += markerWidth;
  }
  if (row.hiddenAfter > 0) glyphs.push(segment(` ${row.hiddenAfter}›`, "chrome"));
  const badge = cursorCell?.bookmark ?? row.cells.find((cell) => cell.node.id === shown.id)?.bookmark ?? null;
  return {
    depth: row.depth,
    cursorHere: row.cursorHere,
    glyphs,
    glyphWidth: glyphs.reduce((sum, part) => sum + visibleWidth(part.text), 0),
    takeRegions,
    currentTake: cursorCell?.take ?? 0,
    takeCount: cursorCell?.takeCount ?? 0,
    counter: cursorCell !== undefined && cursorCell.takeCount > 1
      ? `‹ take ${cursorCell.take}/${cursorCell.takeCount} ›`
      : "",
    preview: shown.preview.replace(/\s+/g, " "),
    previewRole: row.cursorHere ? "prose" : shown.role === "summary" ? "summary" : "prose · dim",
    words: `${shown.words}w${shown.id === streamTargetId ? "+" : ""}`,
    badgeText: badge === null ? "" : ` ${bookmarkGlyph(badge.label)} ${truncate(badge.name, 14)}`,
    bookmark: badge
  };
}

/** How a take presents itself — one decision, so the shape and the color can
 * never drift apart.
 *
 * Decision 18a: the ring says a take has an inside. `◉` is the shown line's
 * ringed take, `◎` an alternate's; leaves stay `●`/`○`. The cursor's own take is
 * never ringed: its subtakes are the rows below it, and `▸` plus the take
 * counter already say where you are. */
function pathMarker(cell: PathCell, streamTargetId: string | null): PathMarker {
  if (cell.node.role === "summary") return marker("◈", cell, "summary");
  // Streaming outranks both the ring and the cursor, as it always has: where
  // the ink is landing right now is worth more for the seconds it lasts than
  // either what is inside the take or where the reader's cursor rests. An
  // append stream at a stopped line is the one place those can coincide.
  if (cell.node.id === streamTargetId) return marker("◌", cell);
  if (cell.cursor) return marker("●", cell);
  return marker(cell.subtakes ? (cell.active ? "◉" : "◎") : (cell.active ? "●" : "○"), cell);
}

interface PathMarker { glyph: string; role: DisplayRole }

/** Being the cursor, then being on the shown line, outranks a cell's own
 * resting color. */
function marker(glyph: string, cell: PathCell, resting: DisplayRole = "prose · dim"): PathMarker {
  return { glyph, role: cell.cursor ? "focus / accent" : cell.active ? "accent · deep" : resting };
}

/** Full-bleed path row. No surface background: the MAP canvas owns it. */
export function renderMapPathRow(
  row: MapPathRow,
  depthField: number,
  glyphField: number,
  counterField: number,
  badgeField: number,
  width: number
): FrameLine {
  const fixed = depthField + glyphField + counterField + 7 + badgeField + 4;
  const previewWidth = Math.max(12, width - fixed);
  return [
    segment(`  ¶ ${String(row.depth).padStart(depthField - 6)}  `, "chrome"),
    ...row.glyphs,
    segment(" ".repeat(Math.max(1, glyphField - row.glyphWidth)), "prose"),
    segment(row.counter.padEnd(counterField), "focus / accent"),
    segment(padCells(truncate(row.preview, previewWidth), previewWidth), row.previewRole),
    segment(row.words.padStart(7), "chrome"),
    segment(row.badgeText, bookmarkRole(row.bookmark))
  ];
}

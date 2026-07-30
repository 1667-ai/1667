import type { SearchHit } from "../../../shared/story-search.js";
import type { SearchGroupRow, SearchHitRow } from "../search-model.js";
import { tagGlyph, tagRole } from "../tag-presentation.js";
import {
  fitLine,
  lineWidth,
  segment,
  truncate,
  visibleWidth,
  type FrameLine,
  type FrameSegment
} from "./story/frame.js";

/** The legibility contract of doc 17a, in cells.
 *
 * The whole point of the re-pass was that a ragged left edge made the results
 * unreadable, so these are a fixed grid and not a layout suggestion: the focus
 * rail owns column 0, every `¶` ref starts at column 4 in a field 6 wide, every
 * snippet starts at column 10, group counts end at column 56, and the pane
 * divider stands at column 58 on every row — blank rows included. */
export const REF_COLUMN = 4;
export const REF_WIDTH = 6;
export const SNIPPET_COLUMN = REF_COLUMN + REF_WIDTH;
export const COUNT_END = 56;
export const DIVIDER_COLUMN = 58;
export const PREVIEW_COLUMN = DIVIDER_COLUMN + 3;

/** Below this the preview pane is dropped and the hit list takes the screen,
 *  the same width rule the map uses for its own preview line. */
export const PREVIEW_MIN_WIDTH = 100;

export function renderGroupRow(row: SearchGroupRow, focused: boolean, listWidth: number): FrameLine {
  const glyph = row.folded ? "▸" : row.sort === "line" && row.tag !== null ? tagGlyph(row.tag.status)
    : row.sort === "branch" ? "↳"
      : row.sort === "story" ? "▾" : "◆";
  const nameRole = row.sort === "line" && row.tag !== null ? tagRole(row.tag)
    : row.sort === "story" && !row.folded ? "prose" : "prose · dim";
  const countNum = row.hits.length;
  const count = countNum === 0 ? "" : `${countNum} ${countNum === 1 ? "hit" : "hits"}`;
  const countEnd = Math.min(COUNT_END, Math.max(0, listWidth - 2));
  const line: FrameLine = [
    segment(focused ? "▌ " : "  ", focused ? "focus / accent" : "chrome"),
    segment(`${glyph} `, row.folded ? "chrome" : "accent · deep")
  ];
  // The count is the one thing that may never be pushed off the row, so the
  // name yields its cells first and always keeps a two-cell gap before it.
  const reserved = visibleWidth(count) + visibleWidth(row.detail) + 4;
  const room = Math.max(4, countEnd - lineWidth(line) - reserved);
  line.push(segment(truncate(row.name, room), nameRole));
  if (row.detail.length > 0) line.push(segment(`  ${row.detail}`, "chrome"));
  const padding = countEnd - visibleWidth(count) - lineWidth(line);
  if (padding > 0) line.push(segment(" ".repeat(padding)));
  if (count.length > 0) line.push(segment(count, "summary"));
  return line;
}

export function renderHitRow(row: SearchHitRow, focused: boolean, listWidth: number): FrameLine {
  const line: FrameLine = [
    segment(focused ? "▌" : " ", focused ? "focus / accent" : "chrome"),
    segment(" ".repeat(REF_COLUMN - 1))
  ];
  line.push(segment(
    truncate(hitReference(row), REF_WIDTH).padEnd(REF_WIDTH),
    focused ? "summary" : "chrome"
  ));
  const room = Math.max(4, Math.min(COUNT_END, listWidth - 2) - SNIPPET_COLUMN);
  line.push(...highlightedSnippet(row.hit, focused, room));
  return line;
}

/** The ref field says which corpus a hit came from: a part's prose, the prompt
 *  that made it, or a fact. */
export function hitReference(row: SearchHitRow): string {
  const hit = row.hit;
  if (hit.kind === "fact") return "fact";
  return `${hit.kind === "prompt" ? "»" : "¶"}${hit.depth}`;
}

/** One bright thing per screen: every match takes a low-contrast wash, and only
 *  the focused row's match is painted solid. */
export function highlightedSnippet(hit: SearchHit, focused: boolean, room: number): FrameLine {
  const lead = hit.snippet.slice(0, hit.snippetMatch);
  const match = hit.snippet.slice(hit.snippetMatch, hit.snippetMatch + hit.matchLength);
  const tail = hit.snippet.slice(hit.snippetMatch + hit.matchLength);
  const textRole = focused ? "prose" : "prose · dim";
  const matchSegment: FrameSegment = focused
    ? { text: match, role: "background", background: "focus / accent", bold: true }
    : { text: match, role: "focus / accent", background: "raised" };
  const line: FrameLine = [
    segment(lead, textRole),
    matchSegment,
    segment(tail, textRole)
  ];
  return fitLine(line, room);
}

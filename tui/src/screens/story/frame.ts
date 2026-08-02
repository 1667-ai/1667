import { StyledText, bg, fg, type ColorInput, type TextChunk } from "@opentui/core";
import type { Palette, PaletteRole } from "../../palette.js";
import { cellWidth, graphemeCells, isPrintableAscii } from "../../cell-width.js";
import type { HitTarget } from "../../hit.js";
import { terminalLineText, terminalProseText } from "../../../../shared/terminal-text.js";

export type LogoDisplayRole =
  | "logo red" | "logo orange" | "logo yellow" | "logo green"
  | "logo cyan" | "logo blue" | "logo violet";

export type DisplayRole = PaletteRole | "brass dim" | "human edit dim" | "danger text" | "context warning"
  | "context voice" | "context facts" | "context recent" | "context summary" | "context note"
  | "context growth" | "context growth pulse" | "fresh 1" | "fresh 2"
  | "match wash" | "match ink"
  | LogoDisplayRole;

/** Every display role that is not a palette role in its own right. */
type DisplayAlias = Exclude<DisplayRole, PaletteRole>;

export interface FrameSegment {
  text: string;
  role?: DisplayRole;
  background?: DisplayRole;
  bold?: boolean;
  hit?: HitTarget;
  /** This segment is prose a wrapper laid out. Bidi controls and LF survive. */
  prose?: true;
  /** Raw composer grapheme at the first cell of this rendered text. */
  composerStart?: number;
  /** Multi-buffer source identity and whether painted text maps to an edit. */
  composerSource?: {
    id: string;
    editable: boolean;
  };
  /** Raw story field at the first grapheme of this rendered text. */
  storySource?: {
    key: string;
    text: string;
    start: number;
  };
}

export type FrameLine = FrameSegment[];

export interface FrameRegion {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface FrameComposition {
  lines: FrameLine[];
  selectable: FrameRegion | null;
}

/** F-1's typing caret. One caret app-wide: the filter, prompt and tag-name
 *  rows used to draw `▌`, which the package assigns to the C-08 out-of-range
 *  pin and the search focus rail — never to a caret. */
export const TYPING_CARET = "█";

export function segment(text: string, role?: DisplayRole, hit?: HitTarget): FrameSegment {
  const result: FrameSegment = { text };
  if (role !== undefined) result.role = role;
  if (hit !== undefined) result.hit = hit;
  return result;
}

export function isLogoDisplayRole(role: DisplayRole | undefined): role is LogoDisplayRole {
  return role?.startsWith("logo ") === true;
}

export function plainLine(line: FrameLine): string {
  return line.map((part) => part.text).join("");
}

/** The one place stored text becomes drawn text. Every terminal surface reaches
 * the screen through `frameText` or `frameStyledText`, so a control character
 * loses its power here and a new surface cannot forget to ask. The projection
 * preserves length and cell width, which is why measurement can precede it. */
function drawnText(part: FrameSegment): string {
  return part.prose === true ? terminalProseText(part.text) : terminalLineText(part.text);
}

export function frameText(lines: readonly FrameLine[]): string {
  return lines.map((line) => line.map(drawnText).join("")).join("\n");
}

const FRESH_ROLES: ReadonlySet<DisplayRole> = new Set(["streaming", "fresh 1", "fresh 2"]);

export function frameStyledText(lines: readonly FrameLine[], palette: Palette): StyledText {
  const chunks: TextChunk[] = [];
  let pending: { text: string; role: DisplayRole; background?: DisplayRole; bold: boolean } | null = null;
  const flush = () => {
    if (pending === null) return;
    let chunk = fg(displayColor(pending.role, palette))(pending.text);
    if (pending.background !== undefined) chunk = bg(displayColor(pending.background, palette))(chunk);
    if (pending.bold) chunk.attributes = (chunk.attributes ?? 0) | 1;
    chunks.push(chunk);
    pending = null;
  };
  const append = (text: string, role: DisplayRole, background: DisplayRole | undefined, bold: boolean) => {
    if (pending !== null && pending.role === role && pending.background === background && pending.bold === bold) {
      pending.text += text;
    } else {
      flush();
      pending = { text, role, background, bold };
    }
  };
  for (const [lineIndex, line] of lines.entries()) {
    for (const part of line) {
      // Light themes land fresh ink wet-dark and bold (spec §10 polarity rule).
      const bold = part.bold === true || (palette.freshBold && part.role !== undefined && FRESH_ROLES.has(part.role));
      append(drawnText(part), part.role ?? "prose · dim", part.background, bold);
    }
    if (lineIndex < lines.length - 1) append("\n", "chrome", undefined, false);
  }
  flush();
  return new StyledText(chunks);
}

/** Cell-accurate frame slice. Used to give the facts rail its own
 * non-selectable text buffer without changing the renderer's frame model. */
export function sliceFrame(lines: readonly FrameLine[], start: number, width: number): FrameLine[] {
  return lines.map((line) => sliceLine(line, start, width));
}

/** Split once at a cell boundary; a crossing wide glyph becomes spaces and
 * may be repainted by the surface's overlay glyph layer. */
export function splitFrame(lines: readonly FrameLine[], at: number): [FrameLine[], FrameLine[], FrameBoundaryGlyph[]] {
  const left: FrameLine[] = [];
  const right: FrameLine[] = [];
  const boundaries: FrameBoundaryGlyph[] = [];
  for (const [row, line] of lines.entries()) {
    const split = splitLine(line, at);
    left.push(split[0]);
    right.push(split[1]);
    if (split[2] !== null) boundaries.push({ row, ...split[2] });
  }
  return [left, right, boundaries];
}

function splitLine(line: FrameLine, at: number): [FrameLine, FrameLine, Omit<FrameBoundaryGlyph, "row"> | null] {
  const left: FrameLine = [];
  const right: FrameLine = [];
  let boundary: Omit<FrameBoundaryGlyph, "row"> | null = null;
  let position = 0;
  for (const part of line) {
    let leftText = "";
    let rightText = "";
    if (isPrintableAscii(part.text)) {
      const end = position + part.text.length;
      if (end <= at) leftText = part.text;
      else if (position >= at) rightText = part.text;
      else {
        const splitAt = at - position;
        leftText = part.text.slice(0, splitAt);
        rightText = part.text.slice(splitAt);
      }
      position = end;
      if (leftText.length > 0) left.push({ ...part, text: leftText });
      if (rightText.length > 0) right.push({ ...part, text: rightText });
      continue;
    }
    for (const cell of graphemeCells(part.text)) {
      const cellEnd = position + cell.width;
      if (cellEnd <= at) leftText += cell.text;
      else if (position >= at) rightText += cell.text;
      else {
        leftText += " ".repeat(Math.max(0, at - position));
        rightText += " ".repeat(Math.max(0, cellEnd - at));
        boundary = { left: position, line: [{ ...part, text: cell.text }] };
      }
      position = cellEnd;
    }
    if (leftText.length > 0) left.push({ ...part, text: leftText });
    if (rightText.length > 0) right.push({ ...part, text: rightText });
  }
  return [left, right, boundary];
}

export interface FrameBoundaryGlyph {
  row: number;
  left: number;
  line: FrameLine;
}

/** Extract the one grapheme per row that crosses a fixed surface boundary. */
export function frameBoundaryGlyphs(lines: readonly FrameLine[], boundary: number): FrameBoundaryGlyph[] {
  const glyphs: FrameBoundaryGlyph[] = [];
  for (const [row, line] of lines.entries()) {
    let position = 0;
    let found = false;
    for (const part of line) {
      for (const cell of graphemeCells(part.text)) {
        const end = position + cell.width;
        if (position < boundary && end > boundary) {
          glyphs.push({ row, left: position, line: [{ ...part, text: cell.text }] });
          found = true;
          break;
        }
        position = end;
      }
      if (found) break;
    }
  }
  return glyphs;
}

function sliceLine(line: FrameLine, start: number, width: number): FrameLine {
  const result: FrameLine = [];
  const end = start + width;
  let position = 0;
  for (const part of line) {
    let text = "";
    for (const cell of graphemeCells(part.text)) {
      const cellEnd = position + cell.width;
      const overlap = Math.max(0, Math.min(end, cellEnd) - Math.max(start, position));
      if (overlap === cell.width) text += cell.text;
      else if (overlap > 0) text += " ".repeat(overlap);
      position = cellEnd;
      if (position >= end) break;
    }
    if (text.length > 0) result.push({ ...part, text });
    if (position >= end) break;
  }
  return result;
}

export function visibleWidth(value: string): number {
  return cellWidth(value);
}

/** Cells a rendered line occupies. Every column-aligned view needs this, so it
 * lives beside `visibleWidth` rather than being redefined per screen. */
export function lineWidth(line: FrameLine): number {
  return line.reduce((sum, part) => sum + visibleWidth(part.text), 0);
}

/** Pad to a column width, measured in cells rather than code units so wide
 * glyphs cannot drift a column. */
export function padCells(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

export function padStartCells(value: string, width: number): string {
  return " ".repeat(Math.max(0, width - visibleWidth(value))) + value;
}

export const HINT_SEPARATOR = " · ";

/** One item in a hint line and how readily it yields its cells. Rank 0 always
 * survives; higher ranks are shed first. */
export interface HintItem {
  segments: FrameLine;
  rank: number;
}

export function hintItem(segments: FrameLine, rank = 0): HintItem {
  return { segments, rank };
}

function hintWidth(items: readonly HintItem[]): number {
  return items.reduce((total, item, index) =>
    total + (index === 0 ? 0 : visibleWidth(HINT_SEPARATOR))
      + item.segments.reduce((width, part) => width + visibleWidth(part.text), 0), 0);
}

/** Join hint items into one line, dropping whole items until the rest fits.
 * Clipping the joined string instead leaves a half-written key on screen —
 * `m m…`, `esc cance…` — which reads as a rendering fault rather than as a
 * hint that ran out of room. Every surface that advertises keys joins here.
 *
 * Ties drop the rightmost, so equal-ranked items shed in reading order rather
 * than by whichever the scan happened to reach first. Once only rank 0 is left
 * and it still does not fit, whole items go from the end: losing a key outright
 * beats printing half of one. */
export function joinHints(items: readonly HintItem[], budget: number): FrameLine {
  const kept = [...items];
  while (kept.length > 1 && hintWidth(kept) > budget) {
    let weakest = 0;
    for (let index = 1; index < kept.length; index += 1) {
      if (kept[index]!.rank >= kept[weakest]!.rank) weakest = index;
    }
    kept.splice(kept[weakest]!.rank === 0 ? kept.length - 1 : weakest, 1);
  }
  return kept.flatMap((item, index) => index === 0
    ? item.segments
    : [segment(HINT_SEPARATOR, "chrome"), ...item.segments]);
}

export function truncate(value: string, width: number): string {
  if (cellWidth(value) <= width) return value;
  if (width < 1) return "";
  let used = 0;
  let result = "";
  for (const cell of graphemeCells(value)) {
    if (used + cell.width > width - 1) break;
    result += cell.text;
    used += cell.width;
  }
  return `${result}…`;
}

export function truncateTail(value: string, width: number): string {
  if (cellWidth(value) <= width) return value;
  if (width < 1) return "";
  const cells = graphemeCells(value);
  let used = 1;
  let result = "";
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    const cell = cells[index]!;
    if (used + cell.width > width) break;
    result = cell.text + result;
    used += cell.width;
  }
  return `…${result}`;
}

export function fitLine(line: FrameLine, width: number): FrameLine {
  const result: FrameLine = [];
  let used = 0;
  for (const part of line) {
    if (used >= width) break;
    const text = truncate(part.text, width - used);
    const clippedSource = text !== part.text && text.endsWith("…")
      && (part.storySource !== undefined || part.composerStart !== undefined);
    if (clippedSource) {
      const visible = text.slice(0, -1);
      if (visible.length > 0) result.push({ ...part, text: visible });
      const {
        storySource: _storySource,
        composerStart: _composerStart,
        composerSource: _composerSource,
        ...decoration
      } = part;
      result.push({ ...decoration, text: "…" });
    } else {
      result.push({ ...part, text });
    }
    used += visibleWidth(text);
  }
  if (used < width) result.push(segment(" ".repeat(width - used), "background"));
  return result;
}

/**
 * Where every alias gets its color. Being a total record, an alias added to
 * `DisplayRole` cannot be forgotten here.
 *
 * The five meter slices (doc 12b) borrow hues the theme already owns rather
 * than inventing four more: the standing voice is the writer's own ink, facts
 * take the alt-tag violet, recent prose carries the page accent because it
 * is what actually fills the window, and a summary is sepia wherever the theme
 * puts sepia. Each theme recolors the meter for free — and because they stay
 * display roles of their own, the COMPOSE recolor still leaves them alone.
 */
const ALIAS_COLOR: Record<DisplayAlias, (palette: Palette) => ColorInput> = {
  "brass dim": (palette) => palette.brassDim,
  "human edit dim": (palette) => palette.humanEditDim,
  "danger text": (palette) => palette.dangerText,
  "context warning": (palette) => palette.contextWarning,
  "context voice": (palette) => palette.color("human edit"),
  "context facts": (palette) => palette.color("tag · alt"),
  "context recent": (palette) => palette.color("focus / accent"),
  "context summary": (palette) => palette.color("summary"),
  "context note": (palette) => palette.color("tag · canon"),
  // Forecast cells must stay off the request-fill palette (focus / accent,
  // context warning, danger). Brass and draft cool keep both pulse phases
  // distinct from every severity's request ink without reading as an alert.
  "context growth": (palette) => palette.brassDim,
  "context growth pulse": (palette) => palette.color("tag · draft"),
  // Decision 22's search wash: the tint an unfocused hit takes, and the ink
  // that stays legible on it. Solid accent is reserved for the focused row.
  "match wash": (palette) => palette.matchWash,
  "match ink": (palette) => palette.matchInk,
  "fresh 1": (palette) => palette.freshIntermediate[0],
  "fresh 2": (palette) => palette.freshIntermediate[1],
  "logo red": (palette) => palette.color("danger"),
  "logo orange": (palette) => palette.logoOrange,
  "logo yellow": (palette) => palette.color("tag · canon"),
  "logo green": (palette) => palette.logoGreen,
  "logo cyan": (palette) => palette.logoCyan,
  "logo blue": (palette) => palette.logoBlue,
  "logo violet": (palette) => palette.color("tag · alt")
};

function isAlias(role: DisplayRole): role is DisplayAlias {
  return role in ALIAS_COLOR;
}

/** The color a display role paints in, alias or palette role alike. Every
 * renderer and every contract test resolves through this one function. */
export function displayColor(role: DisplayRole, palette: Palette): ColorInput {
  return isAlias(role) ? ALIAS_COLOR[role](palette) : palette.color(role);
}

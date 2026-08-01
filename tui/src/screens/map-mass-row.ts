import { shortDate, type AtlasLayout, type AtlasRow } from "../atlas-layout.js";
import { tagGlyph, tagRole, formatMapWordsBare, mapLineName } from "./map-row-labels.js";
import {
  padCells,
  padStartCells,
  segment,
  truncate,
  visibleWidth,
  type DisplayRole,
  type FrameLine
} from "./story/frame.js";

/** Doc 26a: four fixed columns — marker, name, one bar track, then a metadata
 * gutter of words, parts and a single state word. Nothing about a row's own
 * numbers may move a column, or the bars stop reading as one scale. */
export interface MapMassScale {
  narrow: boolean;
  labelWidth: number;
  wordsWidth: number;
  partsWidth: number;
  stateWidth: number;
  barWidth: number;
  massMaximum: number;
}

const MARKER_WIDTH = 4;
const COLUMN_GAP = 2;
const SKETCH_STATE = "never continued";

/** Decision 21 pins the grid itself, not only its shape: name 18 · track 46 ·
 * words 6 · parts 8. Measuring the columns per frame made the same story draw a
 * different chart at a different width, which is the comparison the view
 * exists for. Terminals too narrow to hold the pinned grid fall back to the
 * measured one — a clipped right edge would break the contract further. */
const PINNED_COLUMNS = {
  labelWidth: 18,
  barWidth: 46,
  wordsWidth: 6,
  partsWidth: 8
} as const;

/** One presentation scale for the complete mass view. Metadata may vary by
 * row, but it must never change the field used to compare line mass. */
export function createMapMassScale(layout: AtlasLayout, width: number): MapMassScale {
  const narrow = width < 100;
  const sketches = layout.sketchCount > 0;
  let wordsWidth = Math.max(6, sketches ? visibleWidth(formatMapWordsBare(layout.sketchWords)) : 0);
  let partsWidth = sketches ? visibleWidth(sketchParts(narrow)) : 0;
  let stateWidth = sketches ? visibleWidth(SKETCH_STATE) : 0;
  for (const row of layout.allRows) {
    wordsWidth = Math.max(wordsWidth, visibleWidth(formatMapWordsBare(massWords(row))));
    partsWidth = Math.max(partsWidth, visibleWidth(massParts(row, narrow)));
    stateWidth = Math.max(stateWidth, visibleWidth(massState(row, isActiveLine(row))?.text ?? ""));
  }
  if (!narrow && width >= pinnedGridWidth(stateWidth)
    && wordsWidth <= PINNED_COLUMNS.wordsWidth && partsWidth <= PINNED_COLUMNS.partsWidth) {
    return { narrow, ...PINNED_COLUMNS, stateWidth, massMaximum: layout.massMaximum };
  }
  // The bar track takes what the fixed columns leave, so no row can be cut off
  // at the right edge — the widest state word is reserved for even where a
  // given row has none.
  const labelWidth = narrow ? 16 : 20;
  const barWidth = Math.max(3, width - MARKER_WIDTH - labelWidth
    - COLUMN_GAP - wordsWidth - COLUMN_GAP - partsWidth - COLUMN_GAP - stateWidth);
  return { narrow, labelWidth, wordsWidth, partsWidth, stateWidth, barWidth, massMaximum: layout.massMaximum };
}

/** Cells the pinned grid needs, including the widest state word this story
 *  actually draws. */
function pinnedGridWidth(stateWidth: number): number {
  return MARKER_WIDTH + PINNED_COLUMNS.labelWidth + PINNED_COLUMNS.barWidth
    + COLUMN_GAP + PINNED_COLUMNS.wordsWidth + COLUMN_GAP + PINNED_COLUMNS.partsWidth
    + COLUMN_GAP + stateWidth;
}

/** Full-bleed mass row, scaled against the largest complete line. */
export function renderMapMassRow(row: AtlasRow, scale: MapMassScale): FrameLine {
  const words = massWords(row);
  const active = isActiveLine(row);
  const cells = words === 0 ? 0
    : Math.min(scale.barWidth, Math.max(1, Math.round(words / scale.massMaximum * scale.barWidth)));
  return massRow(scale, {
    cursor: row.cursor,
    active,
    label: row.kind === "sketch"
      ? row.fragment ?? `unnamed · ${shortDate(row.node.lastTouched)}`
      : mapLineName(row),
    // Doc 26a moves the tag glyph to the state column but not its ink: a
    // never-continued fragment must still read quieter than a named line.
    labelRole: active ? "focus / accent"
      : row.kind === "sketch" ? "prose · dim" : tagRole(row.tag),
    bar: "█".repeat(cells),
    // Doc 26a: colour stops duplicating length. One ember amber for every bar,
    // with brightness reserved for state — lantern where you stand, sunk where
    // the line has gone cold.
    barRole: active ? "focus / accent" : row.stale ? "dimmed page" : "accent · deep",
    words: formatMapWordsBare(words),
    parts: massParts(row, scale.narrow),
    state: massState(row, active)
  });
}

/** The sketches fold, drawn on the same grid rather than as a loose hairline:
 * one tick of a bar so the eye reads it as the smallest thing on the chart. The
 * count is what the fold really holds — nothing caps a sketch's length, so a
 * fixed `<1k` would misreport an imported or long one. */
export function renderMapSketchFold(layout: AtlasLayout, scale: MapMassScale): FrameLine {
  return massRow(scale, {
    cursor: false,
    active: false,
    label: `…${layout.sketchCount} sketches`,
    labelRole: "prose · dim",
    bar: "▏",
    barRole: "dimmed page",
    words: formatMapWordsBare(layout.sketchWords),
    parts: sketchParts(scale.narrow),
    state: { text: SKETCH_STATE, role: "prose · dim" }
  });
}

interface MassRowContent {
  cursor: boolean;
  active: boolean;
  label: string;
  labelRole: DisplayRole;
  bar: string;
  barRole: DisplayRole;
  words: string;
  parts: string;
  state: { text: string; role: DisplayRole } | null;
}

function massRow(scale: MapMassScale, content: MassRowContent): FrameLine {
  // Cursor and current-line identity are independent: the cursor commonly
  // opens on the active line, so one must never erase the other.
  const marker = `${content.cursor ? "▸" : " "} ${content.active ? "◉" : " "} `;
  const line: FrameLine = [
    segment(marker, content.cursor || content.active ? "focus / accent" : "prose · dim"),
    segment(padCells(truncate(content.label, scale.labelWidth - 2), scale.labelWidth), content.labelRole),
    segment(padCells(content.bar, scale.barWidth), content.barRole),
    segment("  "),
    segment(`${padStartCells(content.words, scale.wordsWidth)}  ${padCells(content.parts, scale.partsWidth)}`,
      content.active ? "focus / accent" : "chrome")
  ];
  if (content.state !== null) line.push(segment("  "), segment(content.state.text, content.state.role));
  return line;
}

/** One word per row at most, in the order the reader needs it: where they are,
 * then why a line looks abandoned, then what it is called. */
function massState(row: AtlasRow, active: boolean): MassRowContent["state"] {
  if (active) return { text: "← here", role: "focus / accent" };
  if (row.stale) return { text: "cold", role: "prose · dim" };
  if (row.tag !== null) {
    return { text: tagGlyph(row.tag.status), role: tagRole(row.tag) };
  }
  return null;
}

function massWords(row: AtlasRow): number {
  return row.kind === "sketch" ? row.ownWords : row.words;
}

function massParts(row: AtlasRow, narrow: boolean): string {
  return narrow ? `${row.depth}p` : `${row.depth} parts`;
}

/** Every sketch is a childless take, so each is exactly one paragraph. */
function sketchParts(narrow: boolean): string {
  return narrow ? "1p each" : "1 ¶ each";
}

function isActiveLine(row: AtlasRow): boolean {
  return row.active && row.kind !== "sketch";
}

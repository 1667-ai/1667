import { shortDate, type AtlasLayout, type AtlasRow } from "../atlas-layout.js";
import { bookmarkRole, formatMapWords, mapLineLabel } from "./map-row-labels.js";
import {
  segment,
  truncate,
  visibleWidth,
  type DisplayRole,
  type FrameLine
} from "./story/frame.js";

export interface MapMassScale {
  narrow: boolean;
  labelWidth: number;
  wordsWidth: number;
  partsWidth: number;
  hereWidth: number;
  barWidth: number;
  massMaximum: number;
}

/** One presentation scale for the complete mass view. Metadata may vary by
 * row, but it must never change the field used to compare line mass. */
export function createMapMassScale(layout: AtlasLayout, width: number): MapMassScale {
  const narrow = width < 100;
  const labelWidth = narrow ? 16 : 20;
  let wordsWidth = 6;
  let partsWidth = 0;
  let hereWidth = 0;
  for (const row of layout.allRows) {
    wordsWidth = Math.max(wordsWidth, visibleWidth(formatMapWords(massWords(row))));
    partsWidth = Math.max(partsWidth, visibleWidth(massParts(row, narrow)));
    if (isActiveLine(row)) hereWidth = visibleWidth("  ← here");
  }
  const metadataWidth = wordsWidth + 2 + partsWidth + hereWidth;
  const barWidth = Math.max(3, width - 2 - 3 - labelWidth - 1 - 2 - metadataWidth);
  return { narrow, labelWidth, wordsWidth, partsWidth, hereWidth, barWidth, massMaximum: layout.massMaximum };
}

/** Full-bleed mass row, scaled against the largest complete line. */
export function renderMapMassRow(row: AtlasRow, scale: MapMassScale): FrameLine {
  const words = massWords(row);
  const active = isActiveLine(row);
  // Cursor and current-line identity are independent: the cursor commonly
  // opens on the active line, so one must never erase the other.
  const markers = `${row.cursor ? "▸" : " "}${active ? "◉" : " "} `;
  const shownLabel = row.kind === "sketch"
    ? row.fragment ?? `unnamed · ${shortDate(row.node.lastTouched)}`
    : mapLineLabel(row);
  const parts = massParts(row, scale.narrow);
  const here = active ? "  ← here" : "";
  const metadata = `${padStartCells(formatMapWords(words), scale.wordsWidth)}  ${padCells(parts, scale.partsWidth)}`
    + `${here}${" ".repeat(Math.max(0, scale.hereWidth - visibleWidth(here)))}`;
  const cells = words === 0 ? 0
    : Math.min(scale.barWidth, Math.max(1, Math.round(words / scale.massMaximum * scale.barWidth)));
  const ratio = words / scale.massMaximum;
  const barRole: DisplayRole = active ? "focus / accent"
    : ratio >= 0.66 ? "accent · deep" : ratio >= 0.33 ? "brass dim" : "chrome";
  const label = truncate(shownLabel, scale.labelWidth);
  return [
    segment("  "),
    segment(markers, row.cursor || active ? "focus / accent" : "prose · dim"),
    segment(padCells(label, scale.labelWidth), row.kind === "sketch" ? "prose · dim" : bookmarkRole(row.bookmark)),
    segment(" "),
    segment("█".repeat(cells).padEnd(scale.barWidth), barRole),
    segment("  "),
    segment(metadata, active ? "focus / accent" : "chrome")
  ];
}

function massWords(row: AtlasRow): number {
  return row.kind === "sketch" ? row.ownWords : row.words;
}

function massParts(row: AtlasRow, narrow: boolean): string {
  return narrow ? `${row.depth}p` : `${row.depth} parts`;
}

function isActiveLine(row: AtlasRow): boolean {
  return row.active && row.kind !== "sketch";
}

export function renderMapSketchHairline(layout: AtlasLayout, width: number): FrameLine {
  const label = `…${layout.sketchCount} sketches`;
  const suffix = "never continued";
  const ticks = "▏".repeat(Math.max(1, Math.min(
    layout.sketchCount,
    width - visibleWidth(label) - visibleWidth(suffix) - 8
  )));
  return [
    segment("  "),
    segment(label, "prose · dim"),
    segment("  "),
    segment(ticks, "dimmed page"),
    segment(`  ${suffix}`, "prose · dim")
  ];
}

function padCells(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function padStartCells(value: string, width: number): string {
  return " ".repeat(Math.max(0, width - visibleWidth(value))) + value;
}

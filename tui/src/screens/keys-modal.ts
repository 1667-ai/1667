import { type HitRows } from "../hit.js";
import { AI_1667_VERSION_TAG } from "../../../shared/build-identity.js";
import {
  KEYS_MODAL_MODEL,
  type KeysModalBinding,
  type KeysModalEntry,
  type KeysModalModel,
  type KeysModalSection
} from "../keys-reference-model.js";
import {
  panelContentRows,
  panelHorizontalGeometry,
  panelWidthForContent,
  placePanel,
  raisedSegment
} from "./overlay.js";
import { boundedContent, panelRange } from "./panel-table-layout.js";
import { lineWidth, visibleWidth, type DisplayRole, type FrameComposition, type FrameLine } from "./story/frame.js";
import { wrapText } from "../wrap.js";

export {
  KEYS_MODAL_MODEL,
  type KeysModalBinding,
  type KeysModalEntry,
  type KeysModalModel,
  type KeysModalSection
};

/** Copy budget, not a measurement of the copy: exceeding it truncates rather
 *  than reflowing, so the panel geometry cannot be widened by a long line. */
const DESCRIPTION_BUDGET = 24;
/** The key column is as wide as the widest key, and no wider.
 *
 * Section headings share the column but do not widen it: letting `● SEARCH`
 * set the width cost every column a cell, which dropped an 80-column terminal
 * from two columns to one. A heading longer than the column keeps its full
 * text and takes the extra cell from its own blurb's slack, which is the one
 * row on the panel that has some. */
const TOKEN_WIDTH = Math.max(...KEYS_MODAL_MODEL.sections.flatMap((section) =>
  section.entries.map((item) => visibleWidth(item.token))));
const COLUMN_WIDTH = TOKEN_WIDTH + 2 + DESCRIPTION_BUDGET;
const COLUMN_GUTTER = 2;
const MAX_COLUMNS = 3;
/** Wide enough to hold every column, whatever the frame spends on its edges. */
const PANEL_MAX_WIDTH = panelWidthForContent(
  MAX_COLUMNS * COLUMN_WIDTH + (MAX_COLUMNS - 1) * COLUMN_GUTTER
);

export interface KeysOverlayRender {
  composition: FrameComposition;
  /** Scroll offset after clamping, for the caller to store back. */
  scrollTop: number;
}

export function renderKeysOverlay(
  base: FrameLine[],
  hits: HitRows,
  width: number,
  height: number,
  scrollTop = 0,
  buildIdentity = `1667 ${AI_1667_VERSION_TAG}`
): KeysOverlayRender {
  const horizontal = panelHorizontalGeometry(width, PANEL_MAX_WIDTH);
  const interior = horizontal.contentWidth;
  const columns = columnCount(interior);
  const footerCapacity = horizontal.footerWidth;
  const wrappedBuildIdentity = visibleWidth(buildIdentity) > footerCapacity;
  const rows = [
    ...layoutRows(interior, columns),
    ...(wrappedBuildIdentity
      ? [
          [],
          [{ ...raisedSegment("● BUILD", "brass dim"), bold: true }],
          ...wrapText(buildIdentity, [], interior)
            .map((line) => [raisedSegment(line.text, "prose · dim")])
        ]
      : [])
  ];
  // Slicing more than the panel will paint would leave rows behind a bound
  // that never reaches them, and make the title's range a lie.
  const visibleRows = panelContentRows(height);
  const top = Math.max(0, Math.min(scrollTop, Math.max(0, rows.length - visibleRows)));
  const window = { start: top, end: Math.min(top + visibleRows, rows.length) };
  const content = rows.slice(window.start, window.end);
  const range = panelRange(rows.length, window);
  // The status bar hides its build tag on a narrow terminal, so the reference
  // is where `1667 v…` is always reachable.
  const footerCopy = range === ""
    ? "drag selects · ctrl+c copies · esc closes"
    : "↑↓ scrolls · esc closes";
  const expandedFooter = `${buildIdentity} · ${footerCopy}`;
  const compactFooter = visibleWidth(expandedFooter) > footerCapacity;
  const footer = !compactFooter
    ? expandedFooter
    : wrappedBuildIdentity
      ? "build ↓"
      : buildIdentity;
  // When the footer cannot carry scroll guidance, the short title keeps
  // overflow and the current position visible. It also protects tall, narrow
  // panels where no range exists but the explanatory title cannot fit.
  const expandedTitle = `keys · and what they do${range}`;
  const compactTitle = range === ""
    ? "?"
    : `? ↑↓${window.start + 1}/${rows.length}`;
  const title = (range !== "" && compactFooter)
    || visibleWidth(expandedTitle) > horizontal.titleWidth
    ? compactTitle
    : expandedTitle;

  // Inert, not transparent: without hits the story's own rows stay live under
  // the modal, so a click outside would not even dismiss it.
  return {
    composition: placePanel(
      base,
      title,
      content,
      footer,
      width,
      height,
      PANEL_MAX_WIDTH,
      { rows: hits, targets: content.map(() => null) }
    ),
    scrollTop: top
  };
}

function columnCount(interior: number): number {
  const fits = Math.floor((interior + COLUMN_GUTTER) / (COLUMN_WIDTH + COLUMN_GUTTER));
  return Math.max(1, Math.min(MAX_COLUMNS, fits));
}

/** Sections become blocks, blocks are dealt into columns, and the columns are
 *  zipped back into rows the panel can draw. Dealing whole sections keeps a
 *  heading with its keys; the scroll offset then applies to every column at
 *  once, so a clipped panel reads as one table rather than five. */
/** Chapter dividers and summaries answer to their own verbs — `e` renames a
 *  chapter, `D` removes its break — because `directChapterRowAction` runs
 *  before NAV. No static list can hold both meanings of a key, and the story
 *  already names the focused row's keys in the line beneath it, so the
 *  reference says where to look rather than guessing which row you are on. */
const CONTEXT_NOTE = "◦ chapter rows differ · the line under the story says how";

function layoutRows(interior: number, columns: number): FrameLine[] {
  const cellWidth = columns === 1
    ? interior
    : Math.min(COLUMN_WIDTH, Math.floor((interior - COLUMN_GUTTER * (columns - 1)) / columns));
  const blocks = KEYS_MODAL_MODEL.sections.map((section) => sectionLines(section, cellWidth));
  const strips = dealColumns(blocks, columns);
  const tallest = Math.max(...strips.map((strip) => strip.length));
  const rows: FrameLine[] = [];
  for (let row = 0; row < tallest; row += 1) {
    const line: FrameLine = [];
    for (const [index, strip] of strips.entries()) {
      if (index > 0) line.push(raisedSegment(" ".repeat(COLUMN_GUTTER), "chrome"));
      const cell = strip[row] ?? [];
      line.push(...cell, raisedSegment(" ".repeat(Math.max(0, cellWidth - lineWidth(cell))), "chrome"));
    }
    rows.push(line);
  }
  rows.push([], ...wrapText(CONTEXT_NOTE, [], interior)
    .map((line) => [raisedSegment(line.text, "prose · dim")]));
  return rows;
}

function sectionLines(section: KeysModalSection, cellWidth: number): FrameLine[] {
  // The heading sits in the key column so its blurb starts where the
  // descriptions do: two aligned columns per cell, not a ragged third edge.
  if (cellWidth >= COLUMN_WIDTH) return boundedContent([
    [
      { ...raisedSegment(padKey(heading(section)), section.role), bold: true },
      raisedSegment(`  ${section.blurb}`, "prose · dim")
    ],
    ...section.entries.map((item) => [
      raisedSegment(padKey(item.token), section.role),
      raisedSegment(`  ${item.description}`, "prose · dim")
    ])
  ], cellWidth);
  return [
    ...compactRow(heading(section), section.blurb, section.role, cellWidth, true),
    ...section.entries.flatMap((item) =>
      compactRow(item.token, item.description, section.role, cellWidth, false))
  ];
}

const MIN_INLINE_DESCRIPTION_WIDTH = 12;

/** Narrow terminals keep every meaning by wrapping it. Below the width where
 * the aligned key gutter would starve the copy, the key and meaning stack. */
function compactRow(
  token: string,
  description: string,
  role: DisplayRole,
  width: number,
  bold: boolean
): FrameLine[] {
  const inlineMeasure = width - TOKEN_WIDTH - 2;
  if (inlineMeasure >= MIN_INLINE_DESCRIPTION_WIDTH) {
    return wrapText(description, [], inlineMeasure).map((line, index) => [
      {
        ...raisedSegment(index === 0 ? padKey(token) : " ".repeat(TOKEN_WIDTH), role),
        ...(bold ? { bold: true } : {})
      },
      raisedSegment(`  ${line.text}`, "prose · dim")
    ]);
  }
  const descriptionMeasure = Math.max(1, width - 2);
  return [
    [{ ...raisedSegment(token, role), ...(bold ? { bold: true } : {}) }],
    ...wrapText(description, [], descriptionMeasure)
      .map((line) => [raisedSegment(`  ${line.text}`, "prose · dim")])
  ];
}

function heading(section: KeysModalSection): string {
  return `● ${section.title}`;
}

/** Right-align in the key column by cells; `padStart` counts code units. */
function padKey(token: string): string {
  return " ".repeat(Math.max(0, TOKEN_WIDTH - visibleWidth(token))) + token;
}

/** Contiguous grouping that minimises the tallest column, so the reference is
 *  as short as its sections allow before any of it has to scroll. The smallest
 *  limit greedy packing can meet is the answer; one column always meets the
 *  total, so the search terminates there. */
function dealColumns(blocks: readonly FrameLine[][], columns: number): FrameLine[][] {
  const heights = blocks.map((block) => block.length);
  const total = heights.reduce((sum, value) => sum + value, 0) + blocks.length - 1;
  let limit = Math.max(...heights);
  while (limit < total && packWithin(heights, limit).length > columns) limit += 1;
  return packWithin(heights, limit).map((group) => group.flatMap((index, position) =>
    // A blank row separates sections sharing a column; the first needs none.
    position === 0 ? blocks[index]! : [[], ...blocks[index]!]));
}

/** Greedy contiguous grouping under a height limit, which every block fits:
 *  the caller never searches below the tallest one. */
function packWithin(heights: readonly number[], limit: number): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  let used = 0;
  for (const [index, height] of heights.entries()) {
    const cost = current.length === 0 ? height : height + 1;
    if (used + cost > limit) {
      groups.push(current);
      current = [index];
      used = height;
      continue;
    }
    current.push(index);
    used += cost;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

import { graphemeCells } from "../cell-width.js";
import { addHit, fillRows, type HitRegion, type HitRows, type HitTarget } from "../hit.js";
import type { KeyAction } from "../keys.js";
import {
  fitLine,
  isLogoDisplayRole,
  segment,
  truncate,
  visibleWidth,
  type DisplayRole,
  type FrameComposition,
  type FrameLine,
  type FrameSegment
} from "./story/frame.js";

export function dimPage(lines: FrameLine[]): FrameLine[] {
  return lines.map((line) => line.map((part) => ({
    ...part,
    role: dimRole(part.role),
    background: part.background
  })));
}

/** Click targets for a panel: one entry per content line, so multi-line rows
 *  (wrapped legends and similar) stay aligned with what was drawn. */
export interface PanelHits {
  rows: HitRows;
  /** Parallel to `content`; null for headers, spacers and wrapped detail. */
  targets?: Array<HitTarget | null>;
  /** Column overrides relative to the start of each content line. */
  overrides?: Array<HitRegion[] | undefined>;
  /** Footer keys that run on click. Structurally requires hits, which is why
   *  it lives here rather than as its own parameter. */
  footerActions?: ReadonlyArray<{ token: string; action: KeyAction }>;
  /** Keep the panel top stable while its content grows or shrinks. */
  anchorTop?: boolean;
}

/** The panel geometry every overlay is measured against. Exported because
 *  callers used to re-derive it by hand, which is how a facts body came to be
 *  wrapped against the terminal width instead of the panel's. */
export function panelWidthFor(width: number, maxWidth = 106): number {
  const preferred = Math.max(20, Math.min(width - 8, maxWidth));
  // Preserve a margin even when the terminal is narrower than the preferred
  // 20-cell panel. Otherwise the panel begins at column two and its right edge
  // is silently clipped by `fitLine`.
  return Math.max(1, Math.min(width - 4, preferred));
}

/** One row's two edges and what fills the gap between them. Every row a panel
 *  draws — title, blank, content, footer, closing rule — is one of these three
 *  applied to a line, so a panel cannot end up open on one side, and the
 *  measures below are read off the same values rather than re-derived. */
interface PanelEdges {
  prefix: string;
  suffix: string;
  fill: string;
  fillRole: DisplayRole;
}

const PANEL_TOP: PanelEdges = {
  prefix: "┏━ ", suffix: "━┓", fill: "━", fillRole: "brass dim"
};
const PANEL_BODY: PanelEdges = {
  prefix: "┃ ", suffix: " ┃", fill: " ", fillRole: "prose"
};
/** C-01: title in the top rule, keys in the bottom rule — never a separate
 *  legend line. The keyline used to be a body row above a bare `┗━━┛`, which
 *  spent a content row on chrome and read as one more list entry. */
const PANEL_BOTTOM: PanelEdges = {
  prefix: "┗━ ", suffix: "━┛", fill: "━", fillRole: "brass dim"
};

function interiorWidth(edges: PanelEdges, panelWidth: number): number {
  return Math.max(0, panelWidth - visibleWidth(edges.prefix) - visibleWidth(edges.suffix));
}

/** The panel width whose interior is exactly this many cells. Callers that
 *  size content first — the key reference fits whole columns — ask for the
 *  width that holds it instead of adding up the frame's glyphs themselves. */
export function panelWidthForContent(contentWidth: number): number {
  return contentWidth + visibleWidth(PANEL_BODY.prefix) + visibleWidth(PANEL_BODY.suffix);
}

export interface PanelHorizontalGeometry {
  left: number;
  right: number;
  panelWidth: number;
  contentInset: number;
  contentLeft: number;
  contentWidth: number;
  footerInset: number;
  footerLeft: number;
  footerWidth: number;
  titleOverhead: number;
  titleWidth: number;
}

/** Horizontal measures shared by panel chrome and responsive callers.
 *  Keeping the prefixes and reserved trailing cells here prevents a caller
 *  from selecting copy against dimensions `placePanel` will later truncate. */
export function panelHorizontalGeometry(
  width: number,
  maxWidth = 106
): PanelHorizontalGeometry {
  const panelWidth = panelWidthFor(width, maxWidth);
  const left = Math.max(2, Math.floor((width - panelWidth) / 2));
  const contentInset = visibleWidth(PANEL_BODY.prefix);
  const contentWidth = interiorWidth(PANEL_BODY, panelWidth);
  // The footer lives in the bottom rule, so its measures are that rule's: it
  // begins after `┗━ ` and reserves one cell for the space before the rule
  // that runs to the corner, exactly as the title does above.
  const footerInset = visibleWidth(PANEL_BOTTOM.prefix);
  return {
    left,
    right: left + panelWidth,
    panelWidth,
    contentInset,
    contentLeft: left + contentInset,
    contentWidth,
    footerInset,
    footerLeft: left + footerInset,
    footerWidth: Math.max(0, interiorWidth(PANEL_BOTTOM, panelWidth) - 1),
    // One cell over the glyphs for the space that separates title from rule.
    titleOverhead: visibleWidth(PANEL_TOP.prefix) + visibleWidth(PANEL_TOP.suffix) + 1,
    titleWidth: Math.max(0, interiorWidth(PANEL_TOP, panelWidth) - 1)
  };
}

/** Title rule, one blank, and the bottom rule that carries the keys. */
const PANEL_FRAME_ROWS = 3;
const PANEL_MIN_HEIGHT = 6;
const PANEL_SCREEN_MARGIN_ROWS = 5;
const PANEL_CONTENT_PADDING_ROWS = 1;

function panelGeometry(height: number, contentRows: number): {
  height: number;
  contentRows: number;
} {
  const panelHeight = Math.max(
    PANEL_MIN_HEIGHT,
    Math.min(
      height - PANEL_SCREEN_MARGIN_ROWS,
      contentRows + PANEL_FRAME_ROWS + PANEL_CONTENT_PADDING_ROWS
    )
  );
  return { height: panelHeight, contentRows: panelHeight - PANEL_FRAME_ROWS };
}

/** How many content rows `placePanel` can paint at this terminal height.
 *  Windowed callers and the renderer share `panelGeometry`, so changing panel
 *  chrome cannot leave either side with a stale capacity formula. */
export function panelContentRows(height: number): number {
  return panelGeometry(height, Number.POSITIVE_INFINITY).contentRows;
}

export function placePanel(
  base: FrameLine[],
  title: string,
  content: FrameLine[],
  footer: string,
  width: number,
  height: number,
  maxWidth = 106,
  hits?: PanelHits
): FrameComposition {
  const horizontal = panelHorizontalGeometry(width, maxWidth);
  const panelWidth = horizontal.panelWidth;
  const { left, right } = horizontal;
  const geometry = panelGeometry(height, content.length);
  const centeredTop = Math.max(1, Math.floor((height - 1 - geometry.height) / 2));
  const top = hits?.anchorTop === true
    ? Math.min(centeredTop, Math.max(1, Math.floor((PANEL_SCREEN_MARGIN_ROWS - 1) / 2)))
    : centeredTop;
  const panel: FrameLine[] = [];
  // The trailing space is the gap between the title and the rule that runs to
  // the corner; `titleWidth` reserves it.
  panel.push(panelRow(PANEL_TOP, [raisedSegment(`${title} `, "brass dim")], panelWidth));
  panel.push(panelRow(PANEL_BODY, [], panelWidth));
  // An open panel owns the whole screen: everything outside it is scrim, so
  // a stray click dismisses rather than acting on the page underneath.
  if (hits !== undefined) {
    fillRows(hits.rows, 0, hits.rows.length, { target: { kind: "scrim" }, left: 0, right: width });
  }
  const contentTop = panel.length;
  for (let row = 0; row < geometry.contentRows; row += 1) {
    const line = content[row] ?? [];
    if (hits !== undefined && row < content.length) {
      const absolute = top + contentTop + row;
      const target = hits.targets?.[row] ?? null;
      const relativeOverrides = hits.overrides?.[row] ?? [];
      if (absolute < hits.rows.length && (target !== null || relativeOverrides.length > 0)) {
        addHit(hits.rows, absolute, {
          target: target ?? { kind: "panel" }, left, right
        });
        for (const region of relativeOverrides) addHit(hits.rows, absolute, {
          ...region,
          left: horizontal.contentLeft + region.left,
          right: horizontal.contentLeft + region.right
        });
      }
    }
    panel.push(panelRow(PANEL_BODY, line, panelWidth));
  }
  // Overrides are located in the footer AS DRAWN. Searching the untruncated string
  // would leave an invisible token clickable off the panel's edge, and `hitAt`
  // consults overrides before row bounds. The throw below then fires the moment a
  // footer outgrows its panel — the failure plan 013 §8b describes, caught here
  // instead of only by a test.
  const shownFooter = truncate(footer, horizontal.footerWidth);
  // The trailing space is the gap between the keys and the rule that runs to
  // the corner; `footerWidth` reserves it.
  const footerIndex = panel.push(panelRow(
    PANEL_BOTTOM, [raisedSegment(`${shownFooter} `, "chrome")], panelWidth
  )) - 1;
  const output = [...base];
  // A cleared gap floats the panel: without it, dimmed page text cut mid-word
  // sits flush against the raised surface and reads as panel content.
  const gap = 2;
  const gapSegment = () => segment(" ".repeat(gap), "background");
  if (hits?.footerActions !== undefined) {
    let offset = 0;
    const overrides: HitRegion[] = hits.footerActions.map((item) => {
      const index = shownFooter.indexOf(item.token, offset);
      if (index === -1) throw new Error(`footer token not found: ${item.token}`);
      offset = index + item.token.length;
      const regionLeft = horizontal.footerLeft + visibleWidth(shownFooter.slice(0, index));
      return { target: { kind: "action", action: item.action }, left: regionLeft, right: regionLeft + visibleWidth(item.token) };
    });
    // Guard on the paint bound below, not the buffer: a row the panel never
    // draws must not answer a click, however much room the hit map has.
    const footerRow = top + footerIndex;
    if (footerRow < Math.min(hits.rows.length, height - 1)) {
      addHit(hits.rows, footerRow, { target: { kind: "panel" }, left, right });
      for (const region of overrides) addHit(hits.rows, footerRow, region);
    }
  }
  for (let row = 0; row < panel.length && top + row < height - 1; row += 1) {
    // Panel chrome is inert, not scrim. Content controls were added first;
    // untouched panel rows receive one broad inert override here.
    if (hits !== undefined && (hits.rows[top + row]?.overrides?.length ?? 0) === 0) {
      addHit(hits.rows, top + row, { target: { kind: "panel" }, left, right });
    }
    output[top + row] = fitLine([
      ...takeWidth(base[top + row] ?? [], Math.max(0, left - gap)),
      gapSegment(),
      ...panel[row]!,
      gapSegment(),
      ...takeTail(base[top + row] ?? [], right + gap)
    ], width);
  }
  return {
    lines: output,
    selectable: {
      left,
      top,
      right,
      bottom: Math.min(top + panel.length, height - 1)
    }
  };
}

/** One row between its own two edges: the opening glyphs, the row's cells,
 *  whatever fills the rest, then the closing glyphs. */
function panelRow(edges: PanelEdges, line: FrameLine, panelWidth: number): FrameLine {
  return [
    raisedSegment(edges.prefix, "brass dim"),
    ...fillTo(line, interiorWidth(edges, panelWidth), edges.fill, edges.fillRole),
    raisedSegment(edges.suffix, "brass dim")
  ];
}

export function raisedSegment(text: string, role: DisplayRole = "prose"): FrameSegment {
  return { text, role, background: "raised" };
}

function fillTo(line: FrameLine, width: number, fill: string, fillRole: DisplayRole): FrameLine {
  const clipped: FrameLine = [];
  let remaining = width;
  for (const part of line) {
    if (remaining <= 0) break;
    const text = sliceCells(part.text, 0, remaining);
    if (text.length > 0) clipped.push({ ...part, text });
    remaining -= visibleWidth(text);
  }
  if (remaining > 0) clipped.push(raisedSegment(fill.repeat(remaining), fillRole));
  return clipped;
}

function takeWidth(line: FrameLine, width: number): FrameLine {
  const result: FrameLine = [];
  let remaining = width;
  for (const part of line) {
    if (remaining <= 0) break;
    const text = sliceCells(part.text, 0, remaining);
    result.push({ ...part, text });
    remaining -= visibleWidth(text);
  }
  if (remaining > 0) result.push(segment(" ".repeat(remaining), "background"));
  return result;
}

function takeTail(line: FrameLine, start: number): FrameLine {
  let skipped = 0;
  const result: FrameLine = [];
  for (const part of line) {
    const end = skipped + visibleWidth(part.text);
    if (end > start) {
      const offset = Math.max(0, start - skipped);
      result.push({ ...part, text: sliceCells(part.text, offset) });
    }
    skipped = end;
  }
  return result;
}

function sliceCells(value: string, start: number, width = Number.POSITIVE_INFINITY): string {
  let position = 0;
  let used = 0;
  let output = "";
  for (const cell of graphemeCells(value)) {
    const end = position + cell.width;
    if (end <= start) {
      position = end;
      continue;
    }
    if (used + cell.width > width) break;
    output += cell.text;
    used += cell.width;
    position = end;
  }
  return output;
}

function dimRole(role: DisplayRole | undefined): DisplayRole | undefined {
  if (role === "prose" || role === "prose · dim" || role === "streaming" || role === "fresh 1" || role === "fresh 2"
    || role === "human edit" || role === "human edit dim" || role === "summary"
    || isLogoDisplayRole(role)) return "dimmed page";
  return role;
}

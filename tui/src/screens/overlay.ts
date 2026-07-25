import { graphemeCells } from "../cell-width.js";
import { addHit, fillRows, type HitRegion, type HitRows, type HitTarget } from "../hit.js";
import type { KeyAction } from "../keys.js";
import {
  fitLine,
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

/** Click targets for a panel: one entry per content line, so rows that grow
 *  (expanded facts, wrapped legends) stay aligned with what was drawn. */
export interface PanelHits {
  rows: HitRows;
  /** Parallel to `content`; null for headers, spacers and wrapped detail. */
  targets?: Array<HitTarget | null>;
  /** Column overrides relative to the start of each content line. */
  overrides?: Array<HitRegion[] | undefined>;
  /** Footer keys that run on click. Structurally requires hits, which is why
   *  it lives here rather than as its own parameter. */
  footerActions?: ReadonlyArray<{ token: string; action: KeyAction }>;
}

/** The panel geometry every overlay is measured against. Exported because
 *  callers used to re-derive it by hand, which is how a facts body came to be
 *  wrapped against the terminal width instead of the panel's. */
export function panelWidthFor(width: number, maxWidth = 106): number {
  return Math.max(20, Math.min(width - 8, maxWidth));
}

/** The other half of that geometry: how many content rows `placePanel` will
 *  paint at this height, once its own minimum is applied. Callers that slice
 *  or window their body must measure against this, or they leave rows behind a
 *  bound that never reaches them. */
export function panelContentRows(height: number): number {
  return Math.max(2, height - 9);
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
  const panelWidth = panelWidthFor(width, maxWidth);
  const left = Math.max(2, Math.floor((width - panelWidth) / 2));
  const panelHeight = Math.max(6, Math.min(height - 5, content.length + 5));
  const top = Math.max(1, Math.floor((height - 1 - panelHeight) / 2));
  const panel: FrameLine[] = [];
  const topText = `┏━ ${title} ━`;
  panel.push(fillRaised([raisedSegment(topText, "brass dim")], panelWidth));
  panel.push(fillRaised([raisedSegment("┃ ", "brass dim")], panelWidth));
  // An open panel owns the whole screen: everything outside it is scrim, so
  // a stray click dismisses rather than acting on the page underneath.
  if (hits !== undefined) {
    fillRows(hits.rows, 0, hits.rows.length, { target: { kind: "scrim" }, left: 0, right: width });
  }
  const contentTop = 2;
  for (let row = 0; row < panelHeight - 4; row += 1) {
    const line = content[row] ?? [];
    if (hits !== undefined && row < content.length) {
      const absolute = top + contentTop + row;
      const target = hits.targets?.[row] ?? null;
      const relativeOverrides = hits.overrides?.[row] ?? [];
      if (absolute < hits.rows.length && (target !== null || relativeOverrides.length > 0)) {
        addHit(hits.rows, absolute, {
          target: target ?? { kind: "panel" }, left, right: left + panelWidth
        });
        for (const region of relativeOverrides) addHit(hits.rows, absolute, {
          ...region, left: left + 2 + region.left, right: left + 2 + region.right
        });
      }
    }
    panel.push(fillRaised([raisedSegment("┃ ", "brass dim"), ...line], panelWidth));
  }
  panel.push([raisedSegment("┗" + "━".repeat(Math.max(0, panelWidth - 1)), "brass dim")]);
  // Overrides are located in the footer AS DRAWN. Searching the untruncated string
  // would leave an invisible token clickable off the panel's edge, and `hitAt`
  // consults overrides before row bounds. The throw below then fires the moment a
  // footer outgrows its panel — the failure plan 013 §8b describes, caught here
  // instead of only by a test.
  const shownFooter = truncate(footer, panelWidth - 4);
  panel.push(fillRaised([raisedSegment(`  ${shownFooter}`, "chrome")], panelWidth));
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
      const regionLeft = left + 2 + visibleWidth(shownFooter.slice(0, index));
      return { target: { kind: "action", action: item.action }, left: regionLeft, right: regionLeft + visibleWidth(item.token) };
    });
    const footerRow = top + panel.length - 1;
    if (footerRow < hits.rows.length) {
      addHit(hits.rows, footerRow, { target: { kind: "panel" }, left, right: left + panelWidth });
      for (const region of overrides) addHit(hits.rows, footerRow, region);
    }
  }
  for (let row = 0; row < panel.length && top + row < height - 1; row += 1) {
    // Panel chrome is inert, not scrim. Content controls were added first;
    // untouched panel rows receive one broad inert override here.
    if (hits !== undefined && (hits.rows[top + row]?.overrides?.length ?? 0) === 0) {
      addHit(hits.rows, top + row, { target: { kind: "panel" }, left, right: left + panelWidth });
    }
    output[top + row] = fitLine([
      ...takeWidth(base[top + row] ?? [], Math.max(0, left - gap)),
      gapSegment(),
      ...panel[row]!,
      gapSegment(),
      ...takeTail(base[top + row] ?? [], left + panelWidth + gap)
    ], width);
  }
  return {
    lines: output,
    selectable: {
      left,
      top,
      right: left + panelWidth,
      bottom: Math.min(top + panel.length, height - 1)
    }
  };
}

export function raisedSegment(text: string, role: DisplayRole = "prose"): FrameSegment {
  return { text, role, background: "raised" };
}

function fillRaised(line: FrameLine, width: number): FrameLine {
  const clipped: FrameLine = [];
  let remaining = width;
  for (const part of line) {
    if (remaining <= 0) break;
    const text = sliceCells(part.text, 0, remaining);
    if (text.length > 0) clipped.push({ ...part, text });
    remaining -= visibleWidth(text);
  }
  if (remaining > 0) clipped.push(raisedSegment(" ".repeat(remaining)));
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
    || role === "human edit" || role === "human edit dim" || role === "summary") return "dimmed page";
  return role;
}

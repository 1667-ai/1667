import {
  asideHopAnchorIndex,
  asideHopEntries,
  asideHopTarget,
  orderAsideAnchors,
  UNANCHORED_ASIDE_ID,
  type AsideAnchorView,
  type AsideHopEntry,
  type AsideSessionAnchor
} from "../../shared/aside-hop-model.js";
export {
  asideHopAnchorIndex,
  asideHopEntries,
  asideHopTarget,
  orderAsideAnchors,
  UNANCHORED_ASIDE_ID,
  type AsideHopEntry
};
import { graphemeCells } from "./cell-width.js";
import { truncate, visibleWidth } from "./screens/story/frame.js";

export interface AsideHopWindow {
  readonly entries: readonly AsideHopEntry[];
  /** Zero-based index in the ordered anchor list. */
  readonly start: number;
  readonly end: number;
  readonly hiddenBefore: number;
  readonly hiddenAfter: number;
}

/** A rendered hop-strip segment. Entries carry the stable mouse identity for
 * the label they paint; chrome and separators leave it unset. */
export interface AsideHopStripSegment {
  readonly text: string;
  readonly entry?: AsideHopEntry;
}

/** Text and hit-bearing segments for one hop strip at one terminal width. */
export interface AsideHopStripLayout {
  readonly text: string;
  readonly segments: readonly AsideHopStripSegment[];
}

function clipHopSegments(
  segments: readonly AsideHopStripSegment[],
  width: number
): AsideHopStripSegment[] {
  const clipped: AsideHopStripSegment[] = [];
  let used = 0;
  for (const part of segments) {
    if (used >= width) break;
    let text = "";
    let partWidth = 0;
    for (const cell of graphemeCells(part.text)) {
      if (used + partWidth + cell.width > width) break;
      text += cell.text;
      partWidth += cell.width;
    }
    if (text.length > 0) {
      clipped.push({
        text,
        ...(part.entry === undefined ? {} : { entry: part.entry })
      });
    }
    used += partWidth;
  }
  return clipped;
}

/** Project hit-bearing segments onto an exact clipped header line. */
export function clipAsideHopStripLayout(
  layout: AsideHopStripLayout,
  text: string
): AsideHopStripLayout {
  if (layout.text === text) return layout;
  const ellipsis = text.endsWith("…");
  const contentWidth = Math.max(0, visibleWidth(text) - (ellipsis ? 1 : 0));
  const segments = clipHopSegments(layout.segments, contentWidth);
  if (ellipsis) segments.push({ text: "…" });
  return segments.map((part) => part.text).join("") === text
    ? { text, segments }
    : { text, segments: [] };
}

/** Stable identity for one ordered hop target. Anchor addresses survive
 * presence refreshes and are not tied to the target's current index. */
export function asideHopRowId(entry: AsideHopEntry): string {
  if (entry.anchor.unanchored === true) return `aside-hop:${UNANCHORED_ASIDE_ID}`;
  return `aside-hop:${entry.anchor.partId}\u0000${entry.anchor.takeId}`;
}

/** Window a crowded hop strip around the current anchor. */
export function asideHopWindow(
  entries: readonly AsideHopEntry[],
  currentIndex: number,
  maxVisible = 5
): AsideHopWindow {
  const limit = Math.max(1, Math.floor(maxVisible));
  if (entries.length <= limit) {
    return {
      entries,
      start: 0,
      end: entries.length,
      hiddenBefore: 0,
      hiddenAfter: 0
    };
  }
  const center = currentIndex >= 0 && currentIndex < entries.length ? currentIndex : 0;
  const half = Math.floor(limit / 2);
  const start = Math.min(
    Math.max(0, center - half),
    entries.length - limit
  );
  const end = start + limit;
  return {
    entries: entries.slice(start, end),
    start,
    end,
    hiddenBefore: start,
    hiddenAfter: entries.length - end
  };
}

/** Move within the hop list without changing the story cursor. */
export function moveAsideHopIndex(
  currentIndex: number,
  direction: -1 | 1,
  length: number
): number {
  if (length <= 0) return -1;
  const current = currentIndex >= 0 && currentIndex < length ? currentIndex : 0;
  return (current + direction + length) % length;
}

/** Render the compact strip text. The caller adds the `g` reroute keyline. */
export function asideHopStripText(
  anchors: readonly AsideAnchorView[],
  current: AsideSessionAnchor | null,
  width = Number.POSITIVE_INFINITY,
  maxVisible = 5
): string {
  return asideHopStripLayout(anchors, current, width, maxVisible).text;
}

/** Build the hop strip once so rendering and hit testing use the same window. */
export function asideHopStripLayout(
  anchors: readonly AsideAnchorView[],
  current: AsideSessionAnchor | null,
  width = Number.POSITIVE_INFINITY,
  maxVisible = 5
): AsideHopStripLayout {
  const entries = asideHopEntries(anchors, current);
  if (entries.length === 0) return { text: "", segments: [] };
  const currentIndex = entries.findIndex((entry) => entry.current);
  const render = (window: AsideHopWindow): AsideHopStripLayout => {
    const before = window.hiddenBefore > 0 ? `‹${window.start + 1} … ` : "";
    const after = window.hiddenAfter > 0 ? ` … ${window.end}›` : "";
    const segments: AsideHopStripSegment[] = [{ text: "elsewhere   " }];
    if (before.length > 0) segments.push({ text: before });
    for (const [index, entry] of window.entries.entries()) {
      segments.push({
        text: entry.current ? `[ ${entry.label} ]` : entry.label,
        entry
      });
      if (index < window.entries.length - 1) segments.push({ text: "    " });
    }
    if (after.length > 0) segments.push({ text: after });
    return {
      text: segments.map((segment) => segment.text).join(""),
      segments
    };
  };
  const limit = Math.min(Math.max(1, Math.floor(maxVisible)), entries.length);
  for (let visible = limit; visible > 0; visible -= 1) {
    const layout = render(asideHopWindow(entries, currentIndex, visible));
    if (!Number.isFinite(width) || visibleWidth(layout.text) <= width) return layout;
  }
  // The current entry is always retained. This final truncation only applies
  // when the caller gives less room than the one-entry label itself.
  const layout = render(asideHopWindow(entries, currentIndex, 1));
  const clippedWidth = Math.max(0, Math.floor(width));
  return clipAsideHopStripLayout(layout, truncate(layout.text, clippedWidth));
}

/** Useful for geometry callers that need the rendered strip width. */
export function asideHopStripWidth(
  anchors: readonly AsideAnchorView[],
  current: AsideSessionAnchor | null,
  width = Number.POSITIVE_INFINITY,
  maxVisible = 5
): number {
  return visibleWidth(asideHopStripText(anchors, current, width, maxVisible));
}

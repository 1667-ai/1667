/** Hop strip layout (D-27) for the aside popover
 * (`renderer-aside-popover-view.ts`) and the `g` "go to this take" key
 * (`renderer-keys-controller.ts`).
 *
 * `tui/src/aside-hop.ts` cannot be imported directly: it re-exports
 * `truncate`/`visibleWidth` from `tui/src/screens/story/frame.ts`, and that
 * module imports `@opentui/core` at its top. Confirmed by bundling
 * `aside-hop.ts` alone with esbuild's browser platform (the same settings
 * `scripts/build-shell.ts` uses for the renderer) — the build fails outright,
 * because `@opentui/core`'s Node build reaches for `fs`/`events`/`node:path`
 * and the rest, none of which a browser bundle can resolve. `graphemeCells`
 * and `cellWidth` have no such problem — `tui/src/cell-width.ts` has zero
 * imports of its own — so they are imported directly; only `truncate`, a
 * five-line function that lived in `frame.ts` next to them, is duplicated
 * below. Everything else here (`asideHopEntries`, `orderAsideAnchors`,
 * `asideHopWindow`, `asideHopStripLayout`, `clipAsideHopStripLayout`) is
 * copied unchanged from `tui/src/aside-hop.ts`.
 * TODO: import from tui/src/aside-hop.ts once the client split lands. */
import { cellWidth as visibleWidth, graphemeCells } from "../tui/src/cell-width.js";
import type { AsideAnchorView, AsideSessionAnchor } from "../tui/src/aside-surface.js";

/** Internal address used for the unanchored hop entry. Never send it to the
 * backend; the action layer maps this entry back to `anchor: null`. */
export const UNANCHORED_ASIDE_ID = "__aside_unanchored__";

/** One hop-strip entry after story-order projection. */
export interface AsideHopEntry {
  readonly anchor: AsideAnchorView;
  readonly index: number;
  readonly current: boolean;
  readonly label: string;
}

export interface AsideHopWindow {
  readonly entries: readonly AsideHopEntry[];
  readonly start: number;
  readonly end: number;
  readonly hiddenBefore: number;
  readonly hiddenAfter: number;
}

/** A rendered hop-strip segment. Entries carry the stable identity for the
 * label they paint; chrome and separators leave it unset. */
export interface AsideHopStripSegment {
  readonly text: string;
  readonly entry?: AsideHopEntry;
}

/** Text and hit-bearing segments for one hop strip at one width. */
export interface AsideHopStripLayout {
  readonly text: string;
  readonly segments: readonly AsideHopStripSegment[];
}

function truncate(value: string, width: number): string {
  if (visibleWidth(value) <= width) return value;
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

function numberOrInfinity(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) ? Number.POSITIVE_INFINITY : value;
}

function anchorKey(anchor: AsideSessionAnchor): string {
  return `${anchor.partId}\u0000${anchor.takeId}`;
}

function partKey(anchor: AsideAnchorView): string {
  return anchor.partNumber === undefined
    ? `id:${anchor.partId}`
    : `number:${anchor.partNumber}`;
}

function sameAnchor(left: AsideAnchorView, right: AsideSessionAnchor | null): boolean {
  if (left.unanchored === true) return right === null;
  if (right === null) return false;
  return anchorKey(left) === anchorKey(right);
}

function sessionCount(anchor: AsideAnchorView): number {
  return Math.max(0, Math.floor(anchor.sessionCount));
}

/** Sort anchored entries by their display projection. Unanchored entries stay last. */
export function orderAsideAnchors(anchors: readonly AsideAnchorView[]): AsideAnchorView[] {
  return anchors
    .map((anchor, sourceIndex) => ({ anchor, sourceIndex }))
    .sort((left, right) => {
      const leftUnanchored = left.anchor.unanchored === true;
      const rightUnanchored = right.anchor.unanchored === true;
      if (leftUnanchored !== rightUnanchored) return leftUnanchored ? 1 : -1;
      if (!leftUnanchored) {
        const leftPartNumber = numberOrInfinity(left.anchor.partNumber);
        const rightPartNumber = numberOrInfinity(right.anchor.partNumber);
        if (leftPartNumber !== rightPartNumber) {
          if (leftPartNumber === Number.POSITIVE_INFINITY) return 1;
          if (rightPartNumber === Number.POSITIVE_INFINITY) return -1;
          return leftPartNumber - rightPartNumber;
        }
        const leftPart = left.anchor.partId.localeCompare(right.anchor.partId);
        if (leftPart !== 0) return leftPart;
        const leftTakeIndex = numberOrInfinity(left.anchor.takeIndex);
        const rightTakeIndex = numberOrInfinity(right.anchor.takeIndex);
        if (leftTakeIndex !== rightTakeIndex) {
          if (leftTakeIndex === Number.POSITIVE_INFINITY) return 1;
          if (rightTakeIndex === Number.POSITIVE_INFINITY) return -1;
          return leftTakeIndex - rightTakeIndex;
        }
        const takeId = left.anchor.takeId.localeCompare(right.anchor.takeId);
        if (takeId !== 0) return takeId;
      }
      return left.sourceIndex - right.sourceIndex;
    })
    .map(({ anchor }) => anchor);
}

/** Add display labels and current-anchor state to the ordered hop entries. */
export function asideHopEntries(
  anchors: readonly AsideAnchorView[],
  current: AsideSessionAnchor | null
): AsideHopEntry[] {
  const ordered = orderAsideAnchors(anchors);
  const repeatedParts = new Set<string>();
  const seenParts = new Set<string>();
  for (const anchor of ordered) {
    if (anchor.unanchored === true) continue;
    const key = partKey(anchor);
    if (seenParts.has(key)) repeatedParts.add(key);
    seenParts.add(key);
  }
  return ordered.map((anchor, index) => {
    if (anchor.unanchored === true) {
      return {
        anchor,
        index,
        current: sameAnchor(anchor, current),
        label: `· unanchored ×${sessionCount(anchor)}`
      };
    }
    const part = anchor.partNumber === undefined ? "?" : String(anchor.partNumber);
    const qualifier = repeatedParts.has(partKey(anchor))
      ? ` · t${anchor.takeIndex === undefined ? "?" : anchor.takeIndex}`
      : "";
    return {
      anchor,
      index,
      current: sameAnchor(anchor, current),
      label: `¶ ${part}${qualifier} ×${sessionCount(anchor)}`
    };
  });
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

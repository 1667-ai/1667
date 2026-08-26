import type {
  AsideAnchorView,
  AsideSessionAnchor
} from "./aside-surface.js";
import { truncate, visibleWidth } from "./screens/story/frame.js";

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
  /** Zero-based index in the ordered anchor list. */
  readonly start: number;
  readonly end: number;
  readonly hiddenBefore: number;
  readonly hiddenAfter: number;
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

/** Return the index used by the ordered hop projection for an anchor. */
export function asideHopAnchorIndex(
  anchors: readonly AsideAnchorView[],
  current: AsideSessionAnchor | null
): number {
  const ordered = orderAsideAnchors(anchors);
  if (ordered.length === 0) return -1;
  const match = ordered.findIndex((anchor) => sameAnchor(anchor, current));
  return match >= 0 ? match : 0;
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

/** Resolve a hop target by its ordered index. */
export function asideHopTarget(
  anchors: readonly AsideAnchorView[],
  index: number
): AsideAnchorView | null {
  return orderAsideAnchors(anchors)[index] ?? null;
}

/** Render the compact strip text. The caller adds the `g` reroute keyline. */
export function asideHopStripText(
  anchors: readonly AsideAnchorView[],
  current: AsideSessionAnchor | null,
  width = Number.POSITIVE_INFINITY,
  maxVisible = 5
): string {
  const entries = asideHopEntries(anchors, current);
  if (entries.length === 0) return "";
  const currentIndex = entries.findIndex((entry) => entry.current);
  const render = (window: AsideHopWindow): string => {
    const before = window.hiddenBefore > 0 ? `‹${window.start + 1} … ` : "";
    const after = window.hiddenAfter > 0 ? ` … ${window.end}›` : "";
    const labels = window.entries.map((entry) => entry.current ? `[ ${entry.label} ]` : entry.label);
    return `elsewhere   ${before}${labels.join("    ")}${after}`;
  };
  const limit = Math.min(Math.max(1, Math.floor(maxVisible)), entries.length);
  for (let visible = limit; visible > 0; visible -= 1) {
    const text = render(asideHopWindow(entries, currentIndex, visible));
    if (!Number.isFinite(width) || visibleWidth(text) <= width) return text;
  }
  // The current entry is always retained. This final truncation only applies
  // when the caller gives less room than the one-entry label itself.
  return truncate(render(asideHopWindow(entries, currentIndex, 1)), Math.max(0, width));
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

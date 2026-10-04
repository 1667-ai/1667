/**
 * The pure model of Aside's hop strip: the order of the anchors that have
 * sessions, which one is current, and the label of each. The TUI draws it as
 * a text strip; the web draws it as buttons.
 */

/** One session or hop anchor, with optional display projections. */
export interface AsideSessionAnchor {
  readonly partId: string;
  readonly takeId: string;
  readonly partNumber?: number;
  readonly takeIndex?: number;
  readonly takeCount?: number;
}

/** One hop-strip entry. */
export interface AsideAnchorView extends AsideSessionAnchor {
  readonly sessionCount: number;
  readonly title?: string;
  readonly unanchored?: boolean;
}

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

/** Resolve a hop target by its ordered index. */
export function asideHopTarget(
  anchors: readonly AsideAnchorView[],
  index: number
): AsideAnchorView | null {
  return orderAsideAnchors(anchors)[index] ?? null;
}

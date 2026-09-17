/** Pure geometry for the Map minimap (D-35): the whole current line
 * compressed into one horizontal strip, to scale by cumulative words, with
 * chapter and off-path-take marks placed as fractions along it. No DOM —
 * `renderer-map-view.ts` draws what this returns and drives the viewport
 * rectangle from live stage scroll. Kept in its own file, like
 * `renderer-map-layout.ts`, so it is unit-tested without Electron. */
import type { NodeStub, StoryPayload } from "../shared/types.js";

export interface MinimapTick {
  readonly id: string;
  readonly fraction: number;
  readonly title: string;
}

export interface MinimapGeometry {
  readonly totalParts: number;
  /** Cumulative word offsets along `story.path`, length `totalParts + 1`.
   * `cumulative[0]` is 0; `cumulative[i + 1]` is the offset right after part
   * `i` (each part counted as at least 1 word, so an empty part still takes
   * strip space). */
  readonly cumulative: readonly number[];
  /** One tick per chapter break whose part is still on the line, at the
   * fraction right after that part. */
  readonly chapterTicks: readonly MinimapTick[];
  /** Fractions, at each part's midpoint, where that part has at least one
   * off-path take (another take that left the line). */
  readonly forkFractions: readonly number[];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Computes the strip geometry for one story's current line. Pure and
 * side-effect free; the caller is responsible for memoising it across
 * renders that do not change `story.nodes`/`story.path`. */
export function computeMinimapGeometry(story: StoryPayload): MinimapGeometry {
  const path = story.path;
  const nodesById = new Map(story.nodes.map((node) => [node.id, node] as const));
  const cumulative: number[] = [0];
  for (const node of path) {
    const words = Math.max(1, nodesById.get(node.id)?.words ?? 0);
    cumulative.push(cumulative[cumulative.length - 1]! + words);
  }
  const total = cumulative[cumulative.length - 1] ?? 0;
  const fractionAfter = (index: number): number => (total === 0 ? 0 : clamp01(cumulative[index + 1]! / total));
  const fractionMid = (index: number): number => (total === 0 ? 0 : clamp01((cumulative[index]! + cumulative[index + 1]!) / 2 / total));

  const childrenByParent = new Map<string | null, NodeStub[]>();
  for (const node of story.nodes) {
    const list = childrenByParent.get(node.parentId);
    if (list === undefined) childrenByParent.set(node.parentId, [node]);
    else list.push(node);
  }
  const pathIds = new Set(path.map((node) => node.id));

  const chapterTicks: MinimapTick[] = [];
  for (const chapter of story.chapterBreaks) {
    const index = path.findIndex((node) => node.id === chapter.parentPartId);
    if (index === -1) continue;
    chapterTicks.push({ id: chapter.id, fraction: fractionAfter(index), title: chapter.title });
  }

  const forkFractions: number[] = [];
  for (let index = 0; index < path.length; index += 1) {
    const kids = childrenByParent.get(path[index]!.id) ?? [];
    // Index 0 also collects root-level siblings (an alternate root take has
    // `parentId: null`, the same key `path[0]` itself sits under) — mirrors
    // `computeMapLayout`'s off-path branch collection.
    const rootSiblings = index === 0 ? childrenByParent.get(null) ?? [] : [];
    const hasOffPath = [...kids, ...rootSiblings].some((kid) => !pathIds.has(kid.id));
    if (hasOffPath) forkFractions.push(fractionMid(index));
  }

  return { totalParts: path.length, cumulative, chapterTicks, forkFractions };
}

/** The part index (0-based, into `story.path`) at a fraction along the
 * strip — the inverse of `computeMinimapGeometry`'s cumulative offsets.
 * A fraction outside `[0, 1]` clamps to the nearest end. */
export function minimapPartIndexAtFraction(geometry: MinimapGeometry, fraction: number): number {
  if (geometry.totalParts === 0) return 0;
  const total = geometry.cumulative[geometry.cumulative.length - 1]!;
  const target = clamp01(fraction) * total;
  for (let index = 0; index < geometry.totalParts; index += 1) {
    if (target <= geometry.cumulative[index + 1]!) return index;
  }
  return geometry.totalParts - 1;
}

/** The strip fraction range covering part indices `[startIndex, endIndex]`
 * inclusive — sizes the viewport rectangle from a visible part-index range. */
export function minimapFractionRange(geometry: MinimapGeometry, startIndex: number, endIndex: number): { readonly start: number; readonly end: number } {
  const total = geometry.cumulative[geometry.cumulative.length - 1] || 1;
  const lastIndex = geometry.cumulative.length - 1;
  const start = geometry.cumulative[Math.min(lastIndex, Math.max(0, startIndex))]! / total;
  const end = geometry.cumulative[Math.min(lastIndex, Math.max(0, endIndex + 1))]! / total;
  return { start, end };
}

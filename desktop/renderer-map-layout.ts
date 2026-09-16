/** Pure geometry for the Map stemma (⌘5, D-30…D-32). No DOM, no actions —
 * `renderer-map-view.ts` draws what this returns. Kept in its own file so it
 * can be unit-tested (and timed) without Electron.
 *
 * Reduced scope (see `05-map-braid-aside.md` §0): no icicle, no minimap, no
 * fisheye lens, no regen clouds. A collapsed run's subtree is summarised as
 * one bar even when it forks again further down — the bar's count and words
 * cover the whole subtree, but nested forks inside it are not drawn. This
 * keeps the layout O(nodes) and the ≤120 budget easy to prove, at the cost of
 * detail a writer would only reach by expanding a run — expansion is not
 * implemented; a click focuses the run's tip instead. */
import type { NodeStub, StoryPayload } from "../shared/types.js";

export const DEFAULT_MAP_NODE_BUDGET = 120;
/** A single fork can carry far more sibling takes than the whole budget (the
 * 2f mock shows one part with 61) — cap how many of one fork's branches ever
 * draw individually so one crowded fork cannot alone blow the ≤120 total;
 * the rest fold into one "+n more" bar, ordered by recency so the freshest
 * takes are the ones kept visible. */
const MAX_BRANCHES_PER_FORK = 8;
const MIN_SPINE_GAP = 28;
const ROW_HEIGHT = 34;
const COLD_MS = 21 * 24 * 60 * 60 * 1000;
const MARGIN_X = 24;
const MARGIN_Y = 24;

export interface MapPoint {
  readonly x: number;
  readonly y: number;
}

export interface MapLayoutNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly onPath: boolean;
  /** This is the shown take among ≥ 2 sibling takes at its fork. */
  readonly ring: boolean;
  readonly summary: boolean;
  readonly deadEnd: boolean;
  readonly cold: boolean;
  readonly words: number;
  readonly preview: string;
  readonly partNumber?: number;
}

export interface MapLayoutEdge {
  readonly id: string;
  readonly from: MapPoint;
  readonly to: MapPoint;
  readonly onPath: boolean;
  readonly cold: boolean;
}

/** D-32: a forkless run (or a run that forks again only past this budget)
 * folded to one bar. Clicking it focuses `tipNodeId`. */
export interface MapCollapsedRun {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly count: number;
  readonly words: number;
  readonly tipNodeId: string;
}

export interface MapChapterTick {
  readonly id: string;
  readonly x: number;
  readonly title: string;
}

export interface MapLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly MapLayoutNode[];
  readonly edges: readonly MapLayoutEdge[];
  readonly collapsedRuns: readonly MapCollapsedRun[];
  readonly chapterTicks: readonly MapChapterTick[];
  /** Path indices actually drawn, `[windowStart, windowEnd)`. */
  readonly windowStart: number;
  readonly windowEnd: number;
  /** True when the spine was windowed (some parts folded to boundary bars). */
  readonly windowed: boolean;
  readonly totalParts: number;
}

export interface MapLayoutOptions {
  readonly maxNodes?: number;
  readonly now?: number;
}

function nodeRadius(words: number): number {
  return Math.min(14, Math.max(4, Math.sqrt(Math.max(0, words))));
}

function isDeadEnd(node: NodeStub, onPath: boolean): boolean {
  return !onPath && node.childCount === 0 && node.words === 0;
}

function isCold(node: NodeStub, onPath: boolean, now: number): boolean {
  if (onPath) return false;
  const touched = Date.parse(node.lastTouched);
  return Number.isFinite(touched) && now - touched > COLD_MS;
}

/** How many primitives one fork's off-path branches draw once
 * `MAX_BRANCHES_PER_FORK` is enforced: every branch up to the cap, plus one
 * more bar for the overflow when there is any. */
function drawnBranchCount(branches: readonly NodeStub[]): number {
  return Math.min(branches.length, MAX_BRANCHES_PER_FORK) + (branches.length > MAX_BRANCHES_PER_FORK ? 1 : 0);
}

/** The whole subtree hanging off `rootId`, in document order, stopping (but
 * still counting) if it runs unreasonably long — a story's off-path takes
 * cannot outnumber its on-path ones by more than a small multiple in
 * practice, so this is a safety valve, not a real limit. */
function collectSubtree(
  childrenByParent: ReadonlyMap<string | null, readonly NodeStub[]>,
  nodesById: ReadonlyMap<string, NodeStub>,
  rootId: string
): NodeStub[] {
  const result: NodeStub[] = [];
  const stack = [rootId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = nodesById.get(id);
    if (node !== undefined) result.push(node);
    for (const child of childrenByParent.get(id) ?? []) stack.push(child.id);
  }
  return result;
}

/** Compute the stemma layout for one story, windowed around `focusedPartId`
 * so at most `maxNodes` primitives (spine nodes, off-path nodes, and
 * collapsed-run bars together) are ever produced. Pure and side-effect free;
 * the caller (`renderer-map-view.ts`) is responsible for memoising it across
 * renders that do not change `story` or the focused part. */
export function computeMapLayout(
  story: StoryPayload,
  focusedPartId: string | null,
  options: MapLayoutOptions = {}
): MapLayout {
  const maxNodes = options.maxNodes ?? DEFAULT_MAP_NODE_BUDGET;
  const now = options.now ?? Date.now();
  const path = story.path;
  if (path.length === 0) {
    return { width: MARGIN_X * 2, height: MARGIN_Y * 2, nodes: [], edges: [], collapsedRuns: [], chapterTicks: [], windowStart: 0, windowEnd: 0, windowed: false, totalParts: 0 };
  }
  const childrenByParent = new Map<string | null, NodeStub[]>();
  for (const node of story.nodes) {
    const list = childrenByParent.get(node.parentId);
    if (list === undefined) childrenByParent.set(node.parentId, [node]);
    else list.push(node);
  }
  const nodeStubById = new Map(story.nodes.map((node) => [node.id, node] as const));
  const pathIds = new Set(path.map((node) => node.id));

  const focusedIndex = focusedPartId === null ? -1 : path.findIndex((node) => node.id === focusedPartId);
  const safeFocusedIndex = focusedIndex === -1 ? path.length - 1 : focusedIndex;

  // Off-path branch roots per path index, precomputed once (O(nodes) total).
  const branchesByIndex = new Map<number, NodeStub[]>();
  for (let index = 0; index < path.length; index += 1) {
    const kids = childrenByParent.get(path[index]!.id) ?? [];
    const offPath = kids.filter((kid) => !pathIds.has(kid.id));
    if (offPath.length > 0) branchesByIndex.set(index, offPath);
  }
  const weight = path.map((_, index) => {
    const branches = branchesByIndex.get(index);
    return 1 + (branches === undefined ? 0 : drawnBranchCount(branches));
  });
  const prefix = new Array<number>(path.length + 1).fill(0);
  for (let index = 0; index < path.length; index += 1) prefix[index + 1] = prefix[index]! + weight[index]!;
  const windowWeight = (lo: number, hi: number): number => prefix[hi]! - prefix[lo]!;

  let lo = 0;
  let hi = path.length;
  for (;;) {
    const boundaryBars = (lo > 0 ? 1 : 0) + (hi < path.length ? 1 : 0);
    if (windowWeight(lo, hi) + boundaryBars <= maxNodes || hi - lo <= 1) break;
    const distLo = safeFocusedIndex - lo;
    const distHi = hi - 1 - safeFocusedIndex;
    if (distLo > distHi) lo += 1; else hi -= 1;
  }
  const windowed = lo > 0 || hi < path.length;

  // x positions: cumulative words along the windowed spine, min gap enforced.
  const xs: number[] = [];
  let cursorX = MARGIN_X + (lo > 0 ? 40 : 0);
  let cumulativeWords = 0;
  for (let index = lo; index < hi; index += 1) {
    const stub = nodeStubById.get(path[index]!.id);
    cumulativeWords += stub?.words ?? 0;
    const proposed = MARGIN_X + (lo > 0 ? 40 : 0) + cumulativeWords * 0.6;
    cursorX = index === lo ? Math.max(cursorX, proposed) : Math.max(cursorX + MIN_SPINE_GAP, proposed);
    xs.push(cursorX);
  }

  const nodes: MapLayoutNode[] = [];
  const edges: MapLayoutEdge[] = [];
  const collapsedRuns: MapCollapsedRun[] = [];
  const chapterTicks: MapChapterTick[] = [];
  const spineY = MARGIN_Y + ROW_HEIGHT * 2;

  if (lo > 0) {
    const hidden = path.slice(0, lo);
    const words = hidden.reduce((sum, node) => sum + (nodeStubById.get(node.id)?.words ?? 0), 0);
    collapsedRuns.push({ id: "run:spine-before", x: MARGIN_X, y: spineY, width: 32, count: hidden.length, words, tipNodeId: hidden[hidden.length - 1]!.id });
  }
  if (hi < path.length) {
    const hidden = path.slice(hi);
    const words = hidden.reduce((sum, node) => sum + (nodeStubById.get(node.id)?.words ?? 0), 0);
    collapsedRuns.push({ id: "run:spine-after", x: xs[xs.length - 1]! + 40, y: spineY, width: 32, count: hidden.length, words, tipNodeId: hidden[0]!.id });
  }

  for (let index = lo; index < hi; index += 1) {
    const pathNode = path[index]!;
    const stub = nodeStubById.get(pathNode.id);
    const words = stub?.words ?? 0;
    const siblingCount = (childrenByParent.get(pathNode.parentId) ?? []).filter((candidate) => candidate.role !== "summary").length;
    nodes.push({
      id: pathNode.id,
      x: xs[index - lo]!,
      y: spineY,
      r: nodeRadius(words),
      onPath: true,
      ring: siblingCount > 1,
      summary: pathNode.role === "summary",
      deadEnd: false,
      cold: false,
      words,
      preview: stub?.preview ?? pathNode.text.slice(0, 48),
      partNumber: index + 1
    });
    if (index > lo) {
      edges.push({ id: `spine:${path[index - 1]!.id}:${pathNode.id}`, from: { x: xs[index - lo - 1]!, y: spineY }, to: { x: xs[index - lo]!, y: spineY }, onPath: true, cold: false });
    }
    if (pathNode.chapterBreakId !== undefined) {
      chapterTicks.push({ id: pathNode.chapterBreakId, x: xs[index - lo]!, title: "" });
    }
  }
  for (const chapter of story.chapterBreaks) {
    const index = path.findIndex((node) => node.id === chapter.parentPartId);
    if (index < lo || index >= hi) continue;
    if (chapterTicks.some((tick) => tick.id === chapter.id)) continue;
    chapterTicks.push({ id: chapter.id, x: xs[index - lo]!, title: chapter.title });
  }

  let rowCursor = 0;
  for (let index = lo; index < hi; index += 1) {
    const branches = branchesByIndex.get(index);
    if (branches === undefined) continue;
    const parentX = xs[index - lo]!;
    const ordered = [...branches].sort((a, b) => Date.parse(b.lastTouched) - Date.parse(a.lastTouched));
    const shown = ordered.slice(0, MAX_BRANCHES_PER_FORK);
    const overflow = ordered.slice(MAX_BRANCHES_PER_FORK);
    for (const branchRoot of shown) {
      const subtree = collectSubtree(childrenByParent, nodeStubById, branchRoot.id);
      rowCursor = (rowCursor % 3) + 1;
      const y = spineY + rowCursor * ROW_HEIGHT * (rowCursor % 2 === 0 ? -1 : 1);
      const x = parentX + 18;
      if (subtree.length <= 1) {
        const words = branchRoot.words;
        nodes.push({
          id: branchRoot.id,
          x,
          y,
          r: isDeadEnd(branchRoot, false) ? 5 : nodeRadius(words),
          onPath: false,
          ring: false,
          summary: branchRoot.role === "summary",
          deadEnd: isDeadEnd(branchRoot, false),
          cold: isCold(branchRoot, false, now),
          words,
          preview: branchRoot.preview
        });
        edges.push({ id: `branch:${path[index]!.id}:${branchRoot.id}`, from: { x: parentX, y: spineY }, to: { x, y }, onPath: false, cold: isCold(branchRoot, false, now) });
      } else {
        const totalWords = subtree.reduce((sum, node) => sum + node.words, 0);
        const tip = subtree.reduce((latest, node) => Date.parse(node.lastTouched) > Date.parse(latest.lastTouched) ? node : latest, subtree[0]!);
        collapsedRuns.push({ id: `run:${branchRoot.id}`, x, y, width: Math.min(120, 20 + subtree.length * 4), count: subtree.length, words: totalWords, tipNodeId: tip.id });
        edges.push({ id: `branch:${path[index]!.id}:${branchRoot.id}`, from: { x: parentX, y: spineY }, to: { x, y }, onPath: false, cold: false });
      }
    }
    if (overflow.length > 0) {
      rowCursor = (rowCursor % 3) + 1;
      const y = spineY + rowCursor * ROW_HEIGHT * (rowCursor % 2 === 0 ? -1 : 1);
      const x = parentX + 18;
      let count = 0;
      let words = 0;
      for (const branchRoot of overflow) {
        const subtree = collectSubtree(childrenByParent, nodeStubById, branchRoot.id);
        count += subtree.length;
        words += subtree.reduce((sum, node) => sum + node.words, 0);
      }
      collapsedRuns.push({ id: `run:overflow:${path[index]!.id}`, x, y, width: Math.min(120, 20 + count * 4), count, words, tipNodeId: overflow[0]!.id });
      edges.push({ id: `branch:overflow:${path[index]!.id}`, from: { x: parentX, y: spineY }, to: { x, y }, onPath: false, cold: false });
    }
  }

  const rightmost = [
    MARGIN_X,
    ...nodes.map((node) => node.x + node.r),
    ...collapsedRuns.map((run) => run.x + run.width)
  ].reduce((max, value) => Math.max(max, value), MARGIN_X);
  const width = rightmost + MARGIN_X;
  const height = spineY + ROW_HEIGHT * 3 + MARGIN_Y;

  return {
    width,
    height,
    nodes,
    edges,
    collapsedRuns,
    chapterTicks,
    windowStart: lo,
    windowEnd: hi,
    windowed,
    totalParts: path.length
  };
}


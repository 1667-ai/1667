/** Pure geometry for the Map stemma (⌘5, D-30…D-32, D-34). No DOM, no
 * actions — `renderer-map-view.ts` draws what this returns. Kept in its own
 * file so it can be unit-tested (and timed) without Electron.
 *
 * Reduced scope (see `05-map-braid-aside.md` §0): no icicle, no regen
 * clouds. The minimap's own geometry (D-35, the whole line compressed to one
 * strip) lives in `renderer-minimap-layout.ts`, not here — this file only
 * gained the `centerPartId` windowing option the minimap drives. A collapsed
 * run's subtree is summarised as one bar even when it forks again further
 * down — the bar's count and words cover the whole subtree, but nested forks
 * inside it are not drawn, unless the `lensIndex` option (D-34) opens that
 * branch: inside the lens, an off-path branch with more than one take draws
 * its followed chain as individual nodes and folds only the rest of its
 * subtree into one small bar. This keeps the layout O(nodes) and the ≤120
 * budget easy to prove, at the cost of detail a writer would only reach by
 * hovering (or moving the map cursor to) the fork that grows it. */
import type { NodeStub, StoryPayload } from "../shared/types.js";
import { LENS_BUDGET, LENS_CHAIN_GAP, LENS_MAGNIFY_SCALE, LENS_MAX_RADIUS, LENS_PAD, LENS_REST_GAP, walkActiveChain, type MapLensLayout } from "./renderer-map-lens.js";

export const DEFAULT_MAP_NODE_BUDGET = 120;
/** A single fork can carry far more sibling takes than the whole budget (the
 * 2f mock shows one part with 61) — cap how many of one fork's branches ever
 * draw individually so one crowded fork cannot alone blow the ≤120 total;
 * the rest fold into one "+n more" bar, ordered by recency so the freshest
 * takes are the ones kept visible. */
const MAX_BRANCHES_PER_FORK = 8;
const MIN_SPINE_GAP = 28;
/** R-17: with a pane width given, the per-part gap is scaled so the drawn
 * window fills the pane, words as the relative weight, clamped to this
 * range — never so tight the story reads as a jumble, never so loose a
 * three-part story stretches to fill a wide monitor. */
const PANE_MIN_GAP = 48;
const PANE_MAX_GAP = 120;
const ROW_HEIGHT = 34;
const COLD_MS = 21 * 24 * 60 * 60 * 1000;
const MARGIN_X = 24;
const MARGIN_Y = 24;
/** Where a shown branch's own node (or the first node of an opened chain)
 * sits, right of its spine parent. */
const BRANCH_X_OFFSET = 18;

/** The row a fork's branch at this position (0-based, in recency order)
 * draws on: alternating below (even) and above (odd) the spine, one level
 * further out every two branches, so every branch up to
 * `MAX_BRANCHES_PER_FORK` — and the one more bar for its overflow — gets a
 * distinct, non-overlapping row instead of three rows repeating (review
 * finding 11). */
function branchRowOffset(branchIndex: number): number {
  const level = Math.floor(branchIndex / 2) + 1;
  const direction = branchIndex % 2 === 0 ? 1 : -1;
  return level * ROW_HEIGHT * direction;
}

// The worst case any fork draws is every branch up to the cap plus its own
// overflow bar (index `MAX_BRANCHES_PER_FORK`); sizing the canvas from that
// once, at module scope, keeps the margin correct without duplicating the
// row math above.
const WORST_CASE_ROW_OFFSETS = Array.from({ length: MAX_BRANCHES_PER_FORK + 1 }, (_, index) => branchRowOffset(index));
/** R-17: one figure, not an above/below pair — the worst case is asymmetric
 * (the overflow bar always lands below), but sizing both the same way keeps
 * the spine exactly halfway between the top and bottom margins instead of
 * biased toward whichever side happens to need less room, so the drawn
 * window reads as centred in the pane rather than pinned near the top. */
const MAX_ROW_OFFSET = Math.max(
  Math.max(...WORST_CASE_ROW_OFFSETS.filter((offset) => offset > 0)),
  Math.abs(Math.min(...WORST_CASE_ROW_OFFSETS.filter((offset) => offset < 0)))
);

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
  /** D-34: set only for a node inside the lens — the take's first few words,
   * ellipsized. The view draws it beside or under the node in `--type-meta`. */
  readonly label?: string;
}

export interface MapLayoutEdge {
  readonly id: string;
  readonly from: MapPoint;
  readonly to: MapPoint;
  readonly onPath: boolean;
  readonly cold: boolean;
  /** Draw a straight line rather than the off-path cubic curve. True for the
   * spine and for a D-34 opened chain's edges (still off-path in colour). */
  readonly straight: boolean;
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
  readonly lens: MapLensLayout | null;
}

export interface MapLayoutOptions {
  readonly maxNodes?: number;
  readonly now?: number;
  /** D-35: windows the spine around this part instead of `focusedPartId` —
   * set while the minimap's viewport targets a part outside the drawn
   * window. `undefined` (the default) leaves windowing keyed to
   * `focusedPartId`, unchanged from before the minimap existed. */
  readonly centerPartId?: string | null;
  /** D-34: a path index (into the full, unwindowed `story.path`) the lens is
   * centred on — the spine index nearest the pointer, or where the map
   * cursor's take leaves the current line. `undefined`/`null` (the default)
   * draws no lens, unchanged from before it existed. */
  readonly lensIndex?: number | null;
  /** R-17: the stage's client width — scales the per-part gap so the drawn
   * window fills the pane instead of a fixed 0.6px/word. `undefined` (the
   * default) keeps the pre-R-17 fixed scale, so existing callers and tests
   * are unaffected. */
  readonly paneWidth?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function nodeRadius(words: number): number {
  return Math.min(14, Math.max(4, Math.sqrt(Math.max(0, words))));
}

/** D-34: a node inside the lens reads legibly larger than the rest (R-18).
 * `nodeRadius` is already clamped to [4, 14], so this never needs its own
 * upper clamp. */
function lensNodeRadius(words: number): number {
  return nodeRadius(words) * LENS_MAGNIFY_SCALE;
}

/** D-34: the take's first few words, ellipsized — the short label a lensed
 * node draws beside itself. Pure text shaping, kept beside the geometry it
 * decorates rather than in the view. */
function shortLensLabel(text: string, maxWords = 4): string {
  const words = text.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return "";
  const shown = words.slice(0, maxWords).join(" ");
  return words.length > maxWords ? `${shown}…` : shown;
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
    return { width: MARGIN_X * 2, height: MARGIN_Y * 2, nodes: [], edges: [], collapsedRuns: [], chapterTicks: [], windowStart: 0, windowEnd: 0, windowed: false, totalParts: 0, lens: null };
  }
  const hasLens = options.lensIndex !== undefined && options.lensIndex !== null;
  const lensCenterIndex = hasLens ? Math.min(path.length - 1, Math.max(0, Math.trunc(options.lensIndex!))) : -1;
  // Always hold back a slice of the budget for the lens before windowing
  // picks `[lo, hi)`, so a windowed story still has room to open runs, and
  // so the drawn window does not change when a lens appears or goes away
  // (that would shift the whole stemma under the pointer).
  const windowBudget = Math.max(1, maxNodes - LENS_BUDGET);
  const childrenByParent = new Map<string | null, NodeStub[]>();
  for (const node of story.nodes) {
    const list = childrenByParent.get(node.parentId);
    if (list === undefined) childrenByParent.set(node.parentId, [node]);
    else list.push(node);
  }
  const nodeStubById = new Map(story.nodes.map((node) => [node.id, node] as const));
  const pathIds = new Set(path.map((node) => node.id));

  const centerId = options.centerPartId ?? focusedPartId;
  const centerIndex = centerId === null ? -1 : path.findIndex((node) => node.id === centerId);
  const safeFocusedIndex = centerIndex === -1 ? path.length - 1 : centerIndex;

  // Off-path branch roots per path index, precomputed once (O(nodes) total).
  // Index 0 also collects `childrenByParent.get(null)`: an alternate root
  // take has `parentId: null`, the same key path[0] itself sits under, so it
  // is never a child of `path[0].id` and would otherwise never be collected.
  const branchesByIndex = new Map<number, NodeStub[]>();
  for (let index = 0; index < path.length; index += 1) {
    const kids = childrenByParent.get(path[index]!.id) ?? [];
    const rootSiblings = index === 0 ? childrenByParent.get(null) ?? [] : [];
    const offPath = [...kids, ...rootSiblings].filter((kid) => !pathIds.has(kid.id));
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
    if (windowWeight(lo, hi) + boundaryBars <= windowBudget || hi - lo <= 1) break;
    const distLo = safeFocusedIndex - lo;
    const distHi = hi - 1 - safeFocusedIndex;
    if (distLo > distHi) lo += 1; else hi -= 1;
  }
  const windowed = lo > 0 || hi < path.length;
  const boundaryBarCount = (lo > 0 ? 1 : 0) + (hi < path.length ? 1 : 0);

  // D-34: decide which branches the lens opens, nearest the centre first,
  // before laying out a single x position — both the spacing pass right
  // below (R-18: the lens widens the gaps it spans) and the fisheye spacing
  // pass after it need the final lens span up front.
  const openedChains = new Map<string, { readonly chain: readonly NodeStub[]; readonly restCount: number; readonly restWords: number; readonly restTipId: string | null }>();
  let lensSpan: { start: number; end: number } | null = null;
  if (hasLens) {
    const center = Math.min(hi - 1, Math.max(lo, lensCenterIndex));
    lensSpan = { start: Math.max(lo, center - 1), end: Math.min(hi - 1, center + 1) };
    let remainingLensBudget = maxNodes - (windowWeight(lo, hi) + boundaryBarCount);
    offsetLoop:
    for (const offset of [0, -1, 1, -2, 2, -3, 3, -4, 4]) {
      if (Math.abs(offset) > LENS_MAX_RADIUS) continue;
      const index = center + offset;
      if (index < lo || index >= hi) continue;
      const branches = branchesByIndex.get(index);
      if (branches === undefined) continue;
      const ordered = [...branches].sort((a, b) => Date.parse(b.lastTouched) - Date.parse(a.lastTouched));
      for (const branchRoot of ordered.slice(0, MAX_BRANCHES_PER_FORK)) {
        const subtree = collectSubtree(childrenByParent, nodeStubById, branchRoot.id);
        if (subtree.length <= 1) continue; // nothing to open — already draws as one node
        const chain = walkActiveChain(branchRoot, childrenByParent);
        const chainIds = new Set(chain.map((node) => node.id));
        const rest = subtree.filter((node) => !chainIds.has(node.id));
        // Opening this branch replaces the 1 primitive its collapsed run
        // already costs in `weight` with the chain plus (maybe) a rest bar.
        const cost = chain.length + (rest.length > 0 ? 1 : 0) - 1;
        if (cost > remainingLensBudget) break offsetLoop; // nearest-centre-first: stop here, not just skip
        remainingLensBudget -= cost;
        const restTipId = rest.length === 0 ? null : rest.reduce((latest, node) => (Date.parse(node.lastTouched) > Date.parse(latest.lastTouched) ? node : latest), rest[0]!).id;
        openedChains.set(branchRoot.id, { chain, restCount: rest.length, restWords: rest.reduce((sum, node) => sum + node.words, 0), restTipId });
        lensSpan = { start: Math.min(lensSpan.start, index), end: Math.max(lensSpan.end, index) };
      }
    }
  }

  const insideLens = (index: number): boolean => hasLens && lensSpan !== null && index >= lensSpan.start && index <= lensSpan.end;
  // R-18: an opened chain's own node spacing widens by the same factor as
  // the spine's, so a bigger node (magnified below) never crowds the node
  // beside it.
  const chainGap = hasLens ? LENS_CHAIN_GAP * LENS_MAGNIFY_SCALE : LENS_CHAIN_GAP;

  // x positions along the windowed spine. With no `paneWidth` this is
  // exactly the pre-R-17 fixed 0.6px/word scale (existing callers and tests
  // are unaffected). With `paneWidth`, the per-part gap instead scales so the
  // window fills the pane — words stay the relative weight, clamped to
  // [PANE_MIN_GAP, PANE_MAX_GAP] — and, R-18, a gap inside the lens widens by
  // `LENS_MAGNIFY_SCALE` while every gap outside compresses by the same
  // factor (floored at the same minimum) so the total width stays close to
  // the pane instead of growing with the lens.
  const xs: number[] = [];
  if (options.paneWidth === undefined && !hasLens) {
    // Pre-R-17/R-18 behaviour, byte-for-byte: cumulative words along the
    // spine, a flat minimum gap, no lens to react to.
    let cursorX = MARGIN_X + (lo > 0 ? 40 : 0);
    let cumulativeWords = 0;
    for (let index = lo; index < hi; index += 1) {
      const stub = nodeStubById.get(path[index]!.id);
      cumulativeWords += stub?.words ?? 0;
      const proposed = MARGIN_X + (lo > 0 ? 40 : 0) + cumulativeWords * 0.6;
      cursorX = index === lo ? Math.max(cursorX, proposed) : Math.max(cursorX + MIN_SPINE_GAP, proposed);
      xs.push(cursorX);
    }
  } else {
    const paneWidth = options.paneWidth;
    let paneScale = 0;
    if (paneWidth !== undefined) {
      const boundaryOffset = (lo > 0 ? 40 : 0) + (hi < path.length ? 40 : 0);
      const available = Math.max(0, paneWidth - MARGIN_X * 2 - boundaryOffset);
      let totalGapWords = 0;
      for (let index = lo + 1; index < hi; index += 1) totalGapWords += Math.max(1, nodeStubById.get(path[index]!.id)?.words ?? 0);
      paneScale = totalGapWords > 0 ? available / totalGapWords : 0;
    }
    const floorGap = paneWidth === undefined ? MIN_SPINE_GAP : PANE_MIN_GAP;
    let cursorX = MARGIN_X + (lo > 0 ? 40 : 0);
    xs.push(cursorX);
    for (let index = lo + 1; index < hi; index += 1) {
      const words = Math.max(1, nodeStubById.get(path[index]!.id)?.words ?? 0);
      const base = paneWidth === undefined ? Math.max(MIN_SPINE_GAP, words * 0.6) : clamp(words * paneScale, PANE_MIN_GAP, PANE_MAX_GAP);
      const gap = !hasLens ? base : insideLens(index) ? base * LENS_MAGNIFY_SCALE : Math.max(floorGap, base / LENS_MAGNIFY_SCALE);
      cursorX += gap;
      xs.push(cursorX);
    }
  }

  // Fisheye spacing: an opened chain can need more room to its right than a
  // plain branch ever did — push every later spine x by the overrun so no
  // opened chain overlaps the next spine node or its own branches. Parts
  // outside the lens (nothing opened at their index) keep their spacing.
  let lensRightExtent = hasLens && lensSpan !== null ? xs[lensSpan.end - lo]! : 0;
  if (openedChains.size > 0) {
    let shift = 0;
    for (let index = lo; index < hi; index += 1) {
      xs[index - lo] = xs[index - lo]! + shift;
      const branches = branchesByIndex.get(index);
      if (branches === undefined) continue;
      const ordered = [...branches].sort((a, b) => Date.parse(b.lastTouched) - Date.parse(a.lastTouched)).slice(0, MAX_BRANCHES_PER_FORK);
      let rightmost = xs[index - lo]!;
      for (const branchRoot of ordered) {
        const opened = openedChains.get(branchRoot.id);
        if (opened === undefined) continue;
        const chainEndX = xs[index - lo]! + BRANCH_X_OFFSET + (opened.chain.length - 1) * chainGap;
        const lastWords = opened.chain[opened.chain.length - 1]!.words;
        const restWidth = Math.min(120, 20 + opened.restCount * 4);
        const endX = opened.restCount > 0 ? chainEndX + LENS_REST_GAP + restWidth : chainEndX + lensNodeRadius(lastWords);
        rightmost = Math.max(rightmost, endX);
      }
      if (lensSpan !== null && index >= lensSpan.start && index <= lensSpan.end) {
        lensRightExtent = Math.max(lensRightExtent, rightmost);
      }
      if (rightmost === xs[index - lo] || index + 1 >= hi) continue;
      const nextBase = xs[index + 1 - lo]!;
      const needed = rightmost + MIN_SPINE_GAP;
      if (needed > nextBase) shift += needed - nextBase;
    }
  }

  const nodes: MapLayoutNode[] = [];
  const edges: MapLayoutEdge[] = [];
  const collapsedRuns: MapCollapsedRun[] = [];
  const chapterTicks: MapChapterTick[] = [];
  const spineY = MARGIN_Y + MAX_ROW_OFFSET;

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
    const preview = stub?.preview ?? pathNode.text.slice(0, 48);
    const lensed = insideLens(index);
    nodes.push({
      id: pathNode.id,
      x: xs[index - lo]!,
      y: spineY,
      r: lensed ? lensNodeRadius(words) : nodeRadius(words),
      onPath: true,
      ring: siblingCount > 1,
      summary: pathNode.role === "summary",
      deadEnd: false,
      cold: false,
      words,
      preview,
      partNumber: index + 1,
      ...(lensed ? { label: shortLensLabel(preview) } : {})
    });
    if (index > lo) {
      edges.push({ id: `spine:${path[index - 1]!.id}:${pathNode.id}`, from: { x: xs[index - lo - 1]!, y: spineY }, to: { x: xs[index - lo]!, y: spineY }, onPath: true, straight: true, cold: false });
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

  for (let index = lo; index < hi; index += 1) {
    const branches = branchesByIndex.get(index);
    if (branches === undefined) continue;
    const parentX = xs[index - lo]!;
    const ordered = [...branches].sort((a, b) => Date.parse(b.lastTouched) - Date.parse(a.lastTouched));
    const shown = ordered.slice(0, MAX_BRANCHES_PER_FORK);
    const overflow = ordered.slice(MAX_BRANCHES_PER_FORK);
    shown.forEach((branchRoot, branchIndex) => {
      const y = spineY + branchRowOffset(branchIndex);
      const x = parentX + BRANCH_X_OFFSET;
      const opened = openedChains.get(branchRoot.id);
      if (opened !== undefined) {
        // D-34: the lens opened this branch — draw its followed chain as
        // individual nodes, spaced evenly to the right, with straight edges;
        // any takes off that chain fold into one small rest bar.
        let chainX = x;
        opened.chain.forEach((chainNode, chainPosition) => {
          const words = chainNode.words;
          const deadEnd = isDeadEnd(chainNode, false);
          nodes.push({
            id: chainNode.id,
            x: chainX,
            y,
            r: deadEnd ? 5 : lensNodeRadius(words),
            onPath: false,
            ring: false,
            summary: chainNode.role === "summary",
            deadEnd,
            cold: isCold(chainNode, false, now),
            words,
            preview: chainNode.preview,
            ...(deadEnd ? {} : { label: shortLensLabel(chainNode.preview) })
          });
          const from = chainPosition === 0 ? { x: parentX, y: spineY } : { x: chainX - chainGap, y };
          edges.push({ id: `lens:${path[index]!.id}:${chainNode.id}`, from, to: { x: chainX, y }, onPath: false, straight: true, cold: isCold(chainNode, false, now) });
          chainX += chainGap;
        });
        if (opened.restCount > 0) {
          const restX = chainX - chainGap + LENS_REST_GAP;
          collapsedRuns.push({ id: `run:${branchRoot.id}`, x: restX, y, width: Math.min(120, 20 + opened.restCount * 4), count: opened.restCount, words: opened.restWords, tipNodeId: opened.restTipId! });
          edges.push({ id: `lens:rest:${branchRoot.id}`, from: { x: chainX - chainGap, y }, to: { x: restX, y }, onPath: false, straight: true, cold: false });
        }
        return;
      }
      const subtree = collectSubtree(childrenByParent, nodeStubById, branchRoot.id);
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
        edges.push({ id: `branch:${path[index]!.id}:${branchRoot.id}`, from: { x: parentX, y: spineY }, to: { x, y }, onPath: false, straight: false, cold: isCold(branchRoot, false, now) });
      } else {
        const totalWords = subtree.reduce((sum, node) => sum + node.words, 0);
        const tip = subtree.reduce((latest, node) => Date.parse(node.lastTouched) > Date.parse(latest.lastTouched) ? node : latest, subtree[0]!);
        collapsedRuns.push({ id: `run:${branchRoot.id}`, x, y, width: Math.min(120, 20 + subtree.length * 4), count: subtree.length, words: totalWords, tipNodeId: tip.id });
        edges.push({ id: `branch:${path[index]!.id}:${branchRoot.id}`, from: { x: parentX, y: spineY }, to: { x, y }, onPath: false, straight: false, cold: false });
      }
    });
    if (overflow.length > 0) {
      const y = spineY + branchRowOffset(shown.length);
      const x = parentX + BRANCH_X_OFFSET;
      let count = 0;
      let words = 0;
      for (const branchRoot of overflow) {
        const subtree = collectSubtree(childrenByParent, nodeStubById, branchRoot.id);
        count += subtree.length;
        words += subtree.reduce((sum, node) => sum + node.words, 0);
      }
      collapsedRuns.push({ id: `run:overflow:${path[index]!.id}`, x, y, width: Math.min(120, 20 + count * 4), count, words, tipNodeId: overflow[0]!.id });
      edges.push({ id: `branch:overflow:${path[index]!.id}`, from: { x: parentX, y: spineY }, to: { x, y }, onPath: false, straight: false, cold: false });
    }
  }

  const rightmost = [
    MARGIN_X,
    ...nodes.map((node) => node.x + node.r),
    ...collapsedRuns.map((run) => run.x + run.width)
  ].reduce((max, value) => Math.max(max, value), MARGIN_X);
  const width = rightmost + MARGIN_X;
  const height = spineY + MAX_ROW_OFFSET + MARGIN_Y;

  const lens: MapLensLayout | null = hasLens && lensSpan !== null
    ? { startIndex: lensSpan.start, endIndex: lensSpan.end, x: xs[lensSpan.start - lo]! - LENS_PAD, width: lensRightExtent + LENS_PAD - (xs[lensSpan.start - lo]! - LENS_PAD) }
    : null;

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
    totalParts: path.length,
    lens
  };
}


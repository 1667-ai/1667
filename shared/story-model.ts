import { classifyMapLines, type MapLineClassification } from "./map-model.js";
import { childrenOf, indexTree, nodeById, pathTo, type TreeIndex } from "./story-tree.js";
import type { Tag, NodeStub, StoryPayload } from "./types.js";

export interface SummaryTakeLock {
  storyId: string;
  nodeId: string;
  offset: number | null;
}

interface Continuation {
  leafId: string;
  parts: number;
  words: number;
}

/** One linear pass turns the all-stub payload into the browser's reusable view
 * model. Tree surfaces must share this index instead of rescanning every stub
 * per visible row. */
export interface StoryIndex extends MapLineClassification {
  tree: TreeIndex<NodeStub>;
  tagByNodeId: ReadonlyMap<string, Tag>;
  tagBelowByNodeId: ReadonlyMap<string, Tag>;
  continuationByNodeId: ReadonlyMap<string, Continuation>;
  depthByNodeId: ReadonlyMap<string, number>;
  subtreeCountByNodeId: ReadonlyMap<string, number>;
}

const STORY_INDEXES = new WeakMap<StoryPayload, StoryIndex>();

export function createStoryIndex(payload: StoryPayload): StoryIndex {
  // Memoized per payload identity: helpers default to createStoryIndex(payload),
  // so a forgotten index argument must never rebuild the O(nodes) model.
  // Payloads are immutable adoption units — mutate one and this goes stale.
  const cached = STORY_INDEXES.get(payload);
  if (cached !== undefined) return cached;
  const index = buildStoryIndex(payload);
  STORY_INDEXES.set(payload, index);
  return index;
}

function buildStoryIndex(payload: StoryPayload): StoryIndex {
  const tree = indexTree(payload);
  const tagByNodeId = new Map(payload.tags.map((tag) => [tag.nodeId, tag] as const));
  const tagBelowByNodeId = new Map<string, Tag>();
  const continuationByNodeId = new Map<string, Continuation>();
  const depthByNodeId = new Map<string, number>();
  const subtreeCountByNodeId = new Map<string, number>();

  for (const node of payload.nodes) {
    const parentDepth = node.parentId === null ? 0 : depthByNodeId.get(node.parentId) ?? 0;
    depthByNodeId.set(node.id, parentDepth + 1);
  }

  for (let offset = payload.nodes.length - 1; offset >= 0; offset -= 1) {
    const node = payload.nodes[offset]!;
    const child = rememberedChildOf(node, tree);
    const next = child === undefined ? undefined : continuationByNodeId.get(child.id);
    continuationByNodeId.set(node.id, next === undefined || child === undefined
      ? { leafId: node.id, parts: 0, words: 0 }
      : { leafId: next.leafId, parts: next.parts + 1, words: next.words + child.words });

    const subtreeCount = subtreeCountByNodeId.get(node.id) ?? 1;
    subtreeCountByNodeId.set(node.id, subtreeCount);
    if (node.parentId !== null) {
      subtreeCountByNodeId.set(node.parentId, (subtreeCountByNodeId.get(node.parentId) ?? 1) + subtreeCount);
    }

    const ownTag = tagByNodeId.get(node.id);
    if (ownTag !== undefined) {
      tagBelowByNodeId.set(node.id, ownTag);
    } else {
      for (const descendant of tree.childrenByParentId.get(node.id) ?? []) {
        const tag = tagBelowByNodeId.get(descendant.id);
        if (tag !== undefined) {
          tagBelowByNodeId.set(node.id, tag);
          break;
        }
      }
    }
  }

  const mapLines = classifyMapLines(payload, tree, tagByNodeId, tagBelowByNodeId);

  return {
    tree,
    tagByNodeId,
    tagBelowByNodeId,
    continuationByNodeId,
    depthByNodeId,
    subtreeCountByNodeId,
    ...mapLines
  };
}

/** The take a node remembers continuing into. An `activeChildId` counts only
 * while the child still points back at it — pruning and adoption can leave the
 * pointer behind. */
export function rememberedChildOf(node: NodeStub, tree: TreeIndex<NodeStub>): NodeStub | undefined {
  const child = node.activeChildId === null ? undefined : tree.nodesById.get(node.activeChildId);
  return child?.parentId === node.id ? child : undefined;
}

export function rememberedLeafId(payload: StoryPayload, nodeId: string, index = createStoryIndex(payload)): string {
  return index.continuationByNodeId.get(nodeId)?.leafId ?? nodeId;
}

export function recentLeafIds(payload: StoryPayload, activeLeafId: string | null, index = createStoryIndex(payload)): string[] {
  const seen = new Set<string>();
  const leaves: string[] = [];
  for (const nodeId of payload.recentNodeIds) {
    const leafId = rememberedLeafId(payload, nodeId, index);
    if (leafId === activeLeafId || seen.has(leafId) || !index.tree.nodesById.has(leafId)) continue;
    seen.add(leafId);
    leaves.push(leafId);
  }
  return leaves;
}

export function continuationStats(payload: StoryPayload, nodeId: string, index = createStoryIndex(payload)): { parts: number; words: number } {
  const continuation = index.continuationByNodeId.get(nodeId);
  return continuation === undefined ? { parts: 0, words: 0 } : { parts: continuation.parts, words: continuation.words };
}

export function tagBelow(payload: StoryPayload, nodeId: string, index = createStoryIndex(payload)): Tag | null {
  const remembered = rememberedLeafId(payload, nodeId, index);
  return index.tagByNodeId.get(remembered) ?? index.tagBelowByNodeId.get(nodeId) ?? null;
}

/** Tag naming for a row that opens the node's remembered continuation.
 * Unlike structural visibility, an unrelated inactive descendant does not name it. */
export function rememberedLineTag(
  payload: StoryPayload,
  nodeId: string,
  index = createStoryIndex(payload)
): Tag | null {
  return index.tagByNodeId.get(rememberedLeafId(payload, nodeId, index)) ?? null;
}

export type MapForkRow =
  | { kind: "take"; take: NodeStub; index: number }
  | { kind: "draft-rollup"; index: number };

export interface MapForkPage {
  rows: MapForkRow[];
  authoredCount: number;
  draftCount: number;
}

interface IndexedTake { take: NodeStub; index: number }
interface MapForkGroups { authored: IndexedTake[]; drafts: IndexedTake[]; reading?: IndexedTake }

export interface ActiveContinuationWindow {
  head: readonly NodeStub[];
  tail: readonly NodeStub[];
  hidden: number;
  total: number;
}

const ACTIVE_CONTINUATION_HEAD = 12;
const ACTIVE_CONTINUATION_TAIL = 13;
const ACTIVE_CONTINUATION_WINDOWS = new WeakMap<StoryIndex, Map<string, ActiveContinuationWindow>>();

/** The map repeats the selected take's active continuation only as a fixed-size
 * head/tail window. Scan once per immutable index; never materialize the whole
 * line as React elements or a second full-path array. */
export function activeContinuationWindow(index: StoryIndex, takeId: string): ActiveContinuationWindow {
  let windows = ACTIVE_CONTINUATION_WINDOWS.get(index);
  if (windows === undefined) {
    windows = new Map();
    ACTIVE_CONTINUATION_WINDOWS.set(index, windows);
  }
  const cached = windows.get(takeId);
  if (cached !== undefined) return cached;

  const head: NodeStub[] = [];
  const tail: NodeStub[] = [];
  let total = 0;
  let parent = index.tree.nodesById.get(takeId) ?? null;
  while (parent !== null && parent.activeChildId !== null) {
    const child = index.tree.nodesById.get(parent.activeChildId) ?? null;
    if (child === null || child.parentId !== parent.id) break;
    total += 1;
    if (head.length < ACTIVE_CONTINUATION_HEAD) head.push(child);
    else {
      tail.push(child);
      if (tail.length > ACTIVE_CONTINUATION_TAIL) tail.shift();
    }
    if (child.childCount > 1) break;
    parent = child;
  }
  const window = { head, tail, hidden: total - head.length - tail.length, total };
  windows.set(takeId, window);
  return window;
}

const MAP_FORK_GROUPS = new WeakMap<
  StoryIndex,
  WeakMap<readonly NodeStub[], Map<string | null, MapForkGroups>>
>();

/** Classify a large fork once per immutable story index, then expose only rows
 * React will render. Pagination and confirmation renders reuse the grouping. */
export function mapForkPage(
  payload: StoryPayload,
  index: StoryIndex,
  takes: readonly NodeStub[],
  readingId: string | null,
  authoredLimit: number,
  draftLimit: number
): MapForkPage {
  const { authored, drafts, reading } = mapForkGroups(payload, index, takes, readingId);
  const visibleAuthored = authored.slice(0, authoredLimit);
  if (reading !== undefined && !visibleAuthored.some(({ take }) => take.id === reading.take.id)) {
    visibleAuthored.push(reading);
  }
  const rows: MapForkRow[] = visibleAuthored.map((entry) => ({ kind: "take", ...entry }));
  if (draftLimit === 0) {
    if (drafts[0] !== undefined) rows.push({ kind: "draft-rollup", index: drafts[0].index });
  } else {
    rows.push(...drafts.slice(0, draftLimit).map((entry) => ({ kind: "take" as const, ...entry })));
  }
  rows.sort((left, right) => left.index - right.index);
  return { rows, authoredCount: authored.length, draftCount: drafts.length };
}

function mapForkGroups(
  payload: StoryPayload,
  index: StoryIndex,
  takes: readonly NodeStub[],
  readingId: string | null
): MapForkGroups {
  let byTakes = MAP_FORK_GROUPS.get(index);
  if (byTakes === undefined) {
    byTakes = new WeakMap();
    MAP_FORK_GROUPS.set(index, byTakes);
  }
  let byReading = byTakes.get(takes);
  if (byReading === undefined) {
    byReading = new Map();
    byTakes.set(takes, byReading);
  }
  const cached = byReading.get(readingId);
  if (cached !== undefined) return cached;

  const draftCandidates: IndexedTake[] = [];
  for (const [takeIndex, take] of takes.entries()) {
    if (take.id !== readingId && isDraftTake(payload, take, index)) draftCandidates.push({ take, index: takeIndex });
  }
  const drafts = draftCandidates.length > 1 ? draftCandidates : [];
  const draftIds = new Set(drafts.map(({ take }) => take.id));
  const authored: IndexedTake[] = [];
  let reading: IndexedTake | undefined;
  for (const [takeIndex, take] of takes.entries()) {
    if (!draftIds.has(take.id)) {
      const entry = { take, index: takeIndex };
      authored.push(entry);
      if (take.id === readingId) reading = entry;
    }
  }
  const groups = { authored, drafts, ...(reading === undefined ? {} : { reading }) };
  byReading.set(readingId, groups);
  return groups;
}

export interface StoryLine {
  leafId: string;
  name: string;
  parts: number;
  active: boolean;
  canon: boolean;
  summary: boolean;
}

/** One thread per distinct line reachable from any fork (plus the trunk), regen
 * drafts skipped; a line crossing several forks appears once. O(nodes) on the
 * shared index. */
export function storyLines(
  payload: StoryPayload,
  index = createStoryIndex(payload)
): { lines: StoryLine[]; draftCount: number } {
  const activeLeafId = payload.path.at(-1)?.id ?? null;
  const groups: Array<string | null> = [
    null,
    ...payload.nodes.filter((node) => node.childCount > 1).map((node) => node.id)
  ];
  const seen = new Set<string>();
  const lines: StoryLine[] = [];
  let draftCount = 0;
  for (const parentId of groups) {
    const takes = childrenOf(index.tree, parentId);
    // Same rule as the fork listing: a lone childless take stays a line of its
    // own; only groups of them collapse away as regen drafts.
    const draftIds = new Set<string>();
    for (const take of takes) {
      if (rememberedLeafId(payload, take.id, index) !== activeLeafId && isDraftTake(payload, take, index)) {
        draftIds.add(take.id);
      }
    }
    if (draftIds.size < 2) draftIds.clear();
    for (const take of takes) {
      if (draftIds.has(take.id)) {
        draftCount += 1;
        continue;
      }
      const leafId = rememberedLeafId(payload, take.id, index);
      if (seen.has(leafId)) continue;
      seen.add(leafId);
      const leaf = nodeById(index.tree, leafId);
      const tag = index.tagByNodeId.get(leafId) ?? null;
      lines.push({
        leafId,
        name: tag?.name ?? workingName(leaf),
        parts: index.depthByNodeId.get(leafId) ?? 1,
        active: leafId === activeLeafId,
        canon: tag?.status === "Canon",
        summary: take.role === "summary" || leaf?.role === "summary" || tag?.status === "Summary"
      });
    }
  }
  return { lines, draftCount };
}

/** The one definition of a discardable regen draft: a childless, unauthored,
 * untagged take. Callers add their own "not the take being read" guard and
 * the "only groups of ≥2 collapse" rule where it applies. */
export function isDraftTake(payload: StoryPayload, take: NodeStub, index = createStoryIndex(payload)): boolean {
  return take.childCount === 0 && take.human !== true && take.role !== "summary"
    && tagBelow(payload, take.id, index) === null;
}

export function workingName(stub: NodeStub | null): string {
  if (stub === null) return "Blank line";
  const words = stub.preview.trim().split(/\s+/).filter(Boolean).slice(0, 6);
  return words.length === 0 ? "Blank line" : `${words.join(" ")}…`;
}

export function lineName(payload: StoryPayload, leafId: string, index = createStoryIndex(payload)): string {
  return index.tagByNodeId.get(leafId)?.name ?? workingName(nodeById(index.tree, leafId));
}

export function switchAnnouncement(payload: StoryPayload, targetNodeId: string, index = createStoryIndex(payload)): string | null {
  const leaf = payload.path.at(-1);
  if (leaf === undefined) return null;
  const targetIndex = payload.path.findIndex((node) => node.id === targetNodeId);
  const following = targetIndex === -1 ? 0 : payload.path.length - targetIndex - 1;
  const suffix = following === 0
    ? `the story ends after Part ${payload.path.length}.`
    : `${following} ${following === 1 ? "part follows" : "parts follow"}.`;
  return `Now on: ${lineName(payload, leaf.id, index)} — ${suffix}`;
}

const AGE_DAY_MS = 86_400_000;

export function formatAge(date: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - Date.parse(date));
  const days = Math.floor(elapsed / AGE_DAY_MS);
  if (days === 0) return "TODAY";
  if (days === 1) return "YESTERDAY";
  if (days < 7) return `${days}D AGO`;
  if (days < 35) return `${Math.floor(days / 7)}W AGO`;
  if (days < 365) return `${Math.floor(days / 30)}MO AGO`;
  return `${Math.floor(days / 365)}Y AGO`;
}

/** Next instant at which formatAge() changes its displayed bucket. */
export function nextAgeChange(date: string, now: number): number | null {
  const timestamp = Date.parse(date);
  if (!Number.isFinite(timestamp)) return null;
  const days = Math.floor(Math.max(0, now - timestamp) / AGE_DAY_MS);
  const nextDay = days < 7
    ? days + 1
    : days < 35
      ? Math.min(35, (Math.floor(days / 7) + 1) * 7)
      : days < 365
        ? Math.min(365, (Math.floor(days / 30) + 1) * 30)
        : (Math.floor(days / 365) + 1) * 365;
  return timestamp + nextDay * AGE_DAY_MS;
}

export function summaryLockedNodeIds(
  lock: SummaryTakeLock | null,
  payload: StoryPayload,
  index = createStoryIndex(payload)
): ReadonlySet<string> {
  if (lock === null || lock.storyId !== payload.id || nodeById(index.tree, lock.nodeId) === null) return new Set();
  const path = pathTo(index.tree, lock.nodeId);
  const reset = path.findLastIndex((node) => node.role === "summary");
  return new Set(path.slice(reset === -1 ? 0 : reset).map((node) => node.id));
}

/** Deleting any ancestor of the summary point would also delete fingerprinted
 * source nodes, including the latest summary context reset. Other map takes
 * remain switchable and prunable while the model runs. */
export function summaryPruneLockedNodeIds(
  lock: SummaryTakeLock | null,
  payload: StoryPayload,
  index = createStoryIndex(payload)
): ReadonlySet<string> {
  if (lock === null || lock.storyId !== payload.id || nodeById(index.tree, lock.nodeId) === null) return new Set();
  return new Set(pathTo(index.tree, lock.nodeId).map((node) => node.id));
}

export function summaryLocksAppend(
  lock: SummaryTakeLock | null,
  storyId: string,
  lastNodeId: string
): boolean {
  return lock !== null && lock.storyId === storyId && lock.nodeId === lastNodeId && lock.offset === null;
}

export function summaryExtendsCurrentLeaf(lock: SummaryTakeLock, previousLeafId: string | null): boolean {
  return lock.offset === null && previousLeafId === lock.nodeId;
}

export function deletionCopy(total: number): string {
  const below = total - 1;
  if (below === 0) return "Delete this take? 1 part total, gone for good.";
  return `Delete this take and the ${below} ${below === 1 ? "part" : "parts"} beneath it? ${total} parts total, gone for good.`;
}

export function pathLength(index: StoryIndex, nodeId: string): number {
  return index.depthByNodeId.get(nodeId) ?? 0;
}

export function subtreeNodeCount(index: StoryIndex, nodeId: string): number {
  return index.subtreeCountByNodeId.get(nodeId) ?? 0;
}

export function virtualRange(
  total: number,
  scrollTop: number,
  rowHeight: number,
  viewportHeight: number,
  overscan: number
): { start: number; end: number } {
  const visible = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const start = Math.max(0, Math.min(total - visible, Math.floor(scrollTop / rowHeight) - overscan));
  return { start, end: Math.min(total, start + visible) };
}

/** Keep the reading column's DOM bounded for book-length active paths while
 * retaining a few earliest landmarks and the parts nearest the reading tip. */
export function activePathWindow(
  total: number,
  olderLimit: number,
  options: { collapseAfter?: number; fullWindow?: number; headWindow?: number } = {}
): number[] {
  const collapseAfter = options.collapseAfter ?? 30;
  const fullWindow = options.fullWindow ?? 12;
  const headWindow = options.headWindow ?? 4;
  if (total <= collapseAfter) return Array.from({ length: total }, (_, index) => index);

  const collapsedEnd = Math.max(0, total - fullWindow);
  const headEnd = Math.min(headWindow, collapsedEnd);
  const tailStart = Math.max(headEnd, collapsedEnd - Math.max(0, olderLimit));
  return [
    ...Array.from({ length: headEnd }, (_, index) => index),
    ...Array.from({ length: total - tailStart }, (_, offset) => tailStart + offset)
  ];
}

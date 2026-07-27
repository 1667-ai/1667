import { createStoryIndex, rememberedChildOf, type StoryIndex } from "../../shared/story-model.js";
import { isMapSketch } from "../../shared/map-model.js";
import { childrenOf, isChapterSummary, pathTo } from "../../shared/story-tree.js";
import type { Bookmark, NodeStub, StoryPayload } from "../../shared/types.js";

export interface PathCell {
  node: NodeStub;
  take: number;
  takeCount: number;
  active: boolean;
  cursor: boolean;
  /** Decision 18: this take branches into subtakes of its own, so it wears the ring. */
  subtakes: boolean;
  bookmark: Bookmark | null;
}

export interface PathRow {
  depth: number;
  cells: PathCell[];
  hiddenBefore: number;
  hiddenAfter: number;
  /** The node this row shows on the cursor's line — its preview carries the row. */
  pathNode: NodeStub;
  cursorHere: boolean;
}

export interface PathLayout {
  rows: PathRow[];
  totalDepth: number;
  visibleStart: number;
  visibleEnd: number;
  cursorNodeId: string;
  bookmarks: Bookmark[];
  totalParts: number;
  totalLines: number;
  sketchCount: number;
}

export function initialPathCursor(payload: StoryPayload, focusIndex: number): string | null {
  return payload.path[Math.max(0, Math.min(focusIndex, payload.path.length - 1))]?.id ?? null;
}

export function movePathCursor(
  payload: StoryPayload,
  cursorNodeId: string,
  vertical: -1 | 0 | 1,
  horizontal: -1 | 0 | 1,
  showSketches = false
): string {
  const index = createStoryIndex(payload);
  const cursor = visiblePathCursor(payload, cursorNodeId, showSketches, index);
  if (cursor === undefined) return initialPathCursor(payload, payload.path.length - 1) ?? cursorNodeId;
  if (horizontal !== 0) {
    const siblings = visiblePathSiblings(payload, cursor.parentId, showSketches, index);
    const offset = siblings.findIndex((node) => node.id === cursor.id);
    if (offset !== -1 && siblings.length > 0) return siblings[(offset + horizontal + siblings.length) % siblings.length]!.id;
  }
  if (vertical < 0) return cursor.parentId ?? cursor.id;
  if (vertical > 0) {
    const path = pathTo(index.tree, visibleLineLeafId(cursor.id, showSketches, index));
    const depth = index.depthByNodeId.get(cursor.id) ?? 1;
    const target = path[depth];
    return target === undefined ? cursor.id
      : visiblePathCursor(payload, target.id, showSketches, index)?.id ?? cursor.id;
  }
  return cursor.id;
}

export function resolveRerouteTarget(payload: StoryPayload, cursorNodeId: string): string | null {
  return createStoryIndex(payload).tree.nodesById.has(cursorNodeId) ? cursorNodeId : null;
}

export function createPathLayout(
  payload: StoryPayload,
  cursorNodeId: string,
  maxRows = 13,
  siblingWindow = 5,
  showSketches = false
): PathLayout {
  const index = createStoryIndex(payload);
  const cursor = visiblePathCursor(payload, cursorNodeId, showSketches, index)
    ?? index.tree.nodesById.get(payload.path.at(-1)?.id ?? "");
  const resolvedCursor = cursor?.id ?? cursorNodeId;
  const leafId = cursor === undefined ? null : visibleLineLeafId(cursor.id, showSketches, index);
  // Rows come from the cursor's remembered line only — mixing in the active
  // path below a shorter branch would display continuations that don't exist.
  const cursorPath = leafId === null ? [] : pathTo(index.tree, leafId);
  const totalDepth = cursorPath.length;
  const cursorDepth = cursor === undefined ? 1 : index.depthByNodeId.get(cursor.id) ?? 1;
  const visibleStart = Math.max(1, Math.min(cursorDepth - Math.floor(maxRows / 2), totalDepth - maxRows + 1));
  const visibleEnd = Math.min(totalDepth, visibleStart + maxRows - 1);
  const activeIds = new Set(payload.path.map((node) => node.id));
  const rows: PathRow[] = [];
  for (let depth = visibleStart; depth <= visibleEnd; depth += 1) {
    const pathNode = cursorPath[depth - 1];
    if (pathNode === undefined) continue;
    const siblings = visiblePathSiblings(payload, pathNode.parentId, showSketches, index);
    const selected = siblings.findIndex((node) => node.id === pathNode.id);
    const start = siblingWindowStart(siblings.length, selected, siblingWindow);
    const visible = siblings.slice(start, start + siblingWindow);
    rows.push({
      depth,
      hiddenBefore: start,
      hiddenAfter: Math.max(0, siblings.length - start - visible.length),
      pathNode,
      cursorHere: pathNode.id === resolvedCursor || visible.some((node) => node.id === resolvedCursor),
      cells: visible.map((node, offset) => ({
        node,
        take: start + offset + 1,
        takeCount: siblings.length,
        active: activeIds.has(node.id),
        cursor: node.id === resolvedCursor,
        subtakes: firstVisibleTake(node.id, showSketches, index) !== undefined,
        bookmark: node.childCount === 0 ? index.bookmarkByNodeId.get(node.id) ?? null : null
      }))
    });
  }
  return {
    rows,
    totalDepth,
    visibleStart,
    visibleEnd,
    cursorNodeId: resolvedCursor,
    bookmarks: [...payload.bookmarks],
    totalParts: payload.nodes.filter((node) => !isChapterSummary(node)).length,
    totalLines: index.mapLineCount,
    sketchCount: index.mapSketchNodeIds.size
  };
}

/** Sibling cells as painted by MAP · path. Take ordinals index this exact list. */
export function visiblePathSiblings(
  payload: StoryPayload,
  parentId: string | null,
  showSketches: boolean,
  index = createStoryIndex(payload)
): NodeStub[] {
  return childrenOf(index.tree, parentId).filter((node) => isVisibleTake(node, showSketches, index));
}

/** One definition of what MAP · path will paint: chapter summaries are chrome,
 * not takes, and a folded sketch is not a take you can reach. */
function isVisibleTake(node: NodeStub, showSketches: boolean, index: StoryIndex): boolean {
  return !isChapterSummary(node) && (showSketches || !isMapSketch(node, index));
}

/** The ring asks what pressing `↓` would reveal, so this short-circuits instead
 * of materializing what can be a very wide list of children. */
function firstVisibleTake(parentId: string, showSketches: boolean, index: StoryIndex): NodeStub | undefined {
  return childrenOf(index.tree, parentId).find((node) => isVisibleTake(node, showSketches, index));
}

/** Where the map's rows end under a node: the remembered line, but only through
 * takes this view will paint. Two states make that differ from the story's own
 * `rememberedLeafId`, and in both the rows must agree with the ring above them
 * and with `↓`:
 *
 * - a reader who stopped the line at a node (`stopAtNode` clears its
 *   `activeChildId`) left it remembering itself, so descent falls through to
 *   the node's first visible subtake;
 * - a remembered take can itself be a folded sketch, which the map is not
 *   showing, so descent takes the first visible sibling instead of painting a
 *   row the reader cannot reach. */
function visibleLineLeafId(nodeId: string, showSketches: boolean, index: StoryIndex): string {
  let leafId = nodeId;
  // Every step lands strictly deeper in the tree, so the walk terminates.
  for (;;) {
    const node = index.tree.nodesById.get(leafId);
    const remembered = node === undefined ? undefined : rememberedChildOf(node, index.tree);
    const next = remembered !== undefined && isVisibleTake(remembered, showSketches, index)
      ? remembered : firstVisibleTake(leafId, showSketches, index);
    if (next === undefined) return leafId;
    leafId = next.id;
  }
}


function visiblePathCursor(
  payload: StoryPayload,
  cursorNodeId: string,
  showSketches: boolean,
  index: StoryIndex
): NodeStub | undefined {
  const cursor = index.tree.nodesById.get(cursorNodeId);
  if (cursor === undefined || showSketches || !isMapSketch(cursor, index)) return cursor;
  const siblings = visiblePathSiblings(payload, cursor.parentId, false, index);
  const activeIds = new Set(payload.path.map((node) => node.id));
  return siblings.find((node) => activeIds.has(node.id)) ?? siblings[0]
    ?? (cursor.parentId === null ? undefined : index.tree.nodesById.get(cursor.parentId));
}

function siblingWindowStart(total: number, selected: number, window: number): number {
  if (total <= window) return 0;
  return Math.max(0, Math.min(total - window, selected - Math.floor(window / 2)));
}

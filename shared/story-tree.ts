import { MAX_RECENT_LINES, type StoryNode } from "./types.js";

export interface TreeNode {
  id: string;
  parentId: string | null;
  activeChildId: string | null;
  chapterBreakId?: string;
}

export interface TreeState<Node extends TreeNode = StoryNode> {
  nodes: Node[];
  activeRootId: string | null;
}

/** Reusable O(1) browser lookups for tree-heavy views. The arrays stored in
 * these maps are in document order, matching TreeState.nodes. */
export interface TreeIndex<Node extends TreeNode = StoryNode> extends TreeState<Node> {
  nodesById: ReadonlyMap<string, Node>;
  childrenByParentId: ReadonlyMap<string | null, Node[]>;
  siblingPositionByNodeId: ReadonlyMap<string, { index: number; count: number }>;
}

type TreeSource<Node extends TreeNode> = TreeState<Node> | TreeIndex<Node>;

export interface LineState<Node extends TreeNode = StoryNode> extends TreeState<Node> {
  recentNodeIds: string[];
}

export interface NamedLineState<Node extends TreeNode = StoryNode> extends TreeState<Node> {
  bookmarks: readonly { nodeId: string }[];
}

export interface UnusedTakePruneSelection {
  /** Childless line-node roots selected for deletion. */
  takeIds: string[];
  /** Complete deletion set, including non-line descendants such as chapter summaries. */
  nodeIds: string[];
}

export function indexTree<Node extends TreeNode>(state: TreeState<Node>): TreeIndex<Node> {
  const nodesById = new Map<string, Node>();
  const childrenByParentId = new Map<string | null, Node[]>();
  for (const node of state.nodes) {
    nodesById.set(node.id, node);
    const siblings = childrenByParentId.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParentId.set(node.parentId, siblings);
  }
  const siblingPositionByNodeId = new Map<string, { index: number; count: number }>();
  for (const children of childrenByParentId.values()) {
    const siblings = children.filter(isLineNode);
    for (let offset = 0; offset < siblings.length; offset += 1) {
      siblingPositionByNodeId.set(siblings[offset]!.id, { index: offset + 1, count: siblings.length });
    }
  }
  return {
    nodes: state.nodes,
    activeRootId: state.activeRootId,
    nodesById,
    childrenByParentId,
    siblingPositionByNodeId
  };
}

export function childrenOf<Node extends TreeNode>(state: TreeSource<Node>, parentId: string | null): Node[] {
  const children = isTreeIndex(state)
    ? state.childrenByParentId.get(parentId) ?? []
    : state.nodes.filter((node) => node.parentId === parentId);
  return children.filter(isLineNode);
}

export function nodeById<Node extends TreeNode>(state: TreeSource<Node>, id: string): Node | null {
  return isTreeIndex(state) ? state.nodesById.get(id) ?? null : state.nodes.find((node) => node.id === id) ?? null;
}

export function activePath<Node extends TreeNode>(state: TreeSource<Node>): Node[] {
  if (state.activeRootId === null) return [];
  const index = isTreeIndex(state) ? state : indexTree(state);
  const root = index.nodesById.get(state.activeRootId) ?? null;
  if (root === null || !isLineNode(root)) return [];

  const path = [root];
  let current = root;
  while (current.activeChildId !== null) {
    const child = index.nodesById.get(current.activeChildId) ?? null;
    if (child === null || child.parentId !== current.id || !isLineNode(child)) break;
    path.push(child);
    current = child;
  }
  return path;
}

export function activeLeafId<Node extends TreeNode>(state: TreeSource<Node>): string | null {
  return activePath(state).at(-1)?.id ?? null;
}

export function activeLeaf<Node extends TreeNode>(state: TreeSource<Node>): Node | null {
  return activePath(state).at(-1) ?? null;
}

export function pathTo<Node extends TreeNode>(state: TreeSource<Node>, nodeId: string): Node[] {
  const index = isTreeIndex(state) ? state : indexTree(state);
  const node = index.nodesById.get(nodeId) ?? null;
  if (node === null) throw new Error(`Unknown node: ${nodeId}`);

  const path = [node];
  let current = node;
  while (current.parentId !== null) {
    const parent = index.nodesById.get(current.parentId) ?? null;
    if (parent === null) throw new Error(`Unknown node: ${current.parentId}`);
    path.push(parent);
    current = parent;
  }
  return path.reverse();
}

export function takeIndex<Node extends TreeNode>(state: TreeSource<Node>, nodeId: string): { index: number; count: number } {
  const index = isTreeIndex(state) ? state : indexTree(state);
  const position = index.siblingPositionByNodeId.get(nodeId);
  if (position === undefined) throw new Error(`Unknown node: ${nodeId}`);
  return position;
}

export function subtreeIds<Node extends TreeNode>(state: TreeSource<Node>, nodeId: string): string[] {
  const index = isTreeIndex(state) ? state : indexTree(state);
  if (!index.nodesById.has(nodeId)) return [];
  const ids = new Set<string>();
  const pending = [nodeId];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    for (const child of index.childrenByParentId.get(id) ?? []) pending.push(child.id);
  }
  return index.nodes.filter((node) => ids.has(node.id)).map((node) => node.id);
}

export function subtreeCount<Node extends TreeNode>(state: TreeSource<Node>, nodeId: string): number {
  return subtreeIds(state, nodeId).length;
}

/** Select abandoned leaf takes while preserving structural and authored intent.
 * Continued takes and every node on a bookmarked line survive. A sibling group
 * keeps its sole leaf; when several unnamed leaves remain, the remembered leaf
 * (or, for an inactive group, the newest document-order leaf) survives. */
export function unusedTakePruneSelection<Node extends TreeNode>(
  state: NamedLineState<Node>
): UnusedTakePruneSelection {
  const index = indexTree(state);
  const namedLineIds = new Set<string>();
  for (const bookmark of state.bookmarks) {
    let node = index.nodesById.get(bookmark.nodeId);
    while (node !== undefined && !namedLineIds.has(node.id)) {
      namedLineIds.add(node.id);
      node = node.parentId === null ? undefined : index.nodesById.get(node.parentId);
    }
  }

  const selected = new Set<string>();
  const parentIds = new Set(state.nodes.filter(isLineNode).map((node) => node.parentId));
  for (const parentId of parentIds) {
    const siblings = childrenOf(index, parentId);
    if (siblings.length <= 1) continue;
    const leaves = siblings.filter((node) => childrenOf(index, node.id).length === 0);
    if (leaves.length <= 1) continue;

    const rememberedId = parentId === null
      ? state.activeRootId
      : index.nodesById.get(parentId)?.activeChildId ?? null;
    const survivors = new Set(leaves
      .filter((node) => namedLineIds.has(node.id) || node.id === rememberedId)
      .map((node) => node.id));
    if (survivors.size === 0) survivors.add(leaves.at(-1)!.id);
    for (const leaf of leaves) if (!survivors.has(leaf.id)) selected.add(leaf.id);
  }

  const takeIds = state.nodes.filter((node) => selected.has(node.id)).map((node) => node.id);
  const dead = new Set<string>();
  const pending = [...takeIds];
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    if (dead.has(nodeId)) continue;
    dead.add(nodeId);
    for (const child of index.childrenByParentId.get(nodeId) ?? []) pending.push(child.id);
  }
  return {
    takeIds,
    nodeIds: state.nodes.filter((node) => dead.has(node.id)).map((node) => node.id)
  };
}

export function hasFork<Node extends TreeNode>(state: TreeState<Node>): boolean {
  const counts = new Map<string | null, number>();
  for (const node of state.nodes) {
    if (!isLineNode(node)) continue;
    const count = (counts.get(node.parentId) ?? 0) + 1;
    if (count > 1) return true;
    counts.set(node.parentId, count);
  }
  return false;
}

export function leafCount<Node extends TreeNode>(state: TreeState<Node>): number {
  const lineNodes = state.nodes.filter(isLineNode);
  const parents = new Set(lineNodes.flatMap((node) => node.parentId === null ? [] : [node.parentId]));
  return lineNodes.reduce((sum, node) => sum + (parents.has(node.id) ? 0 : 1), 0);
}

export function computeRollups(
  state: TreeState<StoryNode>
): Map<string, { childCount: number; leafCount: number; lastTouched: string }> {
  const rollups = new Map<string, { childCount: number; leafCount: number; lastTouched: string }>();

  // Reverse document order guarantees every child's rollup is complete first.
  for (let index = state.nodes.length - 1; index >= 0; index -= 1) {
    const node = state.nodes[index]!;
    const touched = node.updatedAt ?? node.createdAt;
    const lineNode = isLineNode(node);
    const rollup = rollups.get(node.id) ?? { childCount: 0, leafCount: 0, lastTouched: touched };
    if (touched > rollup.lastTouched) rollup.lastTouched = touched;
    if (lineNode && rollup.childCount === 0) rollup.leafCount = 1;
    rollups.set(node.id, rollup);

    if (lineNode && node.parentId !== null) {
      const parent = rollups.get(node.parentId) ?? {
        childCount: 0,
        leafCount: 0,
        lastTouched: rollup.lastTouched
      };
      parent.childCount += 1;
      parent.leafCount += rollup.leafCount;
      if (rollup.lastTouched > parent.lastTouched) parent.lastTouched = rollup.lastTouched;
      rollups.set(node.parentId, parent);
    }
  }
  return rollups;
}

export function contextSlice(path: StoryNode[]): StoryNode[] {
  const summaryIndex = path.findLastIndex((node) => node.role === "summary");
  return path.slice(summaryIndex === -1 ? 0 : summaryIndex);
}

export function switchToNode<Node extends TreeNode>(
  state: LineState<Node>,
  nodeId: string,
  options: { stopAtNode?: boolean } = {}
): void {
  const target = nodeById(state, nodeId);
  if (target === null || !isLineNode(target)) throw new Error(`Unknown node: ${nodeId}`);
  const previousLeafId = activeLeafId(state);
  const path = pathTo(state, nodeId);

  state.activeRootId = path[0]!.id;
  for (let index = 0; index < path.length - 1; index += 1) {
    path[index]!.activeChildId = path[index + 1]!.id;
  }
  if (options.stopAtNode === true) path.at(-1)!.activeChildId = null;

  const nextLeafId = activeLeafId(state);
  if (previousLeafId !== nextLeafId) recordRecentLeaf(state, previousLeafId);
}

export function recordRecentLeaf<Node extends TreeNode>(state: LineState<Node>, previousLeafId: string | null): void {
  if (previousLeafId === null) return;
  for (let index = state.recentNodeIds.length - 1; index >= 0; index -= 1) {
    if (state.recentNodeIds[index] === previousLeafId) state.recentNodeIds.splice(index, 1);
  }
  state.recentNodeIds.unshift(previousLeafId);
  state.recentNodeIds.splice(MAX_RECENT_LINES);
}

function isTreeIndex<Node extends TreeNode>(state: TreeSource<Node>): state is TreeIndex<Node> {
  return "nodesById" in state;
}

export function isChapterSummary<Node extends { chapterBreakId?: string }>(
  node: Node
): node is Node & { chapterBreakId: string } {
  return node.chapterBreakId !== undefined;
}

function isLineNode<Node extends TreeNode>(node: Node): boolean {
  return !isChapterSummary(node);
}

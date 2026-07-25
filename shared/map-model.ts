import { isChapterSummary, type TreeIndex } from "./story-tree.js";
import type { Bookmark, NodeStub, StoryPayload } from "./types.js";

export interface MapLineClassification {
  /** Lone, uncontinued takes folded by every MAP view. */
  mapSketchNodeIds: ReadonlySet<string>;
  /** Logical line totals after sketches are folded, cached per subtree. */
  mapLineCountByNodeId: ReadonlyMap<string, number>;
  mapLineCount: number;
}

/** One line/sketch definition for path, tree, and mass. */
export function classifyMapLines(
  payload: StoryPayload,
  tree: TreeIndex<NodeStub>,
  bookmarkByNodeId: ReadonlyMap<string, Bookmark>,
  bookmarkBelowByNodeId: ReadonlyMap<string, Bookmark>
): MapLineClassification {
  const activeIds = new Set(payload.path.map((node) => node.id));
  const activeLeafId = payload.path.at(-1)?.id ?? null;
  const mapSketchNodeIds = new Set<string>();
  for (const node of payload.nodes) {
    if (isChapterSummary(node) || node.childCount !== 0 || activeIds.has(node.id)
      || bookmarkByNodeId.has(node.id) || bookmarkBelowByNodeId.has(node.id)) continue;
    const parent = node.parentId === null ? null : tree.nodesById.get(node.parentId) ?? null;
    // A continued branch's final leaf is still part of that line. A bare leaf
    // becomes a sketch only where a line can begin: a root fork, a real fork,
    // or directly below the current endpoint after the reader stopped there.
    if (node.parentId === null || parent?.childCount !== 1 || parent.id === activeLeafId) {
      mapSketchNodeIds.add(node.id);
    }
  }

  const mapLineCountByNodeId = new Map<string, number>();
  for (let offset = payload.nodes.length - 1; offset >= 0; offset -= 1) {
    const node = payload.nodes[offset]!;
    if (isChapterSummary(node)) continue;
    if (mapSketchNodeIds.has(node.id)) {
      mapLineCountByNodeId.set(node.id, 0);
      continue;
    }
    const continuedLines = (tree.childrenByParentId.get(node.id) ?? [])
      .reduce((sum, child) => sum + (mapLineCountByNodeId.get(child.id) ?? 0), 0);
    // If every outgoing take is a sketch, the incoming continued line ends here.
    mapLineCountByNodeId.set(node.id, Math.max(1, continuedLines));
  }
  const mapLineCount = (tree.childrenByParentId.get(null) ?? [])
    .reduce((sum, root) => sum + (mapLineCountByNodeId.get(root.id) ?? 0), 0);
  return { mapSketchNodeIds, mapLineCountByNodeId, mapLineCount };
}

export function isMapSketch(
  node: NodeStub,
  classification: Pick<MapLineClassification, "mapSketchNodeIds">
): boolean {
  return classification.mapSketchNodeIds.has(node.id);
}

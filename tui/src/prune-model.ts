import { createLoomIndex } from "../../shared/loom-model.js";
import { subtreeIds, takeIndex, unusedTakePruneSelection } from "../../shared/story-tree.js";
import type { Bookmark, StoryPayload } from "../../shared/types.js";
import { bookmarkGlyph } from "./bookmark-presentation.js";

export interface SubtreePrunePlan {
  kind: "subtree";
  nodeId: string;
  part: number;
  take: number;
  takeCount: number;
  parts: number;
  lines: number;
  bookmarks: Array<Pick<Bookmark, "name" | "label">>;
}

export interface UnusedTakesPrunePlan {
  kind: "unused-takes";
  storyRevision: string;
  takes: number;
  parts: number;
}

export type PrunePlan = SubtreePrunePlan | UnusedTakesPrunePlan;

export function createPrunePlan(payload: StoryPayload, nodeId: string): SubtreePrunePlan | null {
  const index = createLoomIndex(payload);
  const node = index.tree.nodesById.get(nodeId);
  if (node === undefined) return null;
  const ids = new Set(subtreeIds(index.tree, nodeId));
  const position = takeIndex(index.tree, nodeId);
  return {
    kind: "subtree",
    nodeId,
    part: index.depthByNodeId.get(nodeId) ?? 1,
    take: position.index,
    takeCount: position.count,
    parts: index.subtreeCountByNodeId.get(nodeId) ?? ids.size,
    lines: node.leafCount,
    bookmarks: payload.bookmarks
      .filter((bookmark) => ids.has(bookmark.nodeId))
      .map(({ name, label }) => ({ name, label }))
  };
}

export function createUnusedTakesPrunePlan(payload: StoryPayload): UnusedTakesPrunePlan | null {
  const selection = unusedTakePruneSelection(payload);
  if (selection.takeIds.length === 0) return null;
  return {
    kind: "unused-takes",
    storyRevision: payload.updatedAt,
    takes: selection.takeIds.length,
    parts: selection.nodeIds.length
  };
}

export function pruneConfirmText(plan: PrunePlan): string {
  if (plan.kind === "unused-takes") {
    const takeWord = plan.takes === 1 ? "take" : "takes";
    const partWord = plan.parts === 1 ? "part" : "parts";
    return `${plan.takes} unused ${takeWord} → ${plan.parts} ${partWord} die · keeps continuations, named lines + one leaf/fork · d confirms · esc keeps`;
  }
  const bookmarks = plan.bookmarks.length === 0
    ? ""
    : `${plan.bookmarks.map((bookmark) => `${bookmarkGlyph(bookmark.label)} ${bookmark.name}`).join(", ")} · `;
  const partWord = plan.parts === 1 ? "part" : "parts";
  const lineWord = plan.lines === 1 ? "line" : "lines";
  return `${bookmarks}¶ ${plan.part} take ${plan.take}/${plan.takeCount} → ${plan.parts} ${partWord} on ${plan.lines} ${lineWord} die · d confirms · esc keeps`;
}

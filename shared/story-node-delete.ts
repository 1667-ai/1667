import {
  childrenOf, indexTree, isChapterSummary, nodeById, subtreeIds,
  unusedTakePruneSelection
} from "./story-tree.js";
import type { PruneUnusedTakesRequest, Story, StoryNode } from "./types.js";
import { canonicalFactStates } from "./fact-state.js";
import { reanchorPrunedAsideSessions } from "./aside-session-store.js";
import { ServiceError as HttpError } from "../server/errors.js";

export function requireNode(story: Story, nodeId: string): StoryNode {
  const node = nodeById(story, nodeId);
  if (node === null) throw new HttpError(404, `Node not found: ${nodeId}`);
  return node;
}

export function deleteSubtree(story: Story, nodeId: string, expectedSubtreeCount: number): number {
  requireNode(story, nodeId);
  if (!Number.isSafeInteger(expectedSubtreeCount) || expectedSubtreeCount < 1) {
    throw new HttpError(400, "expectedSubtreeCount must be a positive integer");
  }
  const deadIds = new Set(subtreeIds(story, nodeId));
  if (deadIds.size !== expectedSubtreeCount) {
    throw new HttpError(409, "The subtree changed before deletion — reload the story.");
  }
  return deleteNodeSet(story, deadIds);
}

export function pruneUnusedTakes(story: Story, expected: PruneUnusedTakesRequest): number {
  if (story.updatedAt !== expected.expectedStoryRevision) {
    throw new HttpError(409, "The story changed after the prune preview — reload it and review again.");
  }
  const selection = unusedTakePruneSelection(story);
  if (selection.takeIds.length !== expected.expectedTakeCount
    || selection.nodeIds.length !== expected.expectedPartCount) {
    throw new HttpError(409, "The prune selection changed — reload the story and review it again.");
  }
  deleteNodeSet(story, new Set(selection.nodeIds));
  return selection.takeIds.length;
}

/** Count anchored states in a deletion set before applying it. Used only for
 * the deletion receipt; it does not change the tree or Fact collection. */
export function countFactStatesAnchoredTo(story: Story, nodeIds: ReadonlySet<string>): number {
  return story.facts.reduce((total, fact) => total + canonicalFactStates(fact)
    .filter((state) => state.anchorPartId !== undefined && nodeIds.has(state.anchorPartId)).length, 0);
}

function deleteNodeSet(story: Story, deadIds: Set<string>): number {
  const removedBreakIds = new Set(story.chapterBreaks
    .filter((chapterBreak) => deadIds.has(chapterBreak.parentPartId))
    .map((chapterBreak) => chapterBreak.id));
  for (const candidate of story.nodes) {
    if (isChapterSummary(candidate) && removedBreakIds.has(candidate.chapterBreakId)) deadIds.add(candidate.id);
  }

  const tree = indexTree(story);
  const survivingSibling = (parentId: string | null, removedId: string): StoryNode | null => {
    const siblings = childrenOf(tree, parentId);
    const offset = siblings.findIndex((candidate) => candidate.id === removedId);
    const before = offset < 0 ? [] : siblings.slice(0, offset);
    const after = offset < 0 ? siblings : siblings.slice(offset + 1);
    return after.find((candidate) => !deadIds.has(candidate.id))
      ?? before.findLast((candidate) => !deadIds.has(candidate.id))
      ?? null;
  };
  if (story.activeRootId !== null && deadIds.has(story.activeRootId)) {
    story.activeRootId = survivingSibling(null, story.activeRootId)?.id ?? null;
  }
  for (const parent of story.nodes) {
    if (deadIds.has(parent.id) || parent.activeChildId === null || !deadIds.has(parent.activeChildId)) continue;
    parent.activeChildId = survivingSibling(parent.id, parent.activeChildId)?.id ?? null;
  }

  story.nodes = story.nodes.filter((candidate) => !deadIds.has(candidate.id));
  story.tags = story.tags.filter((tag) => !deadIds.has(tag.nodeId));
  story.recentNodeIds = story.recentNodeIds.filter((recentId) => !deadIds.has(recentId));
  story.chapterBreaks = story.chapterBreaks.filter((chapterBreak) => !removedBreakIds.has(chapterBreak.id));
  const now = new Date().toISOString();
  let factStatesRemoved = 0;
  story.facts = story.facts.flatMap((fact) => {
    const states = canonicalFactStates(fact);
    const survivingStates = states.filter(
      (state) => state.anchorPartId === undefined || !deadIds.has(state.anchorPartId)
    );
    factStatesRemoved += states.length - survivingStates.length;
    if (survivingStates.length === 0 && states.length > 0) return [];
    if (survivingStates.length !== states.length) {
      fact.states = survivingStates;
      fact.updatedAt = now;
    }
    if (fact.sourcePartId !== undefined && deadIds.has(fact.sourcePartId)) delete fact.sourcePartId;
    return [fact];
  });
  reanchorPrunedAsideSessions(story);
  return factStatesRemoved;
}


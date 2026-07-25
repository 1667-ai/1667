import type { ChapterBreak, Story, StoryNode } from "../shared/types.js";
import { ProviderError } from "./errors.js";

/**
 * A generation reads the story, then streams for as long as the provider takes.
 * ADR 006 lets the writer keep editing throughout, so the state the generation
 * read is not the state it commits onto.
 *
 * Rather than write back the story it read, which would silently discard
 * everything typed while the model was streaming, a generation contributes a
 * delta: the nodes it added and the node it rewrote. Committing replays that
 * delta onto whatever is current.
 *
 * Where the two genuinely conflict, the generation loses. Text a person typed
 * is worth more than text a model produced, and the model's can be regenerated.
 */

export interface StoryBaseline {
  readonly nodeText: ReadonlyMap<string, string>;
  readonly activeChildId: ReadonlyMap<string, string | null>;
  readonly activeRootId: string | null;
  readonly chapterBreakIds: ReadonlySet<string>;
}

export interface StoryDelta {
  readonly addedNodes: readonly StoryNode[];
  readonly rewrittenNodes: readonly RewrittenNode[];
  readonly relinkedNodes: readonly RelinkedNode[];
  readonly addedChapterBreaks: readonly ChapterBreak[];
  readonly removedChapterBreakIds: readonly string[];
  readonly baseActiveRootId: string | null;
  readonly activeRootId: string | null;
}

/** Which child a generation put on the line, and what it displaced. */
export interface RelinkedNode {
  readonly id: string;
  readonly baseActiveChildId: string | null;
  readonly activeChildId: string | null;
}

export interface RewrittenNode {
  readonly node: StoryNode;
  /** Text the generation read, used to detect a concurrent edit of the same node. */
  readonly baseText: string;
}

/** Taken before provider bytes, against the story the generation read. */
export function captureStoryBaseline(story: Story): StoryBaseline {
  return {
    nodeText: new Map(story.nodes.map((node) => [node.id, node.text])),
    activeChildId: new Map(story.nodes.map((node) => [node.id, node.activeChildId])),
    activeRootId: story.activeRootId,
    chapterBreakIds: new Set(story.chapterBreaks.map((brk) => brk.id))
  };
}

/** What the generation did, expressed independently of what it read. */
export function deriveStoryDelta(
  baseline: StoryBaseline,
  draft: Story
): StoryDelta {
  const addedNodes: StoryNode[] = [];
  const rewrittenNodes: RewrittenNode[] = [];
  const relinkedNodes: RelinkedNode[] = [];
  for (const node of draft.nodes) {
    const baseText = baseline.nodeText.get(node.id);
    if (baseText === undefined) {
      addedNodes.push(node);
      continue;
    }
    if (baseText !== node.text) rewrittenNodes.push({ node, baseText });
    const baseActiveChildId = baseline.activeChildId.get(node.id) ?? null;
    if (baseActiveChildId !== node.activeChildId) {
      relinkedNodes.push({
        id: node.id,
        baseActiveChildId,
        activeChildId: node.activeChildId
      });
    }
  }
  return {
    addedNodes,
    rewrittenNodes,
    relinkedNodes,
    addedChapterBreaks: draft.chapterBreaks.filter(
      (brk) => !baseline.chapterBreakIds.has(brk.id)
    ),
    removedChapterBreakIds: [...baseline.chapterBreakIds].filter(
      (id) => !draft.chapterBreaks.some((brk) => brk.id === id)
    ),
    baseActiveRootId: baseline.activeRootId,
    activeRootId: draft.activeRootId
  };
}

/**
 * Replay a generation onto the current story. Returns the story to commit.
 *
 * `current` is authoritative for everything the generation did not touch, so a
 * concurrent edit survives by construction rather than by merge rule.
 */
export function rebaseStoryDelta(current: Story, delta: StoryDelta): Story {
  const byId = new Map(current.nodes.map((node) => [node.id, node]));

  for (const { node, baseText } of delta.rewrittenNodes) {
    const live = byId.get(node.id);
    if (live === undefined) {
      throw new ProviderError(
        `The part this generation rewrote was removed while the model was still writing (${node.id}).`
      );
    }
    if (live.text !== baseText) {
      throw new ProviderError(
        `The part this generation rewrote was edited while the model was still writing (${node.id}).`
      );
    }
  }

  // Anchors first: a generation that lands under a removed parent would attach
  // an unreachable subtree rather than fail, and the writer would never see it.
  const arriving = new Set(delta.addedNodes.map((node) => node.id));
  for (const node of delta.addedNodes) {
    if (node.parentId === null) continue;
    if (byId.has(node.parentId) || arriving.has(node.parentId)) continue;
    throw new ProviderError(
      `The part this generation continued from was removed while the model was still writing (${node.parentId}).`
    );
  }

  const nodes = current.nodes.map((node) => {
    const rewritten = delta.rewrittenNodes.find(
      (candidate) => candidate.node.id === node.id
    );
    const relinked = delta.relinkedNodes.find((candidate) => candidate.id === node.id);
    if (rewritten === undefined && relinked === undefined) return node;
    // Field by field, never a whole-node swap: the draft node carries the
    // links the generation read, and writing those back would undo wherever
    // the writer has moved the line since.
    const merged: StoryNode = { ...node };
    if (rewritten !== undefined) {
      // The fields a generation owns on a part it wrote into. Structure and
      // navigation stay with the current story: id, parentId and activeChildId
      // belong to the writer, and only text and its provenance to the model.
      merged.text = rewritten.node.text;
      merged.updatedAt = rewritten.node.updatedAt;
      merged.attribution = rewritten.node.attribution;
      merged.genId = rewritten.node.genId;
      merged.model = rewritten.node.model;
      merged.instruction = rewritten.node.instruction;
      merged.role = rewritten.node.role;
      merged.chapterBreakId = rewritten.node.chapterBreakId;
      merged.coveredExtent = rewritten.node.coveredExtent;
      merged.madeAt = rewritten.node.madeAt;
      merged.editedByUser = rewritten.node.editedByUser;
    }
    // The writer's navigation wins: adopt the generation's link only where the
    // writer has not moved it themselves.
    if (relinked !== undefined && node.activeChildId === relinked.baseActiveChildId) {
      merged.activeChildId = relinked.activeChildId;
    }
    return merged;
  });
  nodes.push(...delta.addedNodes);

  // A generation can retire a break as well as create one, so the removal has
  // to replay too or the break the writer saw disappear comes back.
  const removed = new Set(delta.removedChapterBreakIds);
  const kept = current.chapterBreaks.filter((brk) => !removed.has(brk.id));
  const keptIds = new Set(kept.map((brk) => brk.id));
  const chapterBreaks = [
    ...kept,
    ...delta.addedChapterBreaks.filter((brk) => !keptIds.has(brk.id))
  ];

  // Same rule as the per-node link: a regenerated root has to become active or
  // the writer never sees it, but if they rooted the story elsewhere while the
  // model was writing, that choice stands.
  const rootIds = new Set(nodes.filter((node) => node.parentId === null).map((node) => node.id));
  const writerMovedRoot = current.activeRootId !== delta.baseActiveRootId;
  const activeRootId = !writerMovedRoot
    && delta.activeRootId !== null
    && rootIds.has(delta.activeRootId)
    ? delta.activeRootId
    : current.activeRootId;

  return { ...current, nodes, chapterBreaks, activeRootId };
}

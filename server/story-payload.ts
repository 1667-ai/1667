import { activePath, computeRollups } from "../shared/story-tree.js";
import type { NodeStub, Story, StoryPayload } from "../shared/types.js";
import type { StoryAggregateVersion } from "../shared/story-aggregate-version.js";
import { nodeStubPreview, nodeStubTokens, nodeStubWords } from "./story-node-text.js";

export function buildStoryPayload(
  story: Story,
  aggregateVersion?: StoryAggregateVersion
): StoryPayload {
  const rollups = computeRollups(story);
  return {
    id: story.id,
    title: story.title,
    createdAt: story.createdAt,
    updatedAt: story.updatedAt,
    ...(story.origin === undefined ? {} : { origin: { ...story.origin } }),
    ...(story.firstChapterTitle === undefined || story.firstChapterTitle === ""
      ? {}
      : { firstChapterTitle: story.firstChapterTitle }),
    nodes: story.nodes.map((node): NodeStub => {
      const rollup = rollups.get(node.id);
      if (rollup === undefined) throw new Error(`Missing rollup for node: ${node.id}`);
      const base = {
        id: node.id,
        parentId: node.parentId,
        preview: nodeStubPreview(node),
        words: nodeStubWords(node),
        tokens: nodeStubTokens(node),
        childCount: rollup.childCount,
        leafCount: rollup.leafCount,
        lastTouched: rollup.lastTouched,
        ...(node.updatedAt === undefined ? {} : { updatedAt: node.updatedAt }),
        ...(node.human === undefined ? {} : { human: node.human }),
        hasInstruction: node.instruction.trim().length > 0,
        activeChildId: node.activeChildId
      };
      if (node.chapterBreakId !== undefined) return {
        ...base,
        role: "summary",
        text: node.text,
        instruction: node.instruction,
        chapterBreakId: node.chapterBreakId,
        coveredExtent: node.coveredExtent === undefined ? undefined : { ...node.coveredExtent },
        madeAt: node.madeAt,
        ...(node.editedByUser === undefined ? {} : { editedByUser: node.editedByUser })
      };
      return { ...base, ...(node.role === undefined ? {} : { role: node.role }) };
    }),
    // Shallow copies keep handlers from mutating store state through the
    // response; structuredClone here cost ~29ms on 20k-part paths.
    path: activePath(story).map((node) => ({
      ...node,
      ...(node.attribution == null ? {} : {
        attribution: { ...node.attribution, ranges: node.attribution.ranges.map((range) => ({ ...range })) }
      })
    })),
    activeRootId: story.activeRootId,
    tags: story.tags.map((tag) => ({ ...tag })),
    recentNodeIds: [...story.recentNodeIds],
    facts: story.facts.map((fact) => ({ ...fact })),
    chapterBreaks: story.chapterBreaks.map((chapterBreak) => ({ ...chapterBreak })),
    ...(aggregateVersion === undefined ? {} : {
      aggregateVersion: structuredClone(aggregateVersion)
    })
  };
}

import { activePath, computeRollups } from "../shared/story-tree.js";
import type { NodeStub, Story, StoryPathNode, StoryPayload } from "../shared/types.js";
import { MAX_AUTHORS_NOTE_CHARS, storedAuthorsNoteDepth } from "../shared/authors-note.js";
import { MAX_AUTHOR_BRIEF_CHARS, storedAuthorBrief } from "../shared/author-brief.js";
import { humanEditIsMeaningful } from "../shared/human-edit.js";
import type { StoryAggregateVersion } from "../shared/story-aggregate-version.js";
import { nodeStubPreview, nodeStubTokens, nodeStubWords } from "./story-node-text.js";
import { boundedString } from "./story-wire-validation.js";

export function buildStoryPayload(
  story: Story,
  aggregateVersion?: StoryAggregateVersion
): StoryPayload {
  const rollups = computeRollups(story);
  const authorsNote = story.authorsNote === undefined || story.authorsNote === ""
    ? undefined
    : boundedString(story.authorsNote, "story.authorsNote", MAX_AUTHORS_NOTE_CHARS);
  const authorsNoteDepth = storedAuthorsNoteDepth(authorsNote, story.authorsNoteDepth);
  const canonicalBrief = storedAuthorBrief(story.authorBrief);
  const authorBrief = canonicalBrief === undefined
    ? undefined
    : boundedString(canonicalBrief, "story.authorBrief", MAX_AUTHOR_BRIEF_CHARS);
  return {
    id: story.id,
    title: story.title,
    createdAt: story.createdAt,
    updatedAt: story.updatedAt,
    ...(story.origin === undefined ? {} : { origin: { ...story.origin } }),
    ...(authorsNote === undefined ? {} : { authorsNote }),
    ...(authorsNoteDepth === undefined ? {} : { authorsNoteDepth }),
    ...(authorBrief === undefined ? {} : { authorBrief }),
    ...(story.phraseBias === undefined || story.phraseBias.length === 0
      ? {}
      : { phraseBias: story.phraseBias.map((entry) => ({ ...entry })) }),
    ...(story.bannedStrings === undefined || story.bannedStrings.length === 0
      ? {}
      : { bannedStrings: [...story.bannedStrings] }),
    ...(story.firstChapterTitle === undefined || story.firstChapterTitle === ""
      ? {}
      : { firstChapterTitle: story.firstChapterTitle }),
    ...(story.factsBudgetTokens === undefined ? {} : { factsBudgetTokens: story.factsBudgetTokens }),
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
        ...(node.tokenProbabilities === undefined ? {} : { tokenProbabilities: node.tokenProbabilities }),
        ...(node.generationRecordIds === undefined || node.generationRecordIds.length === 0
          ? {}
          : { generationRecordCount: node.generationRecordIds.length }),
        ...(node.reasoning === undefined ? {} : { reasoning: node.reasoning }),
        ...(humanEditIsMeaningful(node.attribution) ? { editedByUser: true as const } : {}),
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
    path: activePath(story).map((node): StoryPathNode => {
      // A path node is prose the reader already has; its Generation Record
      // history is fetched on demand (see GenerationRecordSummary and
      // loadGenerationRecordSummaries), so the ordered id list itself never
      // needs to travel with the story — only a count, same as NodeStub.
      const { generationRecordIds, ...rest } = node;
      return {
        ...rest,
        ...(generationRecordIds === undefined || generationRecordIds.length === 0
          ? {}
          : { generationRecordCount: generationRecordIds.length }),
        ...(node.attribution == null ? {} : {
          attribution: { ...node.attribution, ranges: node.attribution.ranges.map((range) => ({ ...range })) }
        }),
        ...(node.rewrittenSpans === undefined ? {} : {
          rewrittenSpans: node.rewrittenSpans.map((range) => ({ ...range }))
        })
      };
    }),
    activeRootId: story.activeRootId,
    tags: story.tags.map((tag) => ({ ...tag })),
    recentNodeIds: [...story.recentNodeIds],
    facts: story.facts.map((fact) => ({ ...fact, keys: [...fact.keys] })),
    chapterBreaks: story.chapterBreaks.map((chapterBreak) => ({ ...chapterBreak })),
    ...(aggregateVersion === undefined ? {} : {
      aggregateVersion: structuredClone(aggregateVersion)
    })
  };
}

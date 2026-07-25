import { deriveChapters, summaryNodeInstruction, SUMMARY_TARGET_TOKENS, type DerivedChapter } from "../shared/chapters.js";
import { activePath } from "../shared/story-tree.js";
import type { Story, StoryNode } from "../shared/types.js";
import { GenerationResultError, ServiceError as HttpError } from "./errors.js";
import type { BindGenerationIntent } from "./generation-http.js";
import { throwIfUncertainAbort } from "./generation-stream.js";
import { sha256 } from "./story-format.js";
import { createTake, newNode } from "./story-nodes.js";
import { setNodeRewriteId } from "./story-node-text.js";
import type { SettingsStore } from "./settings.js";
import type { ProviderStoryRuntime } from "./story-mutation-runtime.js";
import { generateSummaryText } from "./summary-take.js";
import {
  createPromptCacheRequest,
  type PromptCacheRuntime
} from "./provider-cache-policy.js";

interface ChapterSummaryOptions {
  providerStarted?: () => void | Promise<void>;
  bindIntent?: BindGenerationIntent;
  summaryNodeId?: string;
  rewriteId?: string;
}

export async function summarizeChapter(
  id: string,
  breakId: string,
  stories: ProviderStoryRuntime,
  settingsStore: SettingsStore,
  promptCacheRuntime: PromptCacheRuntime,
  signal: AbortSignal,
  options: ChapterSummaryOptions = {}
): Promise<Story> {
  const snapshot = await stories.loadForMutation(id);
  const chapter = closedChapter(snapshot, breakId);
  const fingerprint = chapterFingerprint(snapshot, chapter);
  const { settings, promptCache } = await settingsStore.loadGeneration("utility");
  await options.bindIntent?.(settings, { kind: "chapter-summary", storyId: id, breakId, fingerprint });
  const summary = await generateSummaryText(settings, snapshot.title, chapter.parts, signal, {
    maxOutputTokens: SUMMARY_TARGET_TOKENS,
    providerStarted: options.providerStarted,
    promptCache: createPromptCacheRequest(
      promptCacheRuntime,
      promptCache,
      id,
      "summary"
    )
  });
  if (signal.aborted) {
    throwIfUncertainAbort(signal);
    throw new GenerationResultError(409, "Chapter summarization was cancelled");
  }
  const model = settings.provider === "dry-run" ? "dry-run" : settings.model;
  return await stories.withLock(id, async () => {
    const story = await stories.loadForMutation(id);
    let freshChapter: DerivedChapter<StoryNode>;
    try {
      freshChapter = closedChapter(story, breakId);
    } catch (error) {
      if (error instanceof HttpError) throw new GenerationResultError(error.status, error.message);
      throw error;
    }
    if (chapterFingerprint(story, freshChapter) !== fingerprint) {
      throw new GenerationResultError(409, "The chapter changed while its summary was being written. Try again.");
    }
    const extent = freshChapter.extent!;
    const madeAt = new Date().toISOString();
    const instruction = summaryNodeInstruction(story.title);
    if (freshChapter.summary === null) {
      const node = newNode(extent.toPartId, instruction, summary, model, {
        id: options.summaryNodeId,
        role: "summary",
        chapterBreakId: breakId,
        coveredExtent: { ...extent },
        madeAt
      });
      setNodeRewriteId(node, options.rewriteId);
      createTake(story, node, { activate: false });
    } else {
      freshChapter.summary.text = summary;
      setNodeRewriteId(freshChapter.summary, options.rewriteId);
      freshChapter.summary.instruction = instruction;
      freshChapter.summary.model = model;
      freshChapter.summary.updatedAt = madeAt;
      freshChapter.summary.madeAt = madeAt;
      freshChapter.summary.coveredExtent = { ...extent };
      delete freshChapter.summary.editedByUser;
      delete freshChapter.summary.attribution;
    }
    await stories.save(story);
    return story;
  });
}

function closedChapter(story: Story, breakId: string): DerivedChapter<StoryNode> {
  const line = activePath(story);
  const chapter = deriveChapters(line, story.chapterBreaks, story.nodes)
    .find((candidate) => candidate.closedBy?.id === breakId);
  if (chapter === undefined) throw new HttpError(409, "The chapter break is not on the active storyline");
  if (chapter.closedBy === null || chapter.extent === null) {
    throw new HttpError(409, "The current chapter cannot be summarized");
  }
  return chapter;
}

function chapterFingerprint(story: Story, chapter: DerivedChapter<StoryNode>): string {
  return sha256(JSON.stringify({
    title: story.title,
    breakId: chapter.closedBy?.id,
    extent: chapter.extent,
    summary: chapter.summary === null ? null : {
      id: chapter.summary.id,
      text: chapter.summary.text,
      madeAt: chapter.summary.madeAt,
      editedByUser: chapter.summary.editedByUser
    },
    parts: chapter.parts.map((part) => ({
      id: part.id,
      text: part.text,
      instruction: part.instruction,
      updatedAt: part.updatedAt
    }))
  }));
}

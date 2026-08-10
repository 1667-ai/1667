import { SUMMARY_TARGET_TOKENS } from "../shared/chapters.js";
import type { Story } from "../shared/types.js";
import {
  GenerationResultError,
  GenerationStoppedError,
  ServiceError
} from "./errors.js";
import type { BindGenerationIntent } from "./generation-http.js";
import type { SettingsStore } from "./settings.js";
import type { ProviderStoryRuntime } from "./story-mutation-runtime.js";
import {
  chapterSourceFingerprint,
  chapterSummarySource
} from "./story-provider-effect.js";
import { generateSummaryText } from "./summary-take.js";
import {
  createPromptCacheRequest,
  type PromptCacheRuntime
} from "./provider-cache-policy.js";
import { promptEntriesInline } from "./generation-record-prompt.js";
import { finalizeGenerationRecord } from "./generation-record-finalize.js";

interface ChapterSummaryOptions {
  providerStarted?: () => void | Promise<void>;
  bindIntent?: BindGenerationIntent;
  summaryNodeId?: string;
  rewriteId?: string;
}

export async function summarizeChapter(
  id: string,
  breakId: string,
  stories: ProviderStoryRuntime<"summarizeChapter">,
  settingsStore: SettingsStore,
  promptCacheRuntime: PromptCacheRuntime,
  signal: AbortSignal,
  options: ChapterSummaryOptions = {}
): Promise<Story> {
  const snapshot = await stories.loadForMutation(id);
  const chapter = chapterSummarySource(snapshot, breakId);
  const fingerprint = chapterSourceFingerprint(snapshot, breakId);
  const { settings, promptCache } = await settingsStore.loadGeneration("utility");
  await options.bindIntent?.(settings, { kind: "chapter-summary", storyId: id, breakId, fingerprint });
  const { summary, generationRecordCollector, prompt } = await generateSummaryText(
    settings,
    snapshot.title,
    chapter.parts,
    signal,
    {
      maxOutputTokens: SUMMARY_TARGET_TOKENS,
      providerStarted: options.providerStarted,
      promptCache: createPromptCacheRequest(
        promptCacheRuntime,
        promptCache,
        id,
        "summary"
      )
    }
  );
  if (signal.aborted) {
    throw new GenerationStoppedError("Chapter summarization was cancelled");
  }
  const model = settings.provider === "dry-run" ? "dry-run" : settings.model;
  const generationRecord = finalizeGenerationRecord({
    kind: "chapter-summary",
    createdAt: new Date().toISOString(),
    provider: settings.provider,
    model,
    operation: prompt.operation,
    entries: () => promptEntriesInline(prompt),
    collector: generationRecordCollector
  });
  try {
    return await stories.commitProviderEffect(id, {
      kind: "chapter-summary",
      breakId,
      sourceFingerprint: fingerprint,
      summary,
      model,
      summaryNodeId: options.summaryNodeId,
      rewriteId: options.rewriteId,
      cancelled: signal,
      generationRecord
    });
  } catch (error) {
    if (error instanceof ServiceError
      && error.code === "story_manifest_requires_successor") {
      throw error;
    }
    if (error instanceof ServiceError && error.status === 404) {
      throw new GenerationResultError(
        409,
        "The story was deleted while its chapter summary was being written."
      );
    }
    throw error;
  }
}

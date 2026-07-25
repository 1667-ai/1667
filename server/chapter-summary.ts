import { SUMMARY_TARGET_TOKENS } from "../shared/chapters.js";
import type { Story } from "../shared/types.js";
import { GenerationResultError } from "./errors.js";
import type { BindGenerationIntent } from "./generation-http.js";
import { throwIfUncertainAbort } from "./generation-stream.js";
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
  const chapter = chapterSummarySource(snapshot, breakId);
  const fingerprint = chapterSourceFingerprint(snapshot, breakId);
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
  return await stories.commitProviderEffect(id, {
    kind: "chapter-summary",
    breakId,
    sourceFingerprint: fingerprint,
    summary,
    model,
    summaryNodeId: options.summaryNodeId,
    rewriteId: options.rewriteId,
    cancelled: signal
  });
}

import type { ContinuationPreviewRequest, ContinuationPreviewResult, StoryNode } from "../shared/types.js";
import { DEFAULT_WRITING_PROMPT_SETTINGS } from "../shared/settings-v5-writing.js";
import { resolveContinueRequestDirection } from "../shared/writing-prompt-runtime.js";
import { pathTo } from "../shared/story-tree.js";
import { buildContinueRequest, continueStreamOptions } from "./continue-request.js";
import { rejectedContinuationEcho } from "./generation-http.js";
import { streamModel, type DeltaConsumer } from "./generation-stream.js";
import type { PromptCacheRuntime } from "./provider-cache-policy.js";
import type { SettingsStore } from "./settings.js";
import type { StoryStore } from "./stories.js";
import { requireNode } from "./story-nodes.js";

/** Id of the unsaved part that holds the preview prefix. It never reaches
 *  storage; it only names the last part of the prompt context. */
const PREVIEW_PART_ID = "continuation-preview";

/** Stream the continuation `continueStory` would write for a new part under
 *  `request.parentId`, and save nothing: no part, no Generation Record, no
 *  Facts or direction memory, no story version change.
 *
 *  An empty `prefix` previews an ordinary new passage. A non-empty `prefix`
 *  previews a new part that already holds it: the prompt ends with that part
 *  as the unfinished assistant passage, the same path an append takes, and its
 *  instruction is the new part's own. The streamed text follows `prefix`
 *  exactly, so `prefix + text` is what that part would store. A real append
 *  stores the text untrimmed, so a leading space or newline in the first
 *  delta is part of the continuation. With an empty `prefix` the text is
 *  untrimmed too, but `continueStory` trims what it stores: the caller trims
 *  before it saves.
 *
 *  Returns null when `signal` stops the stream. */
export async function previewContinuation(
  id: string,
  request: ContinuationPreviewRequest,
  stories: Pick<StoryStore, "loadVersioned" | "hydratePath">,
  settingsStore: SettingsStore,
  promptCacheRuntime: PromptCacheRuntime,
  onDelta: DeltaConsumer,
  signal: AbortSignal
): Promise<ContinuationPreviewResult | null> {
  if (signal.aborted) return null;
  const { story } = await stories.loadVersioned(id);
  if (request.parentId !== null) {
    requireNode(story, request.parentId);
    await stories.hydratePath(story, request.parentId);
    if (signal.aborted) return null;
  }
  const { settings, promptCache, imageInputCapability, writing } = await settingsStore.loadGeneration("prose");
  if (signal.aborted) return null;
  // Resolved as for a new passage: the part the prefix stands in for is a new
  // part, so an empty instruction takes the Default Continue direction.
  const instruction = resolveContinueRequestDirection(
    request.instruction.trim(),
    writing ?? DEFAULT_WRITING_PROMPT_SETTINGS,
    false
  );
  const model = settings.provider === "dry-run" ? "dry-run" : settings.model;
  const line = request.parentId === null ? [] : pathTo(story, request.parentId);
  const appendLast = request.prefix.length > 0;
  const preview: StoryNode = {
    id: PREVIEW_PART_ID,
    parentId: request.parentId,
    instruction,
    text: request.prefix,
    model,
    createdAt: new Date().toISOString(),
    activeChildId: null
  };
  const built = buildContinueRequest({
    story,
    settings,
    model,
    contextParts: appendLast ? [...line, preview] : line,
    instruction,
    appendLast,
    images: [],
    imageInputCapability
  });
  const raw = await streamModel(
    settings,
    built.continuation.prompt,
    signal,
    onDelta,
    continueStreamOptions(built, story, id, promptCacheRuntime, promptCache)
  );
  if (raw === null) {
    if (built.output?.prefixRejected === true) throw rejectedContinuationEcho();
    return null;
  }
  if (built.continuation.requiresEcho && built.output?.matchedPrefix !== true) {
    throw rejectedContinuationEcho();
  }
  return { text: raw };
}

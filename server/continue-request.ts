import type { FactBudgetDrop } from "../shared/fact-budget.js";
import { activeBudgetedFacts } from "../shared/fact-selection.js";
import type { ImageInputCapabilityResolution } from "../shared/image-input-capabilities.js";
import type { StoryImageAttachment } from "../shared/image-attachment.js";
import type { GenerationSettings, Story, StoryNode } from "../shared/types.js";
import { assembleContinuation, type ContinuationAssembly } from "./continuation-assembly.js";
import { AnchoredOutputFilter, type ContinuationPlan } from "./generation-prompts.js";
import { admitFactsIntoPrompt, assertImageContextAdmitted } from "./generation-admission.js";
import { activeImageContext } from "./generation-image-attachments.js";
import type { StreamModelOptions } from "./generation-stream.js";
import { providerRuntimeFor } from "./provider-runtime.js";
import { createPromptCacheRequest, type PromptCacheContext, type PromptCacheRuntime } from "./provider-cache-policy.js";
import { storySamplingBias } from "./sampling-phrase-bias.js";
import type { StoredImageInputCapability } from "./settings-state-slot.js";

export interface ContinueRequestInput {
  readonly story: Story;
  readonly settings: GenerationSettings;
  /** Model name the request is credited to, already resolved from `settings`. */
  readonly model: string;
  /** The line the model reads. For an append or a preview prefix, the last
   *  part is the one being continued. */
  readonly contextParts: readonly StoryNode[];
  /** The request direction, already resolved by `resolveContinueRequestDirection`. */
  readonly instruction: string;
  /** True when the last context part is continued instead of a new part. */
  readonly appendLast: boolean;
  readonly images: readonly StoryImageAttachment[];
  /** The active route's stored image-input override, if any. */
  readonly imageInputCapability: StoredImageInputCapability | null;
}

/** Everything a continuation request is built from, before any side effect.
 *  `continueStory` and `previewContinuation` share it, so a preview sends the
 *  request Continue would send. */
export interface ContinueRequest {
  readonly continuation: ContinuationPlan;
  readonly continuationAssembly: ContinuationAssembly;
  readonly droppedFacts: readonly FactBudgetDrop[];
  readonly factsMessage: string | null;
  readonly activeImages: ReturnType<typeof activeImageContext>["activeImages"];
  readonly imageCapability: ImageInputCapabilityResolution | undefined;
  /** Strips the boundary echo that providers without prefill must repeat. */
  readonly output: AnchoredOutputFilter | undefined;
}

/** Select Facts and images, assemble the prompt, and admit it. Pure: it
 *  reads its input and writes nothing, so a caller may stop after it. */
export function buildContinueRequest(input: ContinueRequestInput): ContinueRequest {
  const { story, settings, model, contextParts, instruction } = input;
  const budgetedFacts = activeBudgetedFacts(story, {
    contextParts,
    chapterBreaks: story.chapterBreaks,
    nodes: story.nodes,
    instruction
  });
  const { activeImages, capability: imageCapability, fixedImageTokens } = activeImageContext(
    contextParts,
    input.images,
    {
      protocol: providerRuntimeFor(settings).protocol ?? "dry-run",
      remoteModelId: model,
      override: input.imageInputCapability?.imageInput,
      overrideTokenCeiling: input.imageInputCapability?.imageTokenCeiling
    }
  );
  const continuationAssembly = assembleContinuation({
    story,
    settings,
    contextParts,
    instruction,
    appendLast: input.appendLast,
    images: input.images
  });
  const { plan: continuation, admission } = admitFactsIntoPrompt(
    settings,
    budgetedFacts.kept,
    continuationAssembly.authorsNote,
    continuationAssembly.plan,
    fixedImageTokens
  );
  assertImageContextAdmitted(continuation.prompt, imageCapability);
  return {
    continuation,
    continuationAssembly,
    // `admission.dropped` alone misses whatever the story's own Facts budget
    // or a Fact's own budgetTokens cap already removed before admission.
    droppedFacts: [...budgetedFacts.dropped, ...admission.dropped],
    factsMessage: admission.factsMessage,
    activeImages,
    imageCapability,
    output: continuation.requiresEcho
      ? new AnchoredOutputFilter(continuation.leftAnchor, "", "", true)
      : undefined
  };
}

/** The `streamModel` options every continuation stream shares. */
export function continueStreamOptions(
  request: ContinueRequest,
  story: Story,
  storyId: string,
  promptCacheRuntime: PromptCacheRuntime,
  promptCache: PromptCacheContext
): Pick<StreamModelOptions, "output" | "promptCache" | "storySampling"> {
  return {
    output: request.output,
    promptCache: createPromptCacheRequest(
      promptCacheRuntime,
      promptCache,
      storyId,
      request.continuation.prompt.operation
    ),
    storySampling: storySamplingBias(story)
  };
}

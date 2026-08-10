import {
  admitFactsWith,
  selectFactsForFixedContext,
  type FixedContextAdmission,
  type FixedContextSettings
} from "../shared/fact-admission.js";
import {
  activeImageAttachments,
  type PromptPlan
} from "../shared/prompt-plan.js";
import {
  base64Length,
  MAX_ACTIVE_PROMPT_IMAGES,
  MAX_ACTIVE_PROMPT_IMAGE_BASE64_LENGTH,
  MAX_IMAGE_PROVIDER_BODY_BYTES
} from "../shared/image-attachment.js";
import {
  imageInputAuthorized,
  type ImageInputCapabilityResolution
} from "../shared/image-input-capabilities.js";
import type { StoryFact } from "../shared/types.js";
import { ServiceError } from "./errors.js";

export const MAX_GENERATION_MODEL_ATTRIBUTIONS = 50;

/**
 * The throwing wrapper `server/generation-http.ts` uses for a real request:
 * run the shared selection (`selectFactsForFixedContext`, shared/fact-admission.ts)
 * and turn a still-too-big result into the error a writer reads. The error
 * text is computed from what is left, so it stays accurate about the actual
 * remaining cause, and it names the fix that is actually available: when no
 * candidate Fact was droppable at all (every one is `always` at `normal` or
 * `high`), shedding could not have helped, and the message says so instead of
 * claiming a shed that never ran.
 */
export function assertFixedContextFits(
  settings: FixedContextSettings,
  candidateFacts: readonly StoryFact[],
  authorsNote: string | null,
  otherFixed: readonly string[],
  /** Visual tokens for the active prompt's images. See
   *  shared/fact-admission.ts's `fixedContextTokens`. Defaults to 0. */
  fixedImageTokens = 0
): FixedContextAdmission {
  const selection = selectFactsForFixedContext(settings, candidateFacts, authorsNote, otherFixed, fixedImageTokens);
  if (selection.fits) {
    return { facts: selection.facts, factsMessage: selection.factsMessage, dropped: selection.dropped };
  }
  const usable = selection.usableTokens ?? 0;
  const fixed = selection.fixedTokens;
  if (selection.overBudgetCause === "note") {
    throw new ServiceError(
      400,
      `The Author's Note is too large for the model's context window ` +
      `(~${fixed.toLocaleString()} fixed prompt tokens, ~${Math.max(0, usable).toLocaleString()} usable). ` +
      `Shorten the Author's Note, or raise the context window in Settings.`
    );
  }
  if (selection.droppableCount === 0) {
    throw new ServiceError(
      400,
      `The story facts are too large for the model's context window, and none of them can be dropped ` +
      `automatically (~${fixed.toLocaleString()} fixed prompt tokens, ~${Math.max(0, usable).toLocaleString()} usable). ` +
      `Mark low-value facts "low" priority so they shed under pressure, shorten or consolidate facts, ` +
      `or raise the context window in Settings.`
    );
  }
  throw new ServiceError(
    400,
    `The story facts are too large for the model's context window, even after dropping every ` +
    `droppable fact (~${fixed.toLocaleString()} fixed prompt tokens, ~${Math.max(0, usable).toLocaleString()} usable). ` +
    `Shorten or consolidate facts, or raise the context window in Settings.`
  );
}

/** The real request path: admission throws (via `assertFixedContextFits`)
 *  once nothing more can be shed. Every generation call in
 *  server/generation-http.ts uses this — collecting it here also gives it
 *  one place to report what admission dropped. Narrowed to
 *  `FixedContextSettings`, as its non-throwing sibling
 *  `previewFixedContextAdmission` (shared/fact-admission.ts) already is: this
 *  never reads a `GenerationSettings` field beyond the two that selection
 *  itself depends on. */
export function admitFactsIntoPrompt<P extends { prompt: PromptPlan }>(
  settings: FixedContextSettings,
  candidateFacts: readonly StoryFact[],
  authorsNote: string | null,
  build: (factsMessage: string | null) => P,
  /** Visual tokens for the active prompt's images. See
   *  shared/fact-admission.ts's `fixedContextTokens`. Defaults to 0.
   *
   *  The caller sums `estimateImageTokens` (shared/image-input-capabilities.ts)
   *  over every active image, using the capability resolution's own strategy,
   *  and passes the total here before it calls `build`. It uses the same
   *  active image list that `assertImageContextAdmitted` checks, so one image
   *  can never be counted for the budget and skipped for admission.
   *  `server/generation-image-attachments.ts` does this work. */
  fixedImageTokens = 0
): { plan: P; admission: FixedContextAdmission } {
  return admitFactsWith(
    (facts, note, otherFixed, images) => assertFixedContextFits(settings, facts, note, otherFixed, images),
    candidateFacts,
    authorsNote,
    build,
    fixedImageTokens
  );
}

/**
 * Reject an image-bearing prompt before it reaches a provider. Every check
 * here returns immediately for a plan with no image block, so a text-only
 * request is exactly as it was before Image Input existed.
 *
 * `capability` is the already-resolved verdict from
 * shared/image-input-capabilities.ts's `resolveImageInputCapability`, for the
 * exact model and protocol the request will use. A caller with no capability
 * to give (dry-run, text-completion, or a caller not yet wired for images)
 * passes nothing, which fails closed: any image on such a request is
 * refused.
 */
export function assertImageContextAdmitted(
  plan: PromptPlan,
  capability?: ImageInputCapabilityResolution
): void {
  const images = activeImageAttachments(plan);
  if (images.length === 0) return;
  if (capability === undefined || !imageInputAuthorized(capability)) {
    throw new ServiceError(
      400,
      "The selected model or connection does not support image input.",
      "image_input_not_supported"
    );
  }
  if (images.length > MAX_ACTIVE_PROMPT_IMAGES) {
    throw new ServiceError(
      400,
      `The active prompt carries more than ${MAX_ACTIVE_PROMPT_IMAGES} images. ` +
      "Remove a draft image, or let older image-bearing context roll out of the active prompt.",
      "image_context_too_large"
    );
  }
  const combinedBase64Length = images.reduce(
    (sum, image) => sum + base64Length(image.byteLength),
    0
  );
  if (combinedBase64Length > MAX_ACTIVE_PROMPT_IMAGE_BASE64_LENGTH) {
    throw new ServiceError(
      400,
      "The active prompt's combined image size is too large for one request. " +
      "Remove a draft image, or let older image-bearing context roll out of the active prompt.",
      "image_context_too_large"
    );
  }
}

/**
 * Reject a request body that is too large to send, only when it actually
 * carries an image. This bound exists to keep a base64-inflated body inside
 * what a provider accepts; a text-only body is never checked here, and stays
 * exactly as it was before Image Input existed.
 */
export function assertImageBearingBodyFits(
  body: Record<string, unknown>,
  hasImages: boolean
): void {
  if (!hasImages) return;
  const byteLength = Buffer.byteLength(JSON.stringify(body), "utf8");
  if (byteLength > MAX_IMAGE_PROVIDER_BODY_BYTES) {
    throw new ServiceError(
      413,
      "The image-bearing request body is too large for the provider.",
      "provider_request_too_large"
    );
  }
}

interface GenerationModelAttribution {
  readonly storyId: string;
  readonly genId: string;
  model: string;
}

/**
 * Process-local admission for continuation IDs. StoryService owns one instance,
 * so HTTP and worker callers contend on the same unambiguous story/gen tuple.
 */
export class GenerationAdmissionRegistry {
  private readonly active = new Map<string, Set<string>>();
  private readonly modelAttributions: GenerationModelAttribution[] = [];

  async run<T>(
    storyId: string,
    genId: string,
    operation: () => T | PromiseLike<T>
  ): Promise<T> {
    let storyGenerations = this.active.get(storyId);
    if (storyGenerations?.has(genId) === true) {
      throw new ServiceError(
        409,
        "This generation is already in progress; retry after it settles.",
        "resource_busy"
      );
    }
    if (storyGenerations === undefined) {
      storyGenerations = new Set();
      this.active.set(storyId, storyGenerations);
    }
    // No await between checking and claiming: one event-loop turn owns the tuple.
    storyGenerations.add(genId);
    try {
      return await operation();
    } finally {
      storyGenerations.delete(genId);
      if (storyGenerations.size === 0 && this.active.get(storyId) === storyGenerations) {
        this.active.delete(storyId);
      }
    }
  }

  rememberModel(storyId: string, genId: string, model: string): void {
    const existing = this.modelAttributions.find(
      (candidate) => candidate.storyId === storyId && candidate.genId === genId
    );
    if (existing !== undefined) {
      existing.model = model;
      return;
    }
    if (this.modelAttributions.length >= MAX_GENERATION_MODEL_ATTRIBUTIONS) {
      this.modelAttributions.shift();
    }
    this.modelAttributions.push({ storyId, genId, model });
  }

  modelFor(storyId: string, genId: string): string | undefined {
    return this.modelAttributions.find(
      (candidate) => candidate.storyId === storyId && candidate.genId === genId
    )?.model;
  }

  clear(): void {
    this.active.clear();
    this.modelAttributions.length = 0;
  }
}

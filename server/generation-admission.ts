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
import type { FactSelectionCandidate } from "../shared/fact-budget.js";
import { DEFAULT_INSTRUCTION } from "../shared/continuation-plan.js";
import { ServiceError } from "./errors.js";
import {
  generationRecordHandoffRevisionIds,
  type GenerationRecordHandoff
} from "./generation-record-handoff.js";

export const MAX_GENERATION_MODEL_ATTRIBUTIONS = 50;

/** Instruction a generated-take createNode commit stores. Prefer the
 *  direction pinned before streaming. Use the request body only for a
 *  human take or a legacy slot that has no pin. */
export function generatedTakeInstruction(
  admission: GenerationAdmissionRegistry,
  storyId: string,
  genId: string,
  providedInstruction: string
): string {
  return admission.continueDirectionFor(storyId, genId)
    ?? (providedInstruction.trim() || DEFAULT_INSTRUCTION);
}

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
  candidateFacts: readonly FactSelectionCandidate[],
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
  if (selection.overBudgetCause === "prompt") {
    throw new ServiceError(
      400,
      `The request prompt is too large for the model's context window ` +
      `(~${fixed.toLocaleString()} fixed prompt tokens, ~${Math.max(0, usable).toLocaleString()} usable). ` +
      `Shorten the direction or operation guidance, or raise the context window in Settings.`
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
  candidateFacts: readonly FactSelectionCandidate[],
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

interface GenerationAttribution {
  readonly storyId: string;
  readonly genId: string;
  model: string;
  /** Effective Continue direction pinned before streaming. Absent for a
   *  genuine append and for a legacy slot that predates pinning. */
  continueDirection: string | null;
  /** Set only by a continuation request that got cancelled mid-stream (issue
   *  Generation Records / stop-and-save): what the later, separate
   *  `createNode` call the client makes to save the partial needs to attach
   *  a truthful Generation Record to that take. Absent for a request that
   *  finished normally (its record is attached directly, in the same call)
   *  or that never streamed any output at all. */
  record: GenerationRecordHandoff | null;
  /** Releases `record`'s revision pin (see `GenerationAdmissionRegistry`'s
   *  constructor). Null whenever `record` is, and also once that pin has
   *  already been released — consumed by a stop-save commit, or dropped by
   *  eviction, replacement, or `clear()` — so it is never released twice. */
  releaseRevisionPin: (() => void) | null;
}

/**
 * Process-local admission for continuation IDs. StoryService owns one instance,
 * so HTTP and worker callers contend on the same unambiguous story/gen tuple.
 */
export class GenerationAdmissionRegistry {
  private readonly active = new Map<string, Set<string>>();
  private readonly modelAttributions: GenerationAttribution[] = [];

  /** `pinHandoffRevisions` protects a captured handoff's source revisions
   *  from the story's own object sweep for as long as this registry still
   *  holds the handoff — the gap between a cancelled continuation capturing
   *  it and a later, separate stop-save commit consuming it, which nothing
   *  else spans (`server/story-provider-mutation.ts`'s own snapshot pin
   *  releases as soon as that first request settles). Defaults to a no-op so
   *  tests that never touch story storage do not need a `StoryStore` to
   *  construct this. */
  constructor(
    private readonly pinHandoffRevisions:
      (storyId: string, revisionIds: readonly string[]) => () => void = () => () => {}
  ) {}

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
    this.evictOldestIfFull();
    this.modelAttributions.push({
      storyId, genId, model, continueDirection: null, record: null, releaseRevisionPin: null
    });
  }

  modelFor(storyId: string, genId: string): string | undefined {
    return this.modelAttributions.find(
      (candidate) => candidate.storyId === storyId && candidate.genId === genId
    )?.model;
  }

  /** Pin the Continue direction before streaming starts so later createNode
   *  commits, including stopped saves, store the same effective value. */
  rememberContinueDirection(storyId: string, genId: string, direction: string): void {
    const existing = this.modelAttributions.find(
      (candidate) => candidate.storyId === storyId && candidate.genId === genId
    );
    if (existing !== undefined) {
      existing.continueDirection = direction;
      return;
    }
    this.evictOldestIfFull();
    this.modelAttributions.push({
      storyId,
      genId,
      model: "",
      continueDirection: direction,
      record: null,
      releaseRevisionPin: null
    });
  }

  continueDirectionFor(storyId: string, genId: string): string | undefined {
    return this.modelAttributions.find(
      (candidate) => candidate.storyId === storyId && candidate.genId === genId
    )?.continueDirection ?? undefined;
  }

  /** Called once, by a continuation request that just discovered its own
   *  stream was cancelled — never by the later commit that reads it back via
   *  `generationRecordHandoffFor`. `rememberModel` always runs first (before
   *  that same request's provider stream even starts), so the slot this
   *  writes into already exists; the fallback insert below only guards
   *  against a caller that never called `rememberModel` first.
   *
   *  Pins the handoff's source revisions before storing it, so they stay
   *  readable for whatever later, separate stop-save commit reads this back
   *  — releasing any pin this same slot already held first, since a second
   *  call here would otherwise leak the first pin. */
  rememberGenerationRecordHandoff(storyId: string, genId: string, record: GenerationRecordHandoff): void {
    const releaseRevisionPin = this.pinHandoffRevisions(storyId, generationRecordHandoffRevisionIds(record));
    const existing = this.modelAttributions.find(
      (candidate) => candidate.storyId === storyId && candidate.genId === genId
    );
    if (existing !== undefined) {
      existing.releaseRevisionPin?.();
      existing.record = record;
      existing.releaseRevisionPin = releaseRevisionPin;
      return;
    }
    this.evictOldestIfFull();
    this.modelAttributions.push({
      storyId, genId, model: record.model, continueDirection: null, record, releaseRevisionPin
    });
  }

  /** Read by a stop-save commit at most once in practice — `commitTake`'s own
   *  genId dedup means a second commit for the same genId never reaches this
   *  far — but this lookup is non-destructive, so a redundant call is still
   *  safe: it simply returns the same handoff again rather than one commit
   *  racing another to consume it. */
  generationRecordHandoffFor(storyId: string, genId: string): GenerationRecordHandoff | undefined {
    return this.modelAttributions.find(
      (candidate) => candidate.storyId === storyId && candidate.genId === genId
    )?.record ?? undefined;
  }

  /** The owning consume-on-success lease for a stop-save handoff: hands
   *  whatever `rememberGenerationRecordHandoff` left for this genId (or
   *  `undefined` if nothing did) to `work`, then releases the revision pin
   *  and clears the record — but only once `work` has resolved. Nothing here
   *  marks the slot claimed before `work` runs, so a `work` that throws or
   *  rejects leaves the handoff exactly as it found it, ready for a later
   *  retry or save to consume, instead of getting stuck behind a claim flag
   *  no failure path ever clears.
   *
   *  Replaces the old, manually-coordinated `generationRecordHandoffFor` /
   *  `releaseGenerationRecordHandoff` pair every stop-save commit path used
   *  to glue together itself — this owns that lookup-work-release protocol
   *  once, here, instead of node-commit.ts and story-service-local.ts each
   *  reimplementing it. */
  async withGenerationRecordHandoff<T>(
    storyId: string,
    genId: string,
    work: (handoff: GenerationRecordHandoff | undefined) => T | PromiseLike<T>
  ): Promise<T> {
    const handoff = this.generationRecordHandoffFor(storyId, genId);
    const result = await work(handoff);
    this.releasePin(storyId, genId);
    return result;
  }

  /** Discards a handoff that a *different*, direct attempt has just made
   *  stale by committing durably or settling as a duplicate for the same
   *  genId — `server/generation-http.ts`'s own completed run never captured
   *  a handoff for itself (it never stopped), so it never has one to
   *  consume via `withGenerationRecordHandoff`; whatever is still sitting in
   *  this genId's slot belongs to an earlier, now-superseded stopped
   *  attempt. Named apart from consumption so a caller can never confuse
   *  "I used this handoff" with "this handoff no longer applies". Safe to
   *  call for a genId with no pin at all — a no-op, not an error. */
  discardSupersededGenerationRecordHandoff(storyId: string, genId: string): void {
    this.releasePin(storyId, genId);
  }

  /** Releases the handoff's revision pin and clears the handoff itself, since
   *  nothing will read this slot's record again for that purpose: the source
   *  revisions it pinned are no longer guaranteed live once the pin drops, so
   *  a later `generationRecordHandoffFor` for a reused genId must not hand
   *  back a handoff whose revisions may already be gone. `model` stays —
   *  `modelFor` still needs it (see `node-commit.ts`'s retried-commit path,
   *  which reads it after this same genId's handoff was already released).
   *  Idempotent — a second release for an already-released (or never-pinned)
   *  genId is a harmless no-op, not a double release. */
  private releasePin(storyId: string, genId: string): void {
    const existing = this.modelAttributions.find(
      (candidate) => candidate.storyId === storyId && candidate.genId === genId
    );
    if (existing === undefined) return;
    existing.releaseRevisionPin?.();
    existing.releaseRevisionPin = null;
    existing.record = null;
  }

  /** Drops the oldest slot once the bound is reached, releasing whatever
   *  revision pin it still held — an unconsumed handoff (its stop-save never
   *  arrived) must not outlive the slot that was the only thing remembering
   *  to release it. */
  private evictOldestIfFull(): void {
    if (this.modelAttributions.length < MAX_GENERATION_MODEL_ATTRIBUTIONS) return;
    this.modelAttributions.shift()?.releaseRevisionPin?.();
  }

  clear(): void {
    this.active.clear();
    for (const attribution of this.modelAttributions) attribution.releaseRevisionPin?.();
    this.modelAttributions.length = 0;
  }
}

import {
  admitFactsWith,
  selectFactsForFixedContext,
  type FixedContextAdmission,
  type FixedContextSettings
} from "../shared/fact-admission.js";
import type { PromptPlan } from "../shared/prompt-plan.js";
import type { StoryFact } from "../shared/types.js";
import { ServiceError } from "./errors.js";
import {
  generationRecordHandoffRevisionIds,
  type GenerationRecordHandoff
} from "./generation-record-handoff.js";

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
  otherFixed: readonly string[]
): FixedContextAdmission {
  const selection = selectFactsForFixedContext(settings, candidateFacts, authorsNote, otherFixed);
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
  build: (factsMessage: string | null) => P
): { plan: P; admission: FixedContextAdmission } {
  return admitFactsWith(
    (facts, note, otherFixed) => assertFixedContextFits(settings, facts, note, otherFixed),
    candidateFacts,
    authorsNote,
    build
  );
}

interface GenerationAttribution {
  readonly storyId: string;
  readonly genId: string;
  model: string;
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
    this.modelAttributions.push({ storyId, genId, model, record: null, releaseRevisionPin: null });
  }

  modelFor(storyId: string, genId: string): string | undefined {
    return this.modelAttributions.find(
      (candidate) => candidate.storyId === storyId && candidate.genId === genId
    )?.model;
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
    this.modelAttributions.push({ storyId, genId, model: record.model, record, releaseRevisionPin });
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

  /** Called once a stop-save commit has finished acting on whatever
   *  `generationRecordHandoffFor` returned it — whether that meant attaching
   *  a fresh Generation Record or discarding a duplicate genId's replay.
   *  Releases the handoff's revision pin and clears the handoff itself, since
   *  nothing will read this slot's record again for that purpose: the source
   *  revisions it pinned are no longer guaranteed live once the pin drops, so
   *  a later `generationRecordHandoffFor` for a reused genId must not hand
   *  back a handoff whose revisions may already be gone. `model` stays —
   *  `modelFor` still needs it (see `node-commit.ts`'s retried-commit path,
   *  which reads it after this same genId's handoff was already released).
   *  Safe to call for a genId with no pin (or none at all) — a no-op, not an
   *  error, so a caller never has to first check whether a handoff existed. */
  releaseGenerationRecordHandoff(storyId: string, genId: string): void {
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

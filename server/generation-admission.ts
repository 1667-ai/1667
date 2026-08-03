import {
  admitFactsWith,
  selectFactsForFixedContext,
  upperBoundTokens,
  type FixedContextAdmission,
  type FixedContextSettings
} from "../shared/fact-admission.js";
import type { PromptPlan } from "../shared/prompt-plan.js";
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
  otherFixed: readonly string[]
): FixedContextAdmission {
  const selection = selectFactsForFixedContext(settings, candidateFacts, authorsNote, otherFixed);
  if (selection.fits) {
    return { facts: selection.facts, factsMessage: selection.factsMessage, dropped: selection.dropped };
  }
  const notePresent = authorsNote !== null && authorsNote.trim().length > 0;
  const noteCost = notePresent ? upperBoundTokens(authorsNote!) : 0;
  const factsTokens = selection.factsMessage === null ? 0 : upperBoundTokens(selection.factsMessage);
  const usable = selection.usableTokens ?? 0;
  const fixed = selection.fixedTokens;
  if (noteCost > factsTokens) {
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

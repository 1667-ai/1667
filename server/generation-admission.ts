import { factsInSheddingOrder, selectFactsWithinBudget, type FactBudgetDrop } from "../shared/fact-budget.js";
import { fixedPromptTexts, type PromptPlan } from "../shared/prompt-plan.js";
import { formatFactsMessage } from "../shared/story-facts.js";
import type { GenerationSettings, StoryFact } from "../shared/types.js";
import { ServiceError } from "./errors.js";

export const MAX_GENERATION_MODEL_ATTRIBUTIONS = 50;

/** Conservative token bound for fixed prompt text. */
function upperBoundTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii += 1;
    else wide += 1;
  }
  return Math.ceil(ascii / 4) + wide * 2;
}

function fixedContextTokens(
  factsMessage: string | null,
  authorsNote: string | null,
  otherFixed: readonly string[]
): number {
  const notePresent = authorsNote !== null && authorsNote.trim().length > 0;
  const fixedTexts = [
    ...(factsMessage === null ? [] : [factsMessage]),
    ...(notePresent ? [authorsNote!] : []),
    ...otherFixed
  ];
  const framing = (fixedTexts.length + 2) * 4;
  return fixedTexts.reduce((sum, text) => sum + upperBoundTokens(text), framing);
}

export interface FixedContextAdmission {
  /** The admitted Facts, in emit order — pass to formatFactsMessage/the
   *  prompt builder in place of the candidate list that was checked. */
  readonly facts: readonly StoryFact[];
  readonly factsMessage: string | null;
  /** Facts shed to make the fixed prompt fit; empty when nothing had to give. */
  readonly dropped: readonly FactBudgetDrop[];
}

/**
 * Fit fixed prompt context — Facts, the Author's Note, and other fixed prompt
 * text — into the model's context window. Facts are the one part of the fixed
 * prompt this function is allowed to shrink: it sheds droppable Facts by
 * priority (see shared/fact-budget.ts for the exemption and tiebreak rules)
 * before giving up, so a full window degrades gracefully instead of failing
 * outright. It throws only once every droppable Fact is already gone and the
 * request still does not fit; the error text is computed from what is left,
 * so it stays accurate about the actual remaining cause.
 *
 * `candidateFacts` should already reflect activation matching and the story's
 * own Facts budget (see server/story-facts.ts's `activeBudgetedFacts`); this
 * function's main job is the window-pressure fallback on top of that. It also
 * re-applies each Fact's own `budgetTokens` cap itself rather than trusting
 * the caller to have done so — both gates go through the same canonical
 * estimator (shared/fact-budget.ts), so a Fact judged under its cap anywhere
 * else in the app is judged the same way here.
 */
export function assertFixedContextFits(
  settings: GenerationSettings,
  candidateFacts: readonly StoryFact[],
  authorsNote: string | null,
  otherFixed: readonly string[]
): FixedContextAdmission {
  const notePresent = authorsNote !== null && authorsNote.trim().length > 0;
  // A Fact over its own declared cap is dropped outright, independent of
  // window pressure — already exact, since shared/fact-budget.ts judges it by
  // the same canonical estimator every other surface uses for budgetTokens.
  const { kept: ownCapSurvivors, dropped: ownCapDrops } = selectFactsWithinBudget(candidateFacts, null);
  const initialMessage = formatFactsMessage(ownCapSurvivors);
  if (settings.contextWindow === null || (initialMessage === null && !notePresent)) {
    return { facts: ownCapSurvivors, factsMessage: initialMessage, dropped: ownCapDrops };
  }
  const usable = settings.contextWindow - settings.maxTokens;
  if (fixedContextTokens(initialMessage, authorsNote, otherFixed) <= usable) {
    return { facts: ownCapSurvivors, factsMessage: initialMessage, dropped: ownCapDrops };
  }

  // The fixed prompt still does not fit. formatFactsMessage is the single
  // authority on what a Fact block actually costs — its per-fact delimiters,
  // id-json, and length line are not modeled here a second time. Instead,
  // shed the lowest-value Fact, render the real message again, and repeat
  // until the real, re-measured prompt fits or nothing droppable is left.
  // This can never drift from what the request actually sends, because it
  // never estimates that cost — it always measures it.
  let kept = ownCapSurvivors;
  const spaceDrops: FactBudgetDrop[] = [];
  const fits = (facts: readonly StoryFact[]): boolean =>
    fixedContextTokens(formatFactsMessage(facts), authorsNote, otherFixed) <= usable;
  for (const fact of factsInSheddingOrder(ownCapSurvivors)) {
    if (fits(kept)) break;
    kept = kept.filter((candidate) => candidate.id !== fact.id);
    spaceDrops.push({ factId: fact.id, reason: "priority" });
  }
  const factsMessage = formatFactsMessage(kept);
  const fixed = fixedContextTokens(factsMessage, authorsNote, otherFixed);
  const dropped = [...ownCapDrops, ...spaceDrops];
  if (fixed <= usable) return { facts: kept, factsMessage, dropped };

  const noteCost = notePresent ? upperBoundTokens(authorsNote!) : 0;
  const factsTokens = factsMessage === null ? 0 : upperBoundTokens(factsMessage);
  if (noteCost > factsTokens) {
    throw new ServiceError(
      400,
      `The Author's Note is too large for the model's context window ` +
      `(~${fixed.toLocaleString()} fixed prompt tokens, ~${Math.max(0, usable).toLocaleString()} usable). ` +
      `Shorten the Author's Note, or raise the context window in Settings.`
    );
  }
  throw new ServiceError(
    400,
    `The story facts are too large for the model's context window, even after dropping every ` +
    `droppable fact (~${fixed.toLocaleString()} fixed prompt tokens, ~${Math.max(0, usable).toLocaleString()} usable). ` +
    `Shorten or consolidate facts, or raise the context window in Settings.`
  );
}

/**
 * Build a prompt from a Facts message, admit it, and rebuild only if
 * admission actually shed a Fact. `build` runs at most twice: `fixedPromptTexts`
 * excludes the facts block itself (see shared/prompt-plan.ts), so the first
 * build's non-Fact text never depends on which Facts were used and is never
 * wasted work. This is the one build/admit/compare/rebuild shape every
 * generation call in server/generation-http.ts needs — collecting it here
 * also gives it one place to report what admission dropped.
 */
export function admitFactsIntoPrompt<P extends { prompt: PromptPlan }>(
  settings: GenerationSettings,
  candidateFacts: readonly StoryFact[],
  authorsNote: string | null,
  build: (factsMessage: string | null) => P
): { plan: P; admission: FixedContextAdmission } {
  const initialFactsMessage = formatFactsMessage(candidateFacts);
  const initial = build(initialFactsMessage);
  const admission = assertFixedContextFits(
    settings,
    candidateFacts,
    authorsNote,
    fixedPromptTexts(initial.prompt)
  );
  const plan = admission.factsMessage === initialFactsMessage ? initial : build(admission.factsMessage);
  return { plan, admission };
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

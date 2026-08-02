import { selectFactsWithinBudget, type FactBudgetDrop } from "../shared/fact-budget.js";
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
 * own Facts budget (see server/story-facts.ts's `activeBudgetedFacts`) — this
 * function only handles the window-pressure fallback on top of that.
 */
export function assertFixedContextFits(
  settings: GenerationSettings,
  candidateFacts: readonly StoryFact[],
  authorsNote: string | null,
  otherFixed: readonly string[]
): FixedContextAdmission {
  const notePresent = authorsNote !== null && authorsNote.trim().length > 0;
  const initialMessage = formatFactsMessage(candidateFacts);
  if (settings.contextWindow === null || (initialMessage === null && !notePresent)) {
    return { facts: candidateFacts, factsMessage: initialMessage, dropped: [] };
  }
  const usable = settings.contextWindow - settings.maxTokens;
  if (fixedContextTokens(initialMessage, authorsNote, otherFixed) <= usable) {
    return { facts: candidateFacts, factsMessage: initialMessage, dropped: [] };
  }

  // The fixed prompt does not fit. Work out how much room Facts could have —
  // window minus everything else fixed — and shed the lowest-value Facts
  // first until what remains fits that room, or nothing droppable is left.
  const noteCost = notePresent ? upperBoundTokens(authorsNote!) : 0;
  const otherCost = otherFixed.reduce((sum, text) => sum + upperBoundTokens(text), 0);
  // Mirrors fixedContextTokens' framing for a prompt that still has a Facts
  // block: otherFixed's blocks, the Author's Note if present, one for Facts,
  // plus the same +2 constant. Shedding down to zero Facts only makes this a
  // few tokens more conservative than necessary, never less.
  const framingBlocks = otherFixed.length + (notePresent ? 1 : 0) + 1 + 2;
  const availableForFacts = usable - noteCost - otherCost - framingBlocks * 4;
  const { kept, dropped } = selectFactsWithinBudget(candidateFacts, Math.max(0, availableForFacts), {
    spaceDropReason: "priority",
    estimateFactTokens: (fact) => upperBoundTokens(fact.text)
  });
  const factsMessage = formatFactsMessage(kept);
  const fixed = fixedContextTokens(factsMessage, authorsNote, otherFixed);
  if (fixed <= usable) return { facts: kept, factsMessage, dropped };

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

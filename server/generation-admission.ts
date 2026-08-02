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

/** The only settings fields window-pressure selection reads. A caller that
 *  only wants to preview the selection (see `previewFixedContextAdmission`)
 *  supplies just these two rather than a full `GenerationSettings`. */
export type FixedContextSettings = Pick<GenerationSettings, "contextWindow" | "maxTokens">;

export interface FixedContextSelection extends FixedContextAdmission {
  /** False only once every droppable Fact is already gone and the fixed
   *  prompt still does not fit. A throwing caller (see `assertFixedContextFits`)
   *  turns that into an error; a previewing caller (the TUI's next-request
   *  projection) reports the best selection it found and leaves the "still
   *  over" verdict to whatever already renders window severity. */
  readonly fits: boolean;
  /** The fixed prompt's real, re-measured token cost for the returned selection. */
  readonly fixedTokens: number;
  /** `contextWindow - maxTokens`; null when no context window was configured
   *  at all, in which case shedding never engaged and `fits` is always true. */
  readonly usableTokens: number | null;
  /** How many candidate Facts were droppable in the first place, before any
   *  shedding — zero here is a different situation from "shed everything and
   *  still over": there was nothing this pass could have done. */
  readonly droppableCount: number;
}

/**
 * Select which Facts fit fixed prompt context — Facts, the Author's Note, and
 * other fixed prompt text — into the model's context window. Facts are the
 * one part of the fixed prompt this function is allowed to shrink: it sheds
 * droppable Facts by priority (see shared/fact-budget.ts for the exemption
 * and tiebreak rules) before giving up, so a full window degrades gracefully
 * instead of failing outright. It never throws — see `assertFixedContextFits`
 * for the server's throwing wrapper around this same selection, and
 * `previewFixedContextAdmission` for the non-throwing caller this exists for.
 *
 * `candidateFacts` should already reflect activation matching and the story's
 * own Facts budget (see server/story-facts.ts's `activeBudgetedFacts`); this
 * function's main job is the window-pressure fallback on top of that. It also
 * re-applies each Fact's own `budgetTokens` cap itself rather than trusting
 * the caller to have done so — both gates go through the same canonical
 * estimator (shared/fact-budget.ts), so a Fact judged under its cap anywhere
 * else in the app is judged the same way here.
 */
export function selectFactsForFixedContext(
  settings: FixedContextSettings,
  candidateFacts: readonly StoryFact[],
  authorsNote: string | null,
  otherFixed: readonly string[]
): FixedContextSelection {
  const notePresent = authorsNote !== null && authorsNote.trim().length > 0;
  // A Fact over its own declared cap is dropped outright, independent of
  // window pressure — already exact, since shared/fact-budget.ts judges it by
  // the same canonical estimator every other surface uses for budgetTokens.
  const { kept: ownCapSurvivors, dropped: ownCapDrops } = selectFactsWithinBudget(candidateFacts, null);
  const initialMessage = formatFactsMessage(ownCapSurvivors);
  const droppableCount = factsInSheddingOrder(ownCapSurvivors).length;
  if (settings.contextWindow === null || (initialMessage === null && !notePresent)) {
    return {
      facts: ownCapSurvivors, factsMessage: initialMessage, dropped: ownCapDrops,
      fits: true, fixedTokens: fixedContextTokens(initialMessage, authorsNote, otherFixed),
      usableTokens: null, droppableCount
    };
  }
  const usable = settings.contextWindow - settings.maxTokens;
  const initialFixed = fixedContextTokens(initialMessage, authorsNote, otherFixed);
  if (initialFixed <= usable) {
    return {
      facts: ownCapSurvivors, factsMessage: initialMessage, dropped: ownCapDrops,
      fits: true, fixedTokens: initialFixed, usableTokens: usable, droppableCount
    };
  }

  // The fixed prompt still does not fit. formatFactsMessage is the single
  // authority on what a Fact block actually costs — its per-fact delimiters,
  // id-json, and length line are not modeled here a second time. Instead,
  // shed the lowest-value Facts and render the real message again, until the
  // real, re-measured prompt fits or nothing droppable is left. This can
  // never drift from what the request actually sends, because it never
  // estimates that cost — it always measures it.
  const fits = (facts: readonly StoryFact[]): boolean =>
    fixedContextTokens(formatFactsMessage(facts), authorsNote, otherFixed) <= usable;
  const sheddable = factsInSheddingOrder(ownCapSurvivors);
  const keptAfterShedding = (shedCount: number): readonly StoryFact[] => {
    const shedIds = new Set(sheddable.slice(0, shedCount).map((fact) => fact.id));
    return ownCapSurvivors.filter((candidate) => !shedIds.has(candidate.id));
  };
  // Binary search the smallest shed count that fits, instead of shedding one
  // Fact at a time and re-measuring after each. Cost is monotone
  // non-increasing in the number shed — removing a Fact can only lower or
  // hold the real rendered token count — so `fits` is monotone over the shed
  // count, and this still measures the real rendered message at every probe;
  // it only changes how many measurements the search takes. At MAX_FACTS
  // (128 Facts, shared/types.ts), that is roughly 7 renders instead of up to
  // 128 (issue #281 review finding K).
  let low = 0;
  let high = sheddable.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (fits(keptAfterShedding(mid))) high = mid; else low = mid + 1;
  }
  const shedCount = low;
  const kept = keptAfterShedding(shedCount);
  const spaceDrops: FactBudgetDrop[] = sheddable
    .slice(0, shedCount)
    .map((fact) => ({ factId: fact.id, reason: "priority" }));
  const factsMessage = formatFactsMessage(kept);
  const fixed = fixedContextTokens(factsMessage, authorsNote, otherFixed);
  return {
    facts: kept, factsMessage, dropped: [...ownCapDrops, ...spaceDrops],
    fits: fixed <= usable, fixedTokens: fixed, usableTokens: usable, droppableCount
  };
}

/**
 * The throwing wrapper `server/generation-http.ts` uses for a real request:
 * run the shared selection (`selectFactsForFixedContext`) and turn a
 * still-too-big result into the error a writer reads. The error text is
 * computed from what is left, so it stays accurate about the actual
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

/**
 * Build a prompt from a Facts message, select the window-pressure admission,
 * and rebuild only if it actually shed a Fact. `build` runs at most twice:
 * `fixedPromptTexts` excludes the facts block itself (see shared/prompt-plan.ts),
 * so the first build's non-Fact text never depends on which Facts were used
 * and is never wasted work. `select` is the one difference between a real
 * request and a preview of one: everything else — order of operations, the
 * one-or-two-build shape, how a shed Fact changes the rebuilt prompt — is
 * shared code, so the two cannot drift the way review finding H found them
 * to have drifted.
 *
 * Whether admission actually shed anything is decided by comparing the
 * admitted Fact sequence to the candidate one, not by comparing the two
 * rendered messages: `formatFactsMessage` embeds every admitted Fact's ID, so
 * two different Fact sequences cannot render identically, and a short ID
 * comparison is cheaper than diffing a message that can run to several
 * hundred KB in the one case — nothing shed — this check runs on every
 * request (issue #281 review finding K).
 */
function admitFactsWith<P extends { prompt: PromptPlan }>(
  select: (
    candidateFacts: readonly StoryFact[],
    authorsNote: string | null,
    otherFixed: readonly string[]
  ) => FixedContextAdmission,
  candidateFacts: readonly StoryFact[],
  authorsNote: string | null,
  build: (factsMessage: string | null) => P
): { plan: P; admission: FixedContextAdmission } {
  const initialFactsMessage = formatFactsMessage(candidateFacts);
  const initial = build(initialFactsMessage);
  const admission = select(candidateFacts, authorsNote, fixedPromptTexts(initial.prompt));
  const plan = sameFactSequence(admission.facts, candidateFacts) ? initial : build(admission.factsMessage);
  return { plan, admission };
}

function sameFactSequence(left: readonly StoryFact[], right: readonly StoryFact[]): boolean {
  return left.length === right.length && left.every((fact, index) => fact.id === right[index]?.id);
}

/** The real request path: admission throws (via `assertFixedContextFits`)
 *  once nothing more can be shed. Every generation call in
 *  server/generation-http.ts uses this — collecting it here also gives it
 *  one place to report what admission dropped. */
export function admitFactsIntoPrompt<P extends { prompt: PromptPlan }>(
  settings: GenerationSettings,
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

/**
 * The TUI's next-request projection calls this instead of reimplementing
 * window-pressure shedding on its side — see tui/src/request-projection.ts.
 * Same build/select/rebuild shape as `admitFactsIntoPrompt`, but backed by
 * the non-throwing `selectFactsForFixedContext`, because a meter previewing a
 * request must never throw for what it is showing. A selection that still
 * does not fit is returned as-is; the projection already has its own honest
 * way to say a request runs over the window (see tui/src/rail.ts), so it does
 * not need this function's verdict, only its Facts.
 */
export function previewFixedContextAdmission<P extends { prompt: PromptPlan }>(
  settings: FixedContextSettings,
  candidateFacts: readonly StoryFact[],
  authorsNote: string | null,
  build: (factsMessage: string | null) => P
): { plan: P; admission: FixedContextAdmission } {
  return admitFactsWith(
    (facts, note, otherFixed) => selectFactsForFixedContext(settings, facts, note, otherFixed),
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

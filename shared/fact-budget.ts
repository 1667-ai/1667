import type { FactPriority } from "./fact-activation.js";
import { estimateTokens } from "./tokens.js";
import type { StoryFact } from "./types.js";

/** A single Fact's own cap is a believable token count, not an arbitrary
 * integer — generous enough that only a deliberately extreme value hits it. */
export const MAX_FACT_BUDGET_TOKENS = 100_000;
/** The story-wide cap sits above any real model window, so it guards against
 * a nonsensical wire value rather than acting as a real-world ceiling. */
export const MAX_STORY_FACTS_BUDGET_TOKENS = 1_000_000;

/** Why one Fact did not make it into the emitted block. */
export type FactDropReason = "priority" | "fact-budget" | "total-budget";

export interface FactBudgetDrop {
  readonly factId: string;
  readonly reason: FactDropReason;
}

export interface FactBudgetSelection {
  /** Survivors, in the same order they arrived — array order is emit order. */
  readonly kept: readonly StoryFact[];
  readonly dropped: readonly FactBudgetDrop[];
}

const PRIORITY_RANK: Record<FactPriority, number> = { low: 0, normal: 1, high: 2 };

function effectivePriority(fact: StoryFact): FactPriority {
  return fact.priority ?? "normal";
}

/**
 * `always` Facts play the persistent-context role that `keyed` Facts do not,
 * so shedding leaves them alone by default — that exemption is the reason to
 * pick "always" over "keyed" in the first place. Ranking an `always` Fact
 * "low" is a deliberate opt-out of that guarantee, not an oversight, so it
 * loses the exemption. A `keyed` Fact carries no such promise and stays
 * droppable at every priority.
 */
function isDroppable(fact: StoryFact): boolean {
  return fact.activation !== "always" || effectivePriority(fact) === "low";
}

/** Ascending: the Fact shed first sorts first.
 *
 * Shedding order, lowest value first: priority (low, then normal, then
 * high), then within a priority `keyed` before `always`, then — as the
 * final tiebreak — later emit position before earlier. */
function sheddingOrder(
  a: { fact: StoryFact; position: number },
  b: { fact: StoryFact; position: number }
): number {
  const rankDiff = PRIORITY_RANK[effectivePriority(a.fact)] - PRIORITY_RANK[effectivePriority(b.fact)];
  if (rankDiff !== 0) return rankDiff;
  const keyedRank = (fact: StoryFact): number => (fact.activation === "keyed" ? 0 : 1);
  const keyedDiff = keyedRank(a.fact) - keyedRank(b.fact);
  if (keyedDiff !== 0) return keyedDiff;
  return b.position - a.position;
}

/**
 * Select which candidate Facts fit inside `availableTokens`, shedding the
 * lowest-value ones first. Never truncates a Fact's text — `formatFactsMessage`
 * promises exact bodies, so a Fact either rides whole or is dropped whole.
 *
 * A Fact whose own `budgetTokens` cap is smaller than its estimated size is
 * always dropped (reason `"fact-budget"`), independent of `availableTokens`.
 * The remaining Facts are admitted in their given (emit) order until the
 * budget is spent; whatever does not fit is shed in priority order and
 * reported with `spaceDropReason` — `"total-budget"` for the story's own Facts
 * budget, `"priority"` for shedding under model-context-window pressure.
 *
 * `availableTokens: null` means no budget applies: every Fact under its own
 * cap survives.
 */
export function selectFactsWithinBudget(
  facts: readonly StoryFact[],
  availableTokens: number | null,
  options: {
    spaceDropReason?: "priority" | "total-budget";
    estimateFactTokens?: (fact: StoryFact) => number;
  } = {}
): FactBudgetSelection {
  const spaceDropReason = options.spaceDropReason ?? "total-budget";
  const estimate = options.estimateFactTokens ?? ((fact: StoryFact) => estimateTokens(fact.text));
  const dropped: FactBudgetDrop[] = [];
  const survivors: StoryFact[] = [];
  for (const fact of facts) {
    if (fact.budgetTokens !== undefined && estimate(fact) > fact.budgetTokens) {
      dropped.push({ factId: fact.id, reason: "fact-budget" });
      continue;
    }
    survivors.push(fact);
  }
  if (availableTokens === null) return { kept: survivors, dropped };

  let total = 0;
  const positioned = survivors.map((fact, position) => {
    total += estimate(fact);
    return { fact, position };
  });
  if (total <= availableTokens) return { kept: survivors, dropped };

  const shedIds = new Set<string>();
  const sheddable = positioned.filter(({ fact }) => isDroppable(fact)).sort(sheddingOrder);
  for (const { fact } of sheddable) {
    if (total <= availableTokens) break;
    shedIds.add(fact.id);
    total -= estimate(fact);
    dropped.push({ factId: fact.id, reason: spaceDropReason });
  }
  return {
    kept: survivors.filter((fact) => !shedIds.has(fact.id)),
    dropped
  };
}

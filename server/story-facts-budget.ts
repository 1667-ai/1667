import { ServiceError as HttpError } from "./errors.js";
import { MAX_STORY_FACTS_BUDGET_TOKENS } from "../shared/fact-budget.js";
import type { Story } from "../shared/types.js";

/** Store one story-wide Facts token budget, or clear it with null. Mirrors
 * setAuthorsNote's shape: one optional story-level scalar, one mutation. */
export function setFactsBudget(story: Story, budgetTokens: number | null): void {
  if (budgetTokens === null) {
    delete story.factsBudgetTokens;
    return;
  }
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 1 || budgetTokens > MAX_STORY_FACTS_BUDGET_TOKENS) {
    throw new HttpError(
      400,
      `factsBudgetTokens must be an integer between 1 and ${MAX_STORY_FACTS_BUDGET_TOKENS.toLocaleString()}, or null to clear it.`
    );
  }
  story.factsBudgetTokens = budgetTokens;
}

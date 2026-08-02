import { ServiceError as HttpError } from "./errors.js";
import {
  FactBudgetError,
  parseStoryFactsBudgetTokens,
  storyFactsBudgetRangeMessage
} from "../shared/fact-budget.js";
import type { Story } from "../shared/types.js";

/** Store one story-wide Facts token budget, or clear it with null. Mirrors
 * setAuthorsNote's shape: one optional story-level scalar, one mutation.
 * Bounds through the canonical parser (shared/fact-budget.ts) rather than a
 * bespoke check — the same rule used to have four other copies that could
 * silently drift from it (issue #281 review finding F). The value is already
 * validated upstream on every real path (see
 * server/worker-mutations.ts's parseFactsBudgetTokensInput); this still
 * checks it directly rather than trusting that, the same way every other
 * story mutation here does not trust its caller. */
export function setFactsBudget(story: Story, budgetTokens: number | null): void {
  if (budgetTokens === null) {
    delete story.factsBudgetTokens;
    return;
  }
  try {
    story.factsBudgetTokens = parseStoryFactsBudgetTokens(budgetTokens, "factsBudgetTokens");
  } catch (error) {
    if (!(error instanceof FactBudgetError)) throw error;
    throw new HttpError(400, storyFactsBudgetRangeMessage("factsBudgetTokens"));
  }
}

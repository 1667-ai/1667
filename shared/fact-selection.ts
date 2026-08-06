import {
  selectActiveFactsWithTrace,
  selectActiveFactsForRewriteWithTrace
} from "./fact-activation.js";
import type { FactScanContext } from "./fact-scan.js";
import { selectFactsWithinBudget, type FactBudgetSelection } from "./fact-budget.js";
import { formatFactsMessage } from "./story-facts.js";
import { activePath } from "./story-tree.js";
import type { Story, StoryFact } from "./types.js";

/** What the Facts budget needs from whatever is asking. A `Story` and a
 * `StoryPayload` both satisfy it, so the server and the request projection
 * select from the same function instead of two copies that can drift. */
export interface FactsBudgetSource {
  readonly facts: readonly StoryFact[];
  readonly factsBudgetTokens?: number;
}

/** Facts whose activation matches, further shed against the story's own Facts
 * budget (if any). This is the set a request would actually admit before
 * model-context-window pressure gets a further say — see
 * `selectFactsForFixedContext` in shared/fact-admission.ts for that second,
 * provider-window-sized pass.
 *
 * This lives in shared/ rather than beside the Fact mutations it used to sit
 * with (issue #316 review): it needs nothing from the server, and the TUI's
 * render path calls it. Importing it from server/story-facts.ts pulled that
 * file's whole closure — node:crypto, node:fs and node:path among it — into
 * the render path's module graph. */
export type FactBudgetedSelection = FactBudgetSelection & {
  readonly activation: ReturnType<typeof selectActiveFactsWithTrace>;
};
export function activeBudgetedFacts(
  source: FactsBudgetSource,
  context?: FactScanContext
): FactBudgetedSelection {
  const activation = selectActiveFactsWithTrace(source.facts, context);
  return {
    ...selectFactsWithinBudget(
      activation.facts,
      source.factsBudgetTokens ?? null,
      { spaceDropReason: "total-budget" }
    ),
    activation
  };
}

export function activeBudgetedFactsForRewrite(
  story: Story,
  partId: string,
  instruction: string,
  selectedText: string
): FactBudgetedSelection {
  const activation = selectActiveFactsForRewriteWithTrace(
    story.facts,
    activePath(story),
    partId,
    story.chapterBreaks,
    story.nodes,
    instruction,
    selectedText
  );
  return {
    ...selectFactsWithinBudget(
      activation.facts,
      story.factsBudgetTokens ?? null,
      { spaceDropReason: "total-budget" }
    ),
    activation
  };
}

export function factsSystemMessage(story: Story, context?: FactScanContext): string | null {
  return formatFactsMessage(activeBudgetedFacts(story, context).kept);
}

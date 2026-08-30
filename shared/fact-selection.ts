import {
  selectActiveFactsWithTrace,
  selectActiveFactsForRewriteWithTrace
} from "./fact-activation.js";
import type { FactScanContext } from "./fact-scan.js";
import { selectFactsWithinBudget, type FactBudgetSelection } from "./fact-budget.js";
import { formatFactsMessage } from "./story-facts.js";
import { activePath } from "./story-tree.js";
import type { Story, StoryFact, StoryNode } from "./types.js";
import type { EffectiveStoryFact } from "./fact-state.js";

/** What the Facts budget needs from whatever is asking. A `Story` and a
 * `StoryPayload` both satisfy it, so the server and the request projection
 * select from the same function instead of two copies that can drift. */
export interface FactsBudgetSource {
  readonly facts: readonly StoryFact[];
  readonly factsBudgetTokens?: number;
  /** Optional request path for callers that do not pass a scan context. */
  readonly requestPath?: readonly { readonly id: string }[];
  /** Hydrated path text for payload-shaped callers without a full Story. */
  readonly path?: readonly StoryNode[];
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
export type FactBudgetedSelection = FactBudgetSelection<EffectiveStoryFact> & {
  readonly activation: ReturnType<typeof selectActiveFactsWithTrace>;
};
export function activeBudgetedFacts(
  source: FactsBudgetSource,
  context?: FactScanContext
): FactBudgetedSelection {
  const resolvedContext = context ?? defaultFactContext(source);
  const activation = selectActiveFactsWithTrace(source.facts, resolvedContext);
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
  const resolvedContext = context ?? defaultFactContext(story);
  return formatFactsMessage(activeBudgetedFacts(story, resolvedContext).kept);
}

function defaultFactContext(source: FactsBudgetSource): FactScanContext | undefined {
  if (source.path !== undefined) {
    return {
      contextParts: source.path,
      requestPath: source.requestPath ?? source.path,
      chapterBreaks: [],
      nodes: []
    };
  }
  if (isStory(source)) {
    const path = activePath(source);
    return { contextParts: path, requestPath: path, chapterBreaks: source.chapterBreaks, nodes: source.nodes };
  }
  return source.requestPath === undefined
    ? undefined
    : { contextParts: [], requestPath: source.requestPath, chapterBreaks: [], nodes: [] };
}

function isStory(source: FactsBudgetSource): source is Story {
  return "activeRootId" in source && Array.isArray((source as Story).nodes);
}

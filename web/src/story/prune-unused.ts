import { unusedTakePruneSelection } from "../../../shared/story-tree.js";
import type { StoryPayload } from "../../../shared/types.js";

/** What "prune drafts & discarded" would remove, read when the writer asks.
 * The same numbers go to the server with the confirm, so a story that changed
 * meanwhile is refused instead of pruned differently. */
export interface UnusedPrunePlan {
  readonly storyId: string;
  /** The story's revision when the plan was made. */
  readonly revision: string;
  /** Leaf takes that no line continues from. */
  readonly takes: number;
  /** Every part that dies with them. */
  readonly parts: number;
}

export const NOTHING_TO_PRUNE_TOAST = "Nothing to prune. Every leaf is protected.";

/** The plan, or `null` when every leaf is protected. The selection itself is
 * the shared one (`shared/story-tree.ts`): a take with a continuation, every
 * tagged line, and one leaf at each fork survive. */
export function createUnusedPrunePlan(payload: StoryPayload): UnusedPrunePlan | null {
  const selection = unusedTakePruneSelection(payload);
  if (selection.takeIds.length === 0) return null;
  return {
    storyId: payload.id,
    revision: payload.updatedAt,
    takes: selection.takeIds.length,
    parts: selection.nodeIds.length
  };
}

export function unusedPruneQuestion(plan: UnusedPrunePlan): string {
  const takes = `${plan.takes} unused ${plan.takes === 1 ? "take" : "takes"}`;
  const parts = `${plan.parts} ${plan.parts === 1 ? "part" : "parts"}`;
  return `Delete ${takes}, ${parts} in all?`;
}

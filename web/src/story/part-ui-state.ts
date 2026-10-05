import type { DeletePlan } from "./delete-plan.js";
import type { UnusedPrunePlan } from "./prune-unused.js";

/**
 * Small pieces of part UI state that two components must share: a request to
 * open one part's `···` menu (from the `x` key), and the delete
 * confirmation. See `story/part-commands.ts`.
 */
export interface LineClip {
  readonly storyId: string;
  /** The part the line was copied below, and the last part of that line when
   * it was copied. The prose is never held: the paste asks the server to read
   * the live line again. */
  readonly sourceNodeId: string;
  readonly expectedLeafId: string;
  readonly parts: number;
}

export interface PartUiState {
  /** Raised by the `x` key; the part's menu opens when `serial` changes. */
  readonly menuRequest: { readonly partId: string; readonly serial: number } | null;
  readonly deletePlan: DeletePlan | null;
  /** "Prune drafts & discarded" asked, and not yet confirmed. */
  readonly unusedPlan: UnusedPrunePlan | null;
  readonly deleting: boolean;
  /** The one copied story line, if any ("Copy story line below"). */
  readonly lineClip: LineClip | null;
}

export function initialPartUiState(): PartUiState {
  return { menuRequest: null, deletePlan: null, unusedPlan: null, deleting: false, lineClip: null };
}

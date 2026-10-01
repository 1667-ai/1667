/**
 * Small pieces of part UI state that two components must share: a request to
 * open one part's `···` menu (from the `x` key), and the delete
 * confirmation. See `story/part-actions.ts`.
 */

/** What one confirmed delete removes, read from the story when `D` is
 * pressed. `parts` counts the part itself and everything below it — the same
 * number the server checks (`expectedSubtreeCount`). */
export interface DeletePlan {
  readonly storyId: string;
  readonly nodeId: string;
  readonly partNumber: number;
  readonly take: number;
  readonly takeCount: number;
  readonly parts: number;
  readonly lines: number;
  readonly tags: readonly string[];
  readonly factStates: number;
}

export interface PartUiState {
  /** Raised by the `x` key; the part's menu opens when `serial` changes. */
  readonly menuRequest: { readonly partId: string; readonly serial: number } | null;
  readonly deletePlan: DeletePlan | null;
  readonly deleting: boolean;
}

export function initialPartUiState(): PartUiState {
  return { menuRequest: null, deletePlan: null, deleting: false };
}

/** Plain wording of what a delete removes, from the plan the `D` key made. */
export function deleteQuestion(plan: DeletePlan): string {
  const below = plan.parts - 1;
  if (below === 0) return `Delete part ${plan.partNumber}?`;
  return `Delete part ${plan.partNumber} and the ${below} ${below === 1 ? "part" : "parts"} below it?`;
}

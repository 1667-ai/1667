import type { DeletePlan } from "./delete-plan.js";

/**
 * Small pieces of part UI state that two components must share: a request to
 * open one part's `···` menu (from the `x` key), and the delete
 * confirmation. See `story/part-commands.ts`.
 */
export interface PartUiState {
  /** Raised by the `x` key; the part's menu opens when `serial` changes. */
  readonly menuRequest: { readonly partId: string; readonly serial: number } | null;
  readonly deletePlan: DeletePlan | null;
  readonly deleting: boolean;
}

export function initialPartUiState(): PartUiState {
  return { menuRequest: null, deletePlan: null, deleting: false };
}

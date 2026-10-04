import type { FactConsistencyPlan } from "../../../client/fact-consistency-api.js";
import type { FactConsistencyRun, FactConsistencyScope } from "../../../shared/fact-consistency-contract.js";

/**
 * The Fact consistency check (#409 step 10h). A check goes through three
 * steps: the writer confirms what it will do (`confirm`), it runs (`running`,
 * a provider call that cannot be stopped, so it holds the story like any
 * other run), and its findings are kept (`findings`) for the panel's
 * Findings view. The last run of a story is stored by the backend; `findings`
 * only holds the copy this tab loaded.
 */
export interface FactCheckConfirm {
  readonly storyId: string;
  readonly focusedPartId: string;
  readonly scope: FactConsistencyScope;
  /** `null` while the backend counts the parts and requests. */
  readonly plan: FactConsistencyPlan | null;
  /** Tells a late plan answer that its confirmation is gone. */
  readonly serial: number;
}

export interface FactCheckRunning {
  readonly storyId: string;
  readonly storyTitle: string;
}

export interface FactCheckFindings {
  readonly storyId: string;
  readonly run: FactConsistencyRun;
}

export interface FactCheckState {
  readonly confirm: FactCheckConfirm | null;
  readonly running: FactCheckRunning | null;
  readonly findings: FactCheckFindings | null;
}

export function initialFactCheckState(): FactCheckState {
  return { confirm: null, running: null, findings: null };
}

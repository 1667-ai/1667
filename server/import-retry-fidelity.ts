import { countNoun, lossLines, type LossPhrases } from "../shared/fidelity.js";

export interface RetryHistoryCounters {
  readonly imported: number;
  readonly notAdditive: number;
  readonly malformed: number;
  readonly budgetHit: boolean;
}

type RetryHistoryOutcome = "imported" | "notAdditive" | "malformed" | "budgetHit";

const RETRY_HISTORY_PHRASES: LossPhrases<RetryHistoryOutcome> = {
  imported: (count) => `${count} ${countNoun(count, "retry", "retries")} imported as unselected takes`,
  notAdditive: (count) =>
    `${count} retry ${countNoun(count, "branch", "branches")} omitted: not a simple continuation`,
  malformed: (count) => `${count} retry ${countNoun(count, "branch", "branches")} omitted: malformed`,
  budgetHit: () => "retry takes stopped: story is at the part or text limit"
};

export function retryHistoryFidelity(counters: RetryHistoryCounters): string[] {
  return lossLines(outcomes(counters), RETRY_HISTORY_PHRASES);
}

function* outcomes(counters: RetryHistoryCounters): Generator<RetryHistoryOutcome> {
  const counted: readonly [RetryHistoryOutcome, number][] = [
    ["imported", counters.imported],
    ["notAdditive", counters.notAdditive],
    ["malformed", counters.malformed]
  ];
  for (const [outcome, count] of counted) {
    for (let index = 0; index < count; index += 1) yield outcome;
  }
  if (counters.budgetHit) yield "budgetHit";
}

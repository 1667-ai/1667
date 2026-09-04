import type { FactConsistencyFinding } from "../../shared/fact-consistency-types.js";
import type { FactConsistencyEvalCase } from "./fixture.js";

export interface FactConsistencyEvalScore {
  readonly found: number;
  readonly missed: number;
  readonly unexpected: number;
  readonly dropped: number;
}

export function scoreFactConsistencyCase(
  fixture: FactConsistencyEvalCase,
  findings: readonly FactConsistencyFinding[],
  dropped: number
): FactConsistencyEvalScore {
  const expected = new Set(fixture.expectedFactIds);
  const reported = new Set(findings.map((finding) => finding.fact_id));
  let found = 0;
  for (const factId of expected) {
    if (reported.has(factId)) found += 1;
  }
  let unexpected = 0;
  for (const factId of reported) {
    if (!expected.has(factId)) unexpected += 1;
  }
  return {
    found,
    missed: expected.size - found,
    unexpected,
    dropped
  };
}

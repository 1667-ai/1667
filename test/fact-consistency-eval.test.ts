import assert from "node:assert/strict";
import test from "node:test";
import { FACT_CONSISTENCY_EVAL_CASES } from "../evals/fact-consistency/fixture.js";
import { scoreFactConsistencyCase } from "../evals/fact-consistency/scoring.js";

test("Fact consistency evaluation counts found, missed, unexpected, and dropped findings", () => {
  const fixture = FACT_CONSISTENCY_EVAL_CASES[1]!;
  assert.deepEqual(scoreFactConsistencyCase(fixture, [
    { fact_id: "rank", quote: "Lieutenant Iven", statement: "Rank mismatch." },
    { fact_id: "eyes", quote: "Iven", statement: "Unexpected report." }
  ], 3), {
    found: 1,
    missed: 1,
    unexpected: 1,
    dropped: 3
  });
});

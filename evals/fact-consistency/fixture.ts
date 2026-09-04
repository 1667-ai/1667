import type { FactConsistencyPartSelection } from "../../shared/fact-consistency-types.js";

export interface FactConsistencyEvalCase {
  readonly id: string;
  readonly part: FactConsistencyPartSelection;
  readonly expectedFactIds: readonly string[];
}

const FACTS = [
  {
    factId: "eyes",
    name: "Mara's eye color",
    tag: "people",
    stateId: "eyes-1",
    text: "Mara has blue eyes."
  },
  {
    factId: "rank",
    name: "Iven's rank",
    tag: "people",
    stateId: "rank-1",
    text: "Iven is a captain."
  },
  {
    factId: "gate",
    name: "Meeting gate",
    tag: "places",
    stateId: "gate-1",
    text: "The meeting is at the north gate."
  }
] as const;

/** Frozen planted contradictions for model comparisons. */
export const FACT_CONSISTENCY_EVAL_CASES: readonly FactConsistencyEvalCase[] = [
  {
    id: "eye-color",
    part: {
      partId: "eval-eye-color",
      takeId: "eval-eye-color",
      text: "Mara narrowed her green eyes at the sealed letter.",
      facts: FACTS
    },
    expectedFactIds: ["eyes"]
  },
  {
    id: "rank-and-place",
    part: {
      partId: "eval-rank-place",
      takeId: "eval-rank-place",
      text: "Lieutenant Iven ordered the riders to meet at the south gate.",
      facts: FACTS
    },
    expectedFactIds: ["rank", "gate"]
  },
  {
    id: "consistent-control",
    part: {
      partId: "eval-control",
      takeId: "eval-control",
      text: "Captain Iven found Mara's blue eyes waiting at the north gate.",
      facts: FACTS
    },
    expectedFactIds: []
  }
];

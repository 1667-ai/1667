import assert from "node:assert/strict";
import test from "node:test";
import { selectFactsWithinBudget } from "../shared/fact-budget.js";
import type { StoryFact } from "../shared/types.js";

const NOW = "2026-01-01T00:00:00.000Z";

test("fact budget drops a Fact over its own cap regardless of the available budget", () => {
  const facts = [
    fact({ id: "capped", text: "x".repeat(40), budgetTokens: 1 }),
    fact({ id: "uncapped", text: "short" })
  ];
  const selection = selectFactsWithinBudget(facts, null);
  assert.deepEqual(selection.kept.map((candidate) => candidate.id), ["uncapped"]);
  assert.deepEqual(selection.dropped, [{ factId: "capped", reason: "fact-budget" }]);
});

test("fact budget keeps every candidate, in order, once nothing needs shedding", () => {
  const facts = [fact({ id: "a", text: "one" }), fact({ id: "b", text: "two" })];
  const selection = selectFactsWithinBudget(facts, 1_000);
  assert.deepEqual(selection.kept, facts);
  assert.deepEqual(selection.dropped, []);
});

test("fact budget sheds low priority before normal, and normal before high", () => {
  const facts = [
    fact({ id: "high", text: "x".repeat(40), activation: "keyed", keys: ["x"], priority: "high" }),
    fact({ id: "normal", text: "x".repeat(40), activation: "keyed", keys: ["x"] }),
    fact({ id: "low", text: "x".repeat(40), activation: "keyed", keys: ["x"], priority: "low" })
  ];
  // Room for exactly one of the three (~10 tokens each at 4 chars/token).
  const selection = selectFactsWithinBudget(facts, 12);
  assert.deepEqual(selection.kept.map((candidate) => candidate.id), ["high"]);
  assert.deepEqual(
    selection.dropped.map((drop) => drop.factId).sort(),
    ["low", "normal"]
  );
});

test("fact budget sheds keyed before always within the same priority", () => {
  const facts = [
    fact({ id: "always", text: "x".repeat(40) }),
    fact({ id: "keyed", text: "x".repeat(40), activation: "keyed", keys: ["x"] })
  ];
  const selection = selectFactsWithinBudget(facts, 12);
  assert.deepEqual(selection.kept.map((candidate) => candidate.id), ["always"]);
  assert.deepEqual(selection.dropped, [{ factId: "keyed", reason: "total-budget" }]);
});

test("fact budget's final tiebreak sheds the later emit position first", () => {
  const facts = [
    fact({ id: "earlier", text: "x".repeat(40), activation: "keyed", keys: ["x"] }),
    fact({ id: "later", text: "x".repeat(40), activation: "keyed", keys: ["x"] })
  ];
  const selection = selectFactsWithinBudget(facts, 12);
  assert.deepEqual(selection.kept.map((candidate) => candidate.id), ["earlier"]);
  assert.deepEqual(selection.dropped, [{ factId: "later", reason: "total-budget" }]);
});

test("fact budget exempts always Facts at normal or high priority from shedding", () => {
  // Two always Facts, both exempt: even wildly over budget, neither can go,
  // so the selection stays over budget rather than dropping an exempt Fact.
  const facts = [
    fact({ id: "one", text: "x".repeat(200) }),
    fact({ id: "two", text: "x".repeat(200), priority: "high" })
  ];
  const selection = selectFactsWithinBudget(facts, 10);
  assert.deepEqual(selection.kept, facts);
  assert.deepEqual(selection.dropped, []);
});

test("fact budget treats an always Fact ranked low as a deliberate opt-out", () => {
  const facts = [
    fact({ id: "exempt", text: "kept" }),
    fact({ id: "opted-out", text: "x".repeat(200), activation: "always", priority: "low" })
  ];
  const selection = selectFactsWithinBudget(facts, 10);
  assert.deepEqual(selection.kept.map((candidate) => candidate.id), ["exempt"]);
  assert.deepEqual(selection.dropped, [{ factId: "opted-out", reason: "total-budget" }]);
});

test("fact budget labels space-driven drops with the caller's reason", () => {
  const facts = [fact({ id: "shed-me", text: "x".repeat(200), activation: "keyed", keys: ["x"] })];
  const selection = selectFactsWithinBudget(facts, 1, { spaceDropReason: "priority" });
  assert.deepEqual(selection.dropped, [{ factId: "shed-me", reason: "priority" }]);
});

test("fact budget judges a Fact's own cap by the canonical estimator, never the caller's space estimator", () => {
  // Review finding C: a Fact's own budgetTokens cap must read the same way
  // everywhere the writer sees an estimate (rail, meter, docs) — ceil(chars
  // / 4) — even when the caller measuring space against a window passes a
  // different, more conservative estimator for that separate purpose. A
  // 100-character CJK Fact with a 50-token budget scores 25 under the
  // canonical estimator (kept) and 200 under an estimator that doubles
  // non-ASCII text — the two must not disagree about which one applies to
  // the Fact's own cap.
  const cjk = fact({ id: "cjk", text: "玲".repeat(100), budgetTokens: 50 });
  const conservativeNonAsciiDoubling = (candidate: StoryFact): number => {
    let ascii = 0;
    let wide = 0;
    for (const char of candidate.text) {
      if (char.charCodeAt(0) < 128) ascii += 1;
      else wide += 1;
    }
    return Math.ceil(ascii / 4) + wide * 2;
  };
  const selection = selectFactsWithinBudget([cjk], 1_000_000, {
    estimateFactTokens: conservativeNonAsciiDoubling
  });
  assert.deepEqual(selection.dropped, []);
  assert.deepEqual(selection.kept, [cjk]);
});

function fact(overrides: Partial<StoryFact> & Pick<StoryFact, "id" | "text">): StoryFact {
  return {
    tag: null,
    activation: "always",
    keys: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

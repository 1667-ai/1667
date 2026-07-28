import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertWithinBudget, budgetTimeout, cpuBudget, startTiming } from "./performance-budget.js";
import { parseMutationLedgerRecordText } from "../server/mutation-ledger-codec.js";
import { parseMutationLedgerSegments, userMutationLedgerSegments } from "../server/mutation-ledger-paths.js";
import { planMutationLedgerRecovery } from "../server/mutation-ledger-recovery.js";
import type { PreparedRecord } from "../server/mutation-ledger-types.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const corpus = JSON.parse(readFileSync(path.join(ROOT, "schema", "mutation-ledger.corpus.json"), "utf8")) as {
  cases: Array<{ name: string; text: string }>;
};
const text = corpus.cases.find(({ name }) => name === "prepared-story-local")!.text;
const prepared = parseMutationLedgerRecordText(text) as PreparedRecord;
const preparedState = prepared.result;
if (preparedState.kind !== "story") throw new Error("Performance fixture must contain a story result");
const recoveryState = {
  ...preparedState,
  previousManifestHash: prepared.oldStateHash === "absent" ? null : prepared.oldStateHash
};
const MUTATION = prepared.key;
const HASH_B = "b".repeat(64);
const NOW = "2026-01-01T00:00:00.000Z";
// One budget per subtest, named for what it bounds.
const BUDGETS = {
  recordParses: cpuBudget(15_000),
  pathMapping: cpuBudget(15_000),
  recoveryPlans: cpuBudget(15_000)
} as const;

test("mutation ledger pure operations stay comfortably bounded", { concurrency: 1, timeout: budgetTimeout(Object.values(BUDGETS)) }, async (t) => {
  await t.test("20,000 strict canonical record parses", (context) => {
    const iterations = 20_000;
    const read = startTiming();
    let parsed = 0;
    for (let index = 0; index < iterations; index += 1) {
      if (parseMutationLedgerRecordText(text).kind === "prepared") parsed += 1;
    }
    const timing = read();
    assert.equal(parsed, iterations);
    assertWithinBudget(context, `${iterations.toLocaleString()} record parses`, BUDGETS.recordParses, timing);
  });

  await t.test("50,000 path builds and direct identity parses", (context) => {
    const iterations = 50_000;
    const read = startTiming();
    let parsed = 0;
    for (let index = 0; index < iterations; index += 1) {
      const segments = userMutationLedgerSegments("story:story-one", MUTATION);
      if (parseMutationLedgerSegments(segments, "story:story-one").kind === "user") parsed += 1;
    }
    const timing = read();
    assert.equal(parsed, iterations);
    assertWithinBudget(context, `${iterations.toLocaleString()} build/parse pairs`, BUDGETS.pathMapping, timing);
  });

  await t.test("5,000 constant-evidence recovery plans", (context) => {
    const iterations = 5_000;
    const evidence = {
      aggregateKey: "story:story-one" as const,
      aggregate: {
        stateHash: HASH_B,
        state: recoveryState,
        lastTransaction: { receiptKind: "user" as const, mutationId: MUTATION, phase: "prepared" as const },
        unresolvedProvider: null
      },
      transaction: {
        key: MUTATION,
        started: null,
        prepared,
        completed: null,
        replacement: null
      },
      unresolvedProvider: null,
      originalProvider: null,
      recoveredAt: NOW
    };
    const read = startTiming();
    let actions = 0;
    for (let index = 0; index < iterations; index += 1) {
      actions += planMutationLedgerRecovery(evidence).actions.length;
    }
    const timing = read();
    assert.equal(actions, iterations);
    assertWithinBudget(context, `${iterations.toLocaleString()} recovery plans`, BUDGETS.recoveryPlans, timing);
  });
});

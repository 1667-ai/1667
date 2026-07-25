import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

test("mutation ledger pure operations stay comfortably bounded", { concurrency: 1, timeout: 60_000 }, async (t) => {
  await t.test("20,000 strict canonical record parses", (context) => {
    const iterations = 20_000;
    const startedAt = performance.now();
    let parsed = 0;
    for (let index = 0; index < iterations; index += 1) {
      if (parseMutationLedgerRecordText(text).kind === "prepared") parsed += 1;
    }
    const elapsed = performance.now() - startedAt;
    context.diagnostic(`${iterations.toLocaleString()} parses in ${elapsed.toFixed(1)}ms`);
    assert.equal(parsed, iterations);
    assert.ok(elapsed < 15_000, `record parsing took ${elapsed.toFixed(1)}ms`);
  });

  await t.test("50,000 path builds and direct identity parses", (context) => {
    const iterations = 50_000;
    const startedAt = performance.now();
    let parsed = 0;
    for (let index = 0; index < iterations; index += 1) {
      const segments = userMutationLedgerSegments("story:story-one", MUTATION);
      if (parseMutationLedgerSegments(segments, "story:story-one").kind === "user") parsed += 1;
    }
    const elapsed = performance.now() - startedAt;
    context.diagnostic(`${iterations.toLocaleString()} build/parse pairs in ${elapsed.toFixed(1)}ms`);
    assert.equal(parsed, iterations);
    assert.ok(elapsed < 15_000, `path mapping took ${elapsed.toFixed(1)}ms`);
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
    const startedAt = performance.now();
    let actions = 0;
    for (let index = 0; index < iterations; index += 1) {
      actions += planMutationLedgerRecovery(evidence).actions.length;
    }
    const elapsed = performance.now() - startedAt;
    context.diagnostic(`${iterations.toLocaleString()} recovery plans in ${elapsed.toFixed(1)}ms`);
    assert.equal(actions, iterations);
    assert.ok(elapsed < 15_000, `recovery planning took ${elapsed.toFixed(1)}ms`);
  });
});

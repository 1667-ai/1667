import assert from "node:assert/strict";
import test from "node:test";
import {
  hashPreparedMutationRecord,
  hashStartedMutationRecord
} from "../server/mutation-ledger-codec.js";
import {
  MutationLedgerRecoveryError,
  planMutationLedgerRecovery
} from "../server/mutation-ledger-recovery.js";
import {
  HASH_A,
  HASH_B,
  HASH_C,
  M1,
  M2,
  M3,
  acknowledgedFor,
  acknowledgementPrepared,
  aggregate,
  completedFor,
  createPrepared,
  evidence,
  localPrepared,
  migrationPrepared,
  parse,
  providerEvidence,
  providerPrepared,
  receiptOnlyPrepared,
  settingsPrepared,
  settingsReceiptOnlyPrepared,
  settingsState,
  stateForPrepared,
  storyState,
  started
} from "./mutation-ledger-recovery-fixtures.js";

test("old state discards unreferenced started, prepared, and replacement evidence", () => {
  const local = localPrepared(M2, HASH_A, HASH_B);
  let plan = planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(HASH_A),
    prepared: local,
    replacement: { stateHash: HASH_B, oldStateHash: HASH_A, state: stateForPrepared(local)! }
  }));
  assert.deepEqual(plan.actions.map((action) => action.kind), ["discard-replacement", "discard-record"]);

  plan = planMutationLedgerRecovery(evidence({
    key: M1,
    aggregate: aggregate(HASH_A),
    started: started()
  }));
  assert.deepEqual(plan.actions, [{ kind: "discard-record", key: M1, recordKind: "started" }]);

  plan = planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(HASH_A),
    replacement: { stateHash: HASH_B, oldStateHash: HASH_A, state: storyState() }
  }));
  assert.deepEqual(plan.actions, [{ kind: "discard-replacement", key: M2 }]);
});

test("aggregate pointing at matching prepared creates one missing completed record", () => {
  const prepared = localPrepared(M2, HASH_A, HASH_B);
  const plan = planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(HASH_B, { receiptKind: "user", mutationId: M2, phase: "prepared" }),
    prepared
  }));
  assert.equal(plan.actions.length, 1);
  const action = plan.actions[0]!;
  assert.equal(action.kind, "write-completed");
  if (action.kind !== "write-completed") assert.fail("Expected completed action");
  assert.equal(action.record.preparedRecordHash, hashPreparedMutationRecord(prepared));
});

test("receipt-only deterministic error finalizes without aggregate pointer or replacement", () => {
  const prepared = receiptOnlyPrepared(M2);
  const plan = planMutationLedgerRecovery(evidence({ key: M2, aggregate: aggregate(HASH_A), prepared }));
  assert.deepEqual(plan.actions.map((action) => action.kind), ["write-completed"]);
});

test("matching unresolved started remains provider-unknown after a later local transaction", () => {
  const provider = providerEvidence();
  const prepared = localPrepared(M2, HASH_B, HASH_C);
  const completed = completedFor(prepared);
  const plan = planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(
      HASH_C,
      { receiptKind: "user", mutationId: M2, phase: "prepared" },
      { mutationId: M1, fingerprintHash: HASH_A },
      stateForPrepared(prepared)
    ),
    prepared,
    completed,
    unresolvedProvider: provider
  }));
  assert.deepEqual(plan.actions, [{
    kind: "report-provider-outcome",
    mutationId: M1,
    outcome: "generation-outcome-unknown"
  }]);
});

test("provider terminal prepared before state replacement is discarded while ambiguity is retained", () => {
  const provider = providerEvidence();
  const prepared = providerPrepared();
  const plan = planMutationLedgerRecovery(evidence({
    key: M1,
    aggregate: aggregate(
      HASH_B,
      { receiptKind: "user", mutationId: M1, phase: "started" },
      { mutationId: M1, fingerprintHash: HASH_A }
    ),
    started: provider.started,
    prepared,
    replacement: { stateHash: HASH_C, oldStateHash: HASH_B, state: stateForPrepared(prepared)! },
    unresolvedProvider: provider
  }));
  assert.deepEqual(plan.actions, [
    { kind: "report-provider-outcome", mutationId: M1, outcome: "generation-outcome-unknown" },
    { kind: "discard-replacement", key: M1 },
    { kind: "discard-record", key: M1, recordKind: "prepared" }
  ]);
});

test("provider replacement written before prepared is discarded without losing unknown-outcome evidence", () => {
  const provider = providerEvidence();
  const terminal = providerPrepared();
  const plan = planMutationLedgerRecovery(evidence({
    key: M1,
    aggregate: aggregate(
      HASH_B,
      { receiptKind: "user", mutationId: M1, phase: "started" },
      { mutationId: M1, fingerprintHash: HASH_A }
    ),
    started: provider.started,
    replacement: { stateHash: HASH_C, oldStateHash: HASH_B, state: stateForPrepared(terminal)! },
    unresolvedProvider: provider
  }));
  assert.deepEqual(plan.actions, [
    { kind: "report-provider-outcome", mutationId: M1, outcome: "generation-outcome-unknown" },
    { kind: "discard-replacement", key: M1 }
  ]);
});

test("committed acknowledgement requests original acknowledged then acknowledgement completed", () => {
  const original = providerEvidence();
  const prepared = acknowledgementPrepared(original.started);
  const plan = planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(
      HASH_C,
      { receiptKind: "user", mutationId: M2, phase: "prepared" },
      null,
      stateForPrepared(prepared)
    ),
    prepared,
    originalProvider: original
  }));
  assert.deepEqual(plan.actions.map((action) => action.kind), ["write-acknowledged", "write-completed"]);
  const acknowledgement = plan.actions[0];
  assert.ok(acknowledgement?.kind === "write-acknowledged");
  assert.equal(acknowledgement.record.startedRecordHash, hashStartedMutationRecord(original.started));
  assert.equal(acknowledgement.record.acknowledgementPreparedHash, hashPreparedMutationRecord(prepared));
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(
      HASH_C,
      { receiptKind: "user", mutationId: M2, phase: "prepared" },
      null,
      stateForPrepared(prepared)
    ),
    prepared
  })), MutationLedgerRecoveryError);
});

test("partial acknowledgement terminal records recover idempotently in order", () => {
  const original = providerEvidence();
  const prepared = acknowledgementPrepared(original.started);
  const acknowledged = acknowledgedFor(prepared, original.started);
  const partial = planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(
      HASH_C,
      { receiptKind: "user", mutationId: M2, phase: "prepared" },
      null,
      stateForPrepared(prepared)
    ),
    prepared,
    originalProvider: { ...original, acknowledged }
  }));
  assert.deepEqual(partial.actions.map((action) => action.kind), ["write-completed"]);

  const complete = planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(
      HASH_C,
      { receiptKind: "user", mutationId: M2, phase: "prepared" },
      null,
      stateForPrepared(prepared)
    ),
    prepared,
    completed: completedFor(prepared),
    originalProvider: { ...original, acknowledged }
  }));
  assert.deepEqual(complete.actions, []);

  const collectedOriginal = planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(
      HASH_C,
      { receiptKind: "user", mutationId: M2, phase: "prepared" },
      null,
      stateForPrepared(prepared)
    ),
    prepared,
    completed: completedFor(prepared)
  }));
  assert.deepEqual(collectedOriginal.actions, []);
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(
      HASH_C,
      { receiptKind: "user", mutationId: M2, phase: "prepared" },
      null,
      stateForPrepared(prepared)
    ),
    prepared,
    completed: completedFor(prepared),
    originalProvider: original
  })), MutationLedgerRecoveryError);
});

test("terminal normal, receipt-only, and acknowledgement receipts survive later aggregate revisions", () => {
  const normal = localPrepared(M2, HASH_A, HASH_B);
  const laterNormal = aggregate(
    "4".repeat(64),
    { receiptKind: "user", mutationId: M3, phase: "prepared" },
    null,
    { ...storyState(HASH_B), storyRevision: "00000000000000000003" }
  );
  assert.deepEqual(planMutationLedgerRecovery(evidence({
    key: M2, aggregate: laterNormal, prepared: normal, completed: completedFor(normal)
  })).actions, []);

  const rejected = receiptOnlyPrepared(M2);
  const laterRejected = aggregate(
    "4".repeat(64),
    { receiptKind: "user", mutationId: M3, phase: "prepared" },
    null,
    { ...storyState(HASH_A), storyRevision: "00000000000000000003" }
  );
  assert.deepEqual(planMutationLedgerRecovery(evidence({
    key: M2, aggregate: laterRejected, prepared: rejected, completed: completedFor(rejected)
  })).actions, []);

  const original = providerEvidence();
  const ack = acknowledgementPrepared(original.started, "live");
  const acknowledged = acknowledgedFor(ack, original.started);
  const laterAcknowledgement = aggregate(
    "4".repeat(64),
    { receiptKind: "user", mutationId: M3, phase: "prepared" },
    null,
    { ...storyState(HASH_C), storyRevision: "00000000000000000003" }
  );
  assert.deepEqual(planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: laterAcknowledgement,
    prepared: ack,
    completed: completedFor(ack),
    originalProvider: { ...original, acknowledged }
  })).actions, []);
  assert.deepEqual(planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: laterAcknowledgement,
    prepared: ack,
    completed: completedFor(ack)
  })).actions, []);
});

test("settings terminal receipt survives ADR003 pointer-preserving internal state transitions", () => {
  const prepared = settingsPrepared(M2, HASH_A, HASH_B);
  const plan = planMutationLedgerRecovery(evidence({
    aggregateKey: "settings",
    key: M2,
    aggregate: aggregate(
      HASH_C,
      { receiptKind: "user", mutationId: M2, phase: "prepared" },
      null,
      settingsState(3)
    ),
    prepared,
    completed: completedFor(prepared)
  }));
  assert.deepEqual(plan.actions, []);
});

test("settings user, receipt-only, and internal Fm1 recovery cover both commit sides", () => {
  const settings = settingsPrepared(M2, HASH_A, HASH_B);
  let plan = planMutationLedgerRecovery(evidence({
    aggregateKey: "settings",
    key: M2,
    aggregate: aggregate(
      HASH_B,
      { receiptKind: "user", mutationId: M2, phase: "prepared" },
      null,
      stateForPrepared(settings)
    ),
    prepared: settings
  }));
  assert.deepEqual(plan.actions.map((action) => action.kind), ["write-completed"]);

  const rejected = settingsReceiptOnlyPrepared(M2);
  plan = planMutationLedgerRecovery(evidence({
    aggregateKey: "settings",
    key: M2,
    aggregate: aggregate(HASH_A, null, null, stateForPrepared(rejected)),
    prepared: rejected
  }));
  assert.deepEqual(plan.actions.map((action) => action.kind), ["write-completed"]);

  const internal = migrationPrepared();
  plan = planMutationLedgerRecovery(evidence({
    aggregateKey: "settings",
    key: internal.key,
    aggregate: aggregate(HASH_A, null, null, settingsState(1)),
    prepared: internal,
    replacement: { stateHash: HASH_B, oldStateHash: HASH_A, state: settingsState() }
  }));
  assert.deepEqual(plan.actions.map((action) => action.kind), ["discard-replacement", "discard-record"]);

  plan = planMutationLedgerRecovery(evidence({
    aggregateKey: "settings",
    key: internal.key,
    aggregate: aggregate(
      HASH_B,
      { receiptKind: "format-migration-v1", key: internal.key, phase: "prepared" },
      null,
      settingsState()
    ),
    prepared: internal
  }));
  assert.deepEqual(plan.actions.map((action) => action.kind), ["write-completed"]);
});

test("absent create/import prepared evidence discards before commit and completes after commit", () => {
  for (const method of ["createStory", "importSillyTavern", "importMarkdown", "importNovelAI"] as const) {
    const prepared = createPrepared(method);
    let plan = planMutationLedgerRecovery(evidence({
      aggregateKey: prepared.aggregateKey,
      key: M2,
      aggregate: aggregate("absent"),
      prepared,
      replacement: { stateHash: HASH_A, oldStateHash: "absent", state: stateForPrepared(prepared)! }
    }));
    assert.deepEqual(plan.actions.map((action) => action.kind), ["discard-replacement", "discard-record"]);
    plan = planMutationLedgerRecovery(evidence({
      aggregateKey: prepared.aggregateKey,
      key: M2,
      aggregate: aggregate(
        HASH_A,
        { receiptKind: "user", mutationId: M2, phase: "prepared" },
        null,
        stateForPrepared(prepared)
      ),
      prepared
    }));
    assert.deepEqual(plan.actions.map((action) => action.kind), ["write-completed"]);
  }
});

test("mismatches, acknowledgement-before-clear, and stale hashes fail closed", () => {
  const local = localPrepared(M2, HASH_A, HASH_B);
  const strayStarted = parse({ ...started(), mutationId: M2 }, "started");
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(HASH_A),
    started: strayStarted,
    prepared: receiptOnlyPrepared(M2)
  })), MutationLedgerRecoveryError);

  const internal = migrationPrepared();
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: internal.key,
    aggregate: aggregate(HASH_A, null, null, settingsState(1)),
    replacement: { stateHash: HASH_B, oldStateHash: HASH_A, state: settingsState() }
  })), MutationLedgerRecoveryError);
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(HASH_A),
    replacement: { stateHash: HASH_A, oldStateHash: HASH_A, state: storyState() }
  })), MutationLedgerRecoveryError);

  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(HASH_B, { receiptKind: "user", mutationId: M2, phase: "prepared" }),
    prepared: local,
    completed: { ...completedFor(local), preparedRecordHash: HASH_C }
  })), MutationLedgerRecoveryError);

  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(HASH_C, { receiptKind: "user", mutationId: M2, phase: "prepared" }),
    prepared: local,
    completed: completedFor(local)
  })), MutationLedgerRecoveryError);

  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(HASH_B, { receiptKind: "user", mutationId: M2, phase: "prepared" }),
    prepared: local,
    completed: completedFor(local),
    replacement: { stateHash: HASH_B, oldStateHash: HASH_A, state: stateForPrepared(local)! }
  })), MutationLedgerRecoveryError);

  const original = providerEvidence();
  const ack = acknowledgementPrepared(original.started);
  const acknowledged = acknowledgedFor(ack, original.started);
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(
      HASH_B,
      { receiptKind: "user", mutationId: M1, phase: "started" },
      { mutationId: M1, fingerprintHash: HASH_A }
    ),
    unresolvedProvider: { ...original, acknowledged }
  })), MutationLedgerRecoveryError);

  const divergentStarted = parse({ ...original.started, fingerprintHash: HASH_B }, "started");
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(
      HASH_B,
      { receiptKind: "user", mutationId: M1, phase: "started" },
      { mutationId: M1, fingerprintHash: HASH_A }
    ),
    unresolvedProvider: original,
    originalProvider: { started: divergentStarted, acknowledged: null }
  })), MutationLedgerRecoveryError);

  const acknowledgedLater = { ...acknowledged, acknowledgedAt: "2026-01-01T00:00:00.001Z" };
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(
      HASH_B,
      { receiptKind: "user", mutationId: M1, phase: "started" },
      { mutationId: M1, fingerprintHash: HASH_A }
    ),
    unresolvedProvider: { ...original, acknowledged },
    originalProvider: { ...original, acknowledged: acknowledgedLater }
  })), MutationLedgerRecoveryError);

  const rejected = receiptOnlyPrepared(M2);
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(HASH_A, { receiptKind: "user", mutationId: M2, phase: "prepared" }),
    prepared: rejected,
    completed: completedFor(rejected)
  })), MutationLedgerRecoveryError);

  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(HASH_C),
    prepared: local,
    replacement: { stateHash: HASH_B, oldStateHash: HASH_A, state: stateForPrepared(local)! }
  })), MutationLedgerRecoveryError);

  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(HASH_C, { receiptKind: "user", mutationId: M2, phase: "prepared" }),
    prepared: { ...ack, originalStartedRecordHash: HASH_C },
    originalProvider: original
  })), MutationLedgerRecoveryError);

  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M1,
    aggregate: aggregate(HASH_C, { receiptKind: "user", mutationId: M1, phase: "prepared" }),
    prepared: providerPrepared()
  })), MutationLedgerRecoveryError);
});

import assert from "node:assert/strict";
import test from "node:test";
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
  deletePrepared,
  evidence,
  localPrepared,
  parse,
  providerEvidence,
  providerPrepared,
  receiptOnlyPrepared,
  settingsPrepared,
  settingsState,
  stateForPrepared,
  storyState,
  started,
  v5RootState
} from "./mutation-ledger-recovery-fixtures.js";

test("typed aggregate and replacement projections bind exact durable results", () => {
  const receiptOnly = receiptOnlyPrepared(M2);
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(HASH_A, null, null, {
      ...storyState(),
      storyRevision: "00000000000000000003"
    }),
    prepared: receiptOnly
  })), MutationLedgerRecoveryError);

  const local = localPrepared(M2, HASH_A, HASH_B);
  const live = storyState();
  assert.ok(live.summary !== null);
  const drifted = { ...live, summary: { ...live.summary, title: "Drifted" } };
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(
      HASH_B,
      { receiptKind: "user", mutationId: M2, phase: "prepared" },
      null,
      drifted
    ),
    prepared: local
  })), MutationLedgerRecoveryError);
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(HASH_A),
    prepared: local,
    replacement: { stateHash: HASH_B, oldStateHash: HASH_A, state: drifted }
  })), MutationLedgerRecoveryError);

  const original = providerEvidence();
  const acknowledgement = acknowledgementPrepared(original.started);
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(
      HASH_C,
      { receiptKind: "user", mutationId: M2, phase: "prepared" },
      null,
      storyState()
    ),
    prepared: acknowledgement,
    originalProvider: original
  })), MutationLedgerRecoveryError);

  const settings = settingsPrepared(M2, HASH_A, HASH_B);
  assert.throws(() => planMutationLedgerRecovery(evidence({
    aggregateKey: "settings",
    key: M2,
    aggregate: aggregate(HASH_A, null, null, settingsState(1)),
    prepared: settings,
    replacement: { stateHash: HASH_B, oldStateHash: HASH_A, state: settingsState(3) }
  })), MutationLedgerRecoveryError);
  for (const [stateHash, state] of [
    [HASH_A, settingsState(1)],
    [HASH_C, settingsState(2)]
  ] as const) assert.throws(() => planMutationLedgerRecovery(evidence({
    aggregateKey: "settings",
    key: M2,
    aggregate: aggregate(stateHash, null, null, state),
    prepared: settings,
    completed: completedFor(settings)
  })), MutationLedgerRecoveryError);
  assert.throws(() => planMutationLedgerRecovery(evidence({
    aggregateKey: "settings",
    key: M2,
    aggregate: aggregate("absent"),
    prepared: settings,
    completed: completedFor(settings)
  })), MutationLedgerRecoveryError);
});

test("story recovery binds V6 predecessors and deleted-state pointer legality", () => {
  const provider = providerEvidence();
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M1,
    aggregate: aggregate(
      HASH_A,
      { receiptKind: "user", mutationId: M1, phase: "started" },
      { mutationId: M1, fingerprintHash: HASH_A },
      storyState(HASH_A)
    ),
    started: provider.started,
    unresolvedProvider: provider
  })), MutationLedgerRecoveryError);
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M1,
    aggregate: aggregate(
      HASH_B,
      { receiptKind: "user", mutationId: M1, phase: "started" },
      { mutationId: M1, fingerprintHash: HASH_A },
      storyState(HASH_C)
    ),
    started: provider.started,
    unresolvedProvider: provider
  })), MutationLedgerRecoveryError);

  const local = localPrepared(M2, HASH_A, HASH_B);
  const localState = stateForPrepared(local);
  assert.ok(localState?.kind === "story");
  const wrongPredecessor = { ...localState, previousManifestHash: HASH_C };
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(
      HASH_B,
      { receiptKind: "user", mutationId: M2, phase: "prepared" },
      null,
      wrongPredecessor
    ),
    prepared: local
  })), MutationLedgerRecoveryError);
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(HASH_A),
    prepared: local,
    replacement: { stateHash: HASH_B, oldStateHash: HASH_A, state: wrongPredecessor }
  })), MutationLedgerRecoveryError);

  const deleted = { ...storyState(), summary: null };
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(HASH_B, null, null, deleted)
  })), MutationLedgerRecoveryError);
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M1,
    aggregate: aggregate(
      HASH_B,
      { receiptKind: "user", mutationId: M1, phase: "started" },
      { mutationId: M1, fingerprintHash: HASH_A },
      deleted
    ),
    started: provider.started,
    unresolvedProvider: provider
  })), MutationLedgerRecoveryError);
});

test("committed create/import state cannot carry an unresolved provider", () => {
  const prepared = createPrepared("createStory");
  const aggregateKey = prepared.aggregateKey;
  assert.notEqual(aggregateKey, "settings");
  const providerStarted = parse({ ...started(), aggregateKey, mutationId: M3 }, "started");
  const provider = { started: providerStarted, acknowledged: null };
  assert.throws(() => planMutationLedgerRecovery(evidence({
    aggregateKey,
    key: M2,
    aggregate: aggregate(
      HASH_A,
      { receiptKind: "user", mutationId: M2, phase: "prepared" },
      { mutationId: M3, fingerprintHash: HASH_A },
      stateForPrepared(prepared)
    ),
    prepared,
    unresolvedProvider: provider
  })), MutationLedgerRecoveryError);
});

test("global started pointers and committed provider-clearing transitions fail closed", () => {
  const original = providerEvidence();
  const otherStarted = parse({ ...original.started, mutationId: M3 }, "started");
  const other = { started: otherStarted, acknowledged: null };
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(
      HASH_B,
      { receiptKind: "user", mutationId: M1, phase: "started" },
      { mutationId: M3, fingerprintHash: HASH_A }
    ),
    unresolvedProvider: other
  })), MutationLedgerRecoveryError);
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(HASH_B, { receiptKind: "user", mutationId: M1, phase: "started" })
  })), MutationLedgerRecoveryError);

  const terminal = providerPrepared();
  for (const completed of [undefined, completedFor(terminal)]) {
    assert.throws(() => planMutationLedgerRecovery(evidence({
      key: M1,
      aggregate: aggregate(
        HASH_C,
        { receiptKind: "user", mutationId: M1, phase: "prepared" },
        { mutationId: M3, fingerprintHash: HASH_A },
        stateForPrepared(terminal)
      ),
      started: original.started,
      prepared: terminal,
      ...(completed === undefined ? {} : { completed }),
      unresolvedProvider: other
    })), MutationLedgerRecoveryError);
  }

  const acknowledgement = acknowledgementPrepared(original.started);
  const acknowledged = acknowledgedFor(acknowledgement, original.started);
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(
      HASH_C,
      { receiptKind: "user", mutationId: M2, phase: "prepared" },
      { mutationId: M3, fingerprintHash: HASH_A },
      stateForPrepared(acknowledgement)
    ),
    prepared: acknowledgement,
    completed: completedFor(acknowledgement),
    unresolvedProvider: other,
    originalProvider: { ...original, acknowledged }
  })), MutationLedgerRecoveryError);
});

test("completed acknowledgement clears only its original provider", () => {
  const original = providerEvidence();
  const acknowledgement = acknowledgementPrepared(original.started, "live");
  const deletedAcknowledgement = acknowledgementPrepared(original.started);
  const laterStateHash = "4".repeat(64);
  const laterState = {
    ...storyState(HASH_C),
    storyRevision: "00000000000000000003" as const
  };

  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(
      laterStateHash,
      { receiptKind: "user", mutationId: M3, phase: "prepared" },
      { mutationId: M1, fingerprintHash: HASH_A },
      laterState
    ),
    prepared: acknowledgement,
    completed: completedFor(acknowledgement),
    unresolvedProvider: original
  })), MutationLedgerRecoveryError);

  const laterStarted = parse({
    ...started(),
    mutationId: M3,
    oldStateHash: HASH_C
  }, "started");
  const laterProvider = { started: laterStarted, acknowledged: null };
  assert.deepEqual(planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(
      laterStateHash,
      { receiptKind: "user", mutationId: M3, phase: "started" },
      { mutationId: M3, fingerprintHash: HASH_A },
      laterState
    ),
    prepared: acknowledgement,
    completed: completedFor(acknowledgement),
    unresolvedProvider: laterProvider
  })).actions, [{
    kind: "report-provider-outcome",
    mutationId: M3,
    outcome: "generation-outcome-unknown"
  }]);
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(
      laterStateHash,
      { receiptKind: "user", mutationId: M3, phase: "started" },
      { mutationId: M3, fingerprintHash: HASH_A },
      laterState
    ),
    prepared: deletedAcknowledgement,
    completed: completedFor(deletedAcknowledgement),
    unresolvedProvider: laterProvider
  })), MutationLedgerRecoveryError);
});

test("completed story receipts require monotonic non-resurrecting lineage", () => {
  const local = localPrepared(M2, HASH_A, HASH_B);
  const completed = completedFor(local);
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(HASH_A, null, null, v5RootState()),
    prepared: local,
    completed
  })), MutationLedgerRecoveryError);
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(
      HASH_C,
      { receiptKind: "user", mutationId: M3, phase: "prepared" },
      null,
      storyState(HASH_A)
    ),
    prepared: local,
    completed
  })), MutationLedgerRecoveryError);

  const deletion = deletePrepared(M2, HASH_A, HASH_B);
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(
      HASH_C,
      { receiptKind: "user", mutationId: M3, phase: "prepared" },
      null,
      {
        ...storyState(HASH_B),
        storyRevision: "00000000000000000003"
      }
    ),
    prepared: deletion,
    completed: completedFor(deletion)
  })), MutationLedgerRecoveryError);
});

test("duplicate transaction and provider started evidence must be byte-identical", () => {
  const provider = providerEvidence();
  const divergent = parse({
    ...provider.started,
    createdAt: "2026-01-01T00:00:00.001Z"
  }, "started");

  for (const transactionStarted of [undefined, divergent]) {
    assert.throws(() => planMutationLedgerRecovery(evidence({
      key: M1,
      aggregate: aggregate(
        HASH_B,
        { receiptKind: "user", mutationId: M1, phase: "started" },
        { mutationId: M1, fingerprintHash: HASH_A },
        storyState(HASH_A)
      ),
      started: transactionStarted,
      unresolvedProvider: provider
    })), MutationLedgerRecoveryError);
    assert.throws(() => planMutationLedgerRecovery(evidence({
      key: M1,
      aggregate: aggregate(HASH_A),
      started: transactionStarted,
      originalProvider: provider
    })), MutationLedgerRecoveryError);
  }

  assert.deepEqual(planMutationLedgerRecovery(evidence({
    key: M1,
    aggregate: aggregate(
      HASH_B,
      { receiptKind: "user", mutationId: M1, phase: "started" },
      { mutationId: M1, fingerprintHash: HASH_A },
      storyState(HASH_A)
    ),
    started: provider.started,
    unresolvedProvider: provider
  })).actions.map((action) => action.kind), ["report-provider-outcome"]);
  assert.deepEqual(planMutationLedgerRecovery(evidence({
    key: M1,
    aggregate: aggregate(HASH_A),
    started: provider.started,
    originalProvider: provider
  })).actions, []);
});

test("provider terminal recovery requires the started edge and a live error state", () => {
  const provider = providerEvidence();
  const terminal = providerPrepared();
  const collapsedStartedEdge = parse({
    ...terminal,
    oldStateHash: provider.started.oldStateHash
  }, "prepared");
  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M1,
    aggregate: aggregate(
      HASH_C,
      { receiptKind: "user", mutationId: M1, phase: "prepared" },
      null,
      stateForPrepared(collapsedStartedEdge)
    ),
    started: provider.started,
    prepared: collapsedStartedEdge
  })), MutationLedgerRecoveryError);

  const terminalError = parse({
    ...terminal,
    result: {
      kind: "error",
      code: "provider_failure",
      aggregateVersion: { kind: "story", revision: "00000000000000000003" }
    }
  }, "prepared");
  const liveErrorState = stateForPrepared(terminalError);
  assert.ok(liveErrorState?.kind === "story");
  const deletedErrorState = { ...liveErrorState, summary: null };

  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M1,
    aggregate: aggregate(
      HASH_C,
      { receiptKind: "user", mutationId: M1, phase: "prepared" },
      null,
      deletedErrorState
    ),
    started: provider.started,
    prepared: terminalError
  })), MutationLedgerRecoveryError);

  assert.throws(() => planMutationLedgerRecovery(evidence({
    key: M1,
    aggregate: aggregate(
      HASH_B,
      { receiptKind: "user", mutationId: M1, phase: "started" },
      { mutationId: M1, fingerprintHash: HASH_A },
      storyState(HASH_A)
    ),
    started: provider.started,
    prepared: terminalError,
    replacement: { stateHash: HASH_C, oldStateHash: HASH_B, state: deletedErrorState },
    unresolvedProvider: provider
  })), MutationLedgerRecoveryError);
});

test("strict V5 recovery uses a logical revision-one root and V6 revision-two successor", () => {
  const local = localPrepared(M2, HASH_A, HASH_B);
  const replacement = { stateHash: HASH_B, oldStateHash: HASH_A, state: stateForPrepared(local)! };
  assert.deepEqual(planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(HASH_A, null, null, v5RootState()),
    prepared: local,
    replacement
  })).actions.map((action) => action.kind), ["discard-replacement", "discard-record"]);
  assert.deepEqual(planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(
      HASH_B,
      { receiptKind: "user", mutationId: M2, phase: "prepared" },
      null,
      replacement.state
    ),
    prepared: local
  })).actions.map((action) => action.kind), ["write-completed"]);

  const provider = providerEvidence();
  assert.deepEqual(planMutationLedgerRecovery(evidence({
    key: M1,
    aggregate: aggregate(
      HASH_B,
      { receiptKind: "user", mutationId: M1, phase: "started" },
      { mutationId: M1, fingerprintHash: HASH_A },
      storyState(HASH_A)
    ),
    started: provider.started,
    unresolvedProvider: provider
  })).actions.map((action) => action.kind), ["report-provider-outcome"]);

  const deletion = deletePrepared(M2, HASH_A, HASH_B);
  const deletedState = stateForPrepared(deletion);
  assert.ok(deletedState?.kind === "story" && deletedState.summary === null);
  assert.deepEqual(planMutationLedgerRecovery(evidence({
    key: M2,
    aggregate: aggregate(
      HASH_B,
      { receiptKind: "user", mutationId: M2, phase: "prepared" },
      null,
      deletedState
    ),
    prepared: deletion
  })).actions.map((action) => action.kind), ["write-completed"]);
});

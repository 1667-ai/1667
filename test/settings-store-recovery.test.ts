import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  SETTINGS_STATE_V2_FILE,
  SETTINGS_STATE_V2_NEXT_FILE
} from "../server/data-directory-format.js";
import { hashPreparedMutationRecord } from "../server/mutation-ledger-codec.js";
import { MutationLedgerStore } from "../server/mutation-ledger-store.js";
import type { PreparedUserMutationRecord } from "../server/mutation-ledger-types.js";
import { SettingsStore } from "../server/settings.js";
import {
  INITIAL_SETTINGS_DOCUMENT_V2,
  INITIAL_SETTINGS_STATE_V2,
  INITIAL_SETTINGS_STATE_V2_TEXT
} from "../server/settings-v2-default.js";
import { settingsMutationFingerprint } from "../server/settings-v2-mutation.js";
import {
  isExactSettingsActivationSuccessor,
  reduceSettingsStateV2
} from "../server/settings-v2-reducer.js";
import {
  publishStagedSettingsState,
  readSettingsState,
  stageSettingsState
} from "../server/settings-state-file.js";
import type { SettingsStateV2 } from "../shared/settings-v2-types.js";
import {
  FIXED_TIME,
  MUTATION_A,
  changedState,
  credentialedDocument,
  hasFsCode,
  hasServiceCode,
  initializedFormat2Directory,
  preparedFixture,
  saveCommand,
  writingDocument
} from "./settings-store-fixtures.js";

test("typed settings operations preserve durable fingerprint vectors", () => {
  assert.equal(
    settingsMutationFingerprint({
      method: "saveSettings",
      document: INITIAL_SETTINGS_DOCUMENT_V2
    }, 1),
    "500222578fc1a97d6a8852b204fbb2b1a4151586348dc444ba54bd8ebf1d8b36"
  );
  assert.equal(
    settingsMutationFingerprint({ method: "discardPendingSettings" }, 2),
    "5da4885060a68a01cc5fa1b224991f6785b6f0e37110ee711e13d928ab3fdc40"
  );
});

test("activation successor proof accepts exact edges and rejects skipped or changed edges", () => {
  const staged = changedState(
    MUTATION_A,
    credentialedDocument("AI_1667_RECOVERY_KEY")
  );
  const validating = reduceSettingsStateV2(staged, {
    kind: "begin-validation",
    transactionId: MUTATION_A
  });
  const validationFailed = reduceSettingsStateV2(validating, {
    kind: "validation-failed",
    errorCode: "candidate_invalid"
  });
  const prepared = reduceSettingsStateV2(validating, { kind: "prepare" });
  const promoted = reduceSettingsStateV2(prepared, { kind: "promote" });
  const committed = reduceSettingsStateV2(promoted, { kind: "commit" });
  const finishedCommit = reduceSettingsStateV2(committed, { kind: "finish-commit" });
  const rollingFromPrepared = reduceSettingsStateV2(prepared, { kind: "begin-rollback" });
  const rollingFromPromoted = reduceSettingsStateV2(promoted, { kind: "begin-rollback" });
  const rolledBackFromPrepared = reduceSettingsStateV2(rollingFromPrepared, {
    kind: "finish-rollback",
    errorCode: "activation_failed"
  });
  const rolledBackFromPromoted = reduceSettingsStateV2(rollingFromPromoted, {
    kind: "finish-rollback",
    errorCode: "readiness_failed"
  });

  for (const [current, next] of [
    [staged, validating],
    [validating, validationFailed],
    [validating, prepared],
    [prepared, promoted],
    [prepared, rollingFromPrepared],
    [promoted, committed],
    [promoted, rollingFromPromoted],
    [rollingFromPrepared, rolledBackFromPrepared],
    [rollingFromPromoted, rolledBackFromPromoted],
    [committed, finishedCommit]
  ] as const) {
    assert.equal(isExactSettingsActivationSuccessor(current, next), true);
  }

  assert.equal(
    isExactSettingsActivationSuccessor(staged, prepared),
    false,
    "a two-edge successor is not an unpublished atomic replacement"
  );
  assert.equal(
    isExactSettingsActivationSuccessor(staged, {
      ...validating,
      stateGeneration: validating.stateGeneration + 1
    }),
    false,
    "an otherwise-shaped successor cannot change the reducer-owned generation"
  );
  assert.equal(isExactSettingsActivationSuccessor(validating, staged), false);
});

test("restart proof-cleans an exact unpublished activation successor", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-v2-activation-next-");
  const { ledger, staged } = await installCompletedStagingReceipt(dataDir);
  const validating = reduceSettingsStateV2(staged, {
    kind: "begin-validation",
    transactionId: MUTATION_A
  });
  await stageSettingsState(dataDir, validating);

  const restarted = new SettingsStore(dataDir, {
    activationMode: "recover-only",
    ledger
  });
  await restarted.init(2);

  assert.deepEqual(await readSettingsState(dataDir), staged);
  await assert.rejects(
    access(path.join(dataDir, SETTINGS_STATE_V2_NEXT_FILE)),
    hasFsCode("ENOENT")
  );
});

test("restart fails closed on a skipped unpublished activation successor", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-v2-skipped-next-");
  const { ledger, staged } = await installCompletedStagingReceipt(dataDir);
  const validating = reduceSettingsStateV2(staged, {
    kind: "begin-validation",
    transactionId: MUTATION_A
  });
  const prepared = reduceSettingsStateV2(validating, { kind: "prepare" });
  await stageSettingsState(dataDir, prepared);

  await assert.rejects(
    new SettingsStore(dataDir, { activationMode: "recover-only", ledger }).init(2),
    hasServiceCode("internal")
  );
  assert.deepEqual(await readSettingsState(dataDir), staged);
});

test("restart removes a valid unpublished settings replacement with no receipt", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-v2-orphan-next-");
  const next = changedState(MUTATION_A, writingDocument("Unpublished edit."));
  await stageSettingsState(dataDir, next);

  const store = new SettingsStore(dataDir);
  await store.init(2);

  assert.equal(
    await readFile(path.join(dataDir, SETTINGS_STATE_V2_FILE), "utf8"),
    INITIAL_SETTINGS_STATE_V2_TEXT
  );
  await assert.rejects(
    access(path.join(dataDir, SETTINGS_STATE_V2_NEXT_FILE)),
    hasFsCode("ENOENT")
  );
  const view = await store.loadView();
  assert.equal(view.stateGeneration, 1);
  assert.equal(view.activeRevision, 1);
  assert.equal(view.effective.provider, "dry-run");
});

test("restart proof-cleans a prepared receipt whose valid replacement never committed", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-v2-orphan-prepared-");
  const next = changedState(MUTATION_A, writingDocument("Prepared but unpublished."));
  const prepared = preparedFixture(MUTATION_A, INITIAL_SETTINGS_STATE_V2, next);
  const ledger = new MutationLedgerStore(dataDir);
  await ledger.init();
  await stageSettingsState(dataDir, next);
  await ledger.writeUserRecord(prepared);

  const store = new SettingsStore(dataDir, { ledger, now: () => FIXED_TIME });
  await store.init(2);

  await assert.rejects(
    access(path.join(dataDir, SETTINGS_STATE_V2_NEXT_FILE)),
    hasFsCode("ENOENT")
  );
  assert.deepEqual(
    await ledger.loadUserReceipt("settings", MUTATION_A),
    { prepared: null, completed: null }
  );
  assert.equal((await store.loadView()).stateGeneration, 1);
});

test("same-fingerprint retry proof-cleans prepared-only residue after next cleanup", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-v2-retry-orphan-");
  const document = writingDocument("Retry after cleanup crash.");
  const next = changedState(MUTATION_A, document);
  const prepared = preparedFixture(
    MUTATION_A,
    INITIAL_SETTINGS_STATE_V2,
    next,
    settingsMutationFingerprint({ method: "saveSettings", document }, 1)
  );
  const ledger = new MutationLedgerStore(dataDir);
  await ledger.init();
  await ledger.writeUserRecord(prepared);
  const store = new SettingsStore(dataDir, { ledger, now: () => FIXED_TIME });
  await store.init(2);

  const saved = await store.save(saveCommand(MUTATION_A, 1, document));

  assert.equal(saved.settingsStateGeneration, 2);
  assert.equal((await store.loadView()).effective.systemPrompt, "Retry after cleanup crash.");
  assert.notEqual(
    (await ledger.loadUserReceipt("settings", MUTATION_A)).completed,
    null
  );
});

test("completed receipt ahead of an unpublished replacement fails closed", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-v2-ahead-next-");
  const next = changedState(MUTATION_A, writingDocument("Impossible completed edge."));
  const prepared = preparedFixture(MUTATION_A, INITIAL_SETTINGS_STATE_V2, next);
  const ledger = new MutationLedgerStore(dataDir);
  await ledger.init();
  await stageSettingsState(dataDir, next);
  await ledger.writeUserRecord(prepared);
  await writeCompletedReceipt(ledger, prepared);

  await assert.rejects(
    new SettingsStore(dataDir, { ledger }).init(2),
    hasServiceCode("internal")
  );
  assert.deepEqual(await readSettingsState(dataDir), INITIAL_SETTINGS_STATE_V2);
});

test("restart completes a prepared receipt after its settings state committed", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-v2-complete-");
  const next = changedState(MUTATION_A, writingDocument("Committed before crash."));
  const prepared = preparedFixture(MUTATION_A, INITIAL_SETTINGS_STATE_V2, next);
  const ledger = new MutationLedgerStore(dataDir);
  await ledger.init();
  await stageSettingsState(dataDir, next);
  await ledger.writeUserRecord(prepared);
  await publishStagedSettingsState(dataDir);

  const restarted = new SettingsStore(dataDir, { ledger, now: () => FIXED_TIME });
  await restarted.init(2);

  assert.deepEqual(await readSettingsState(dataDir), next);
  const receipt = await ledger.loadUserReceipt("settings", MUTATION_A);
  assert.deepEqual(receipt.prepared, prepared);
  assert.equal(receipt.completed?.preparedRecordHash, hashPreparedMutationRecord(prepared));
  assert.equal(receipt.completed?.completedAt, FIXED_TIME.toISOString());
  const view = await restarted.loadView();
  assert.equal(view.stateGeneration, 2);
  assert.equal(view.activeRevision, 2);
  assert.equal(view.effective.systemPrompt, "Committed before crash.");
});

async function installCompletedStagingReceipt(
  dataDir: string
): Promise<{ readonly ledger: MutationLedgerStore; readonly staged: SettingsStateV2 }> {
  const initializing = new SettingsStore(dataDir, { activationMode: "recover-only" });
  await initializing.init(2);
  const staged = changedState(
    MUTATION_A,
    credentialedDocument("AI_1667_RECOVERY_KEY")
  );
  const prepared = preparedFixture(MUTATION_A, INITIAL_SETTINGS_STATE_V2, staged);
  const ledger = new MutationLedgerStore(dataDir);
  await ledger.init();
  await stageSettingsState(dataDir, staged);
  await ledger.writeUserRecord(prepared);
  await publishStagedSettingsState(dataDir);
  await writeCompletedReceipt(ledger, prepared);
  return { ledger, staged };
}

async function writeCompletedReceipt(
  ledger: MutationLedgerStore,
  prepared: PreparedUserMutationRecord
): Promise<void> {
  await ledger.writeUserRecord({
    schema: 1,
    kind: "completed",
    aggregateKey: "settings",
    key: prepared.key,
    preparedRecordHash: hashPreparedMutationRecord(prepared),
    completedAt: FIXED_TIME.toISOString()
  });
}

import assert from "node:assert/strict";
import { canonicalJson } from "../server/canonical-json.js";
import {
  hashPreparedMutationRecord,
  hashStartedMutationRecord,
  parseMutationLedgerRecordText
} from "../server/mutation-ledger-codec.js";
import { storyIdForMutation } from "../server/story-identity.js";
import type {
  MutationLedgerRecoveryEvidence,
  ProviderRecoveryEvidence
} from "../server/mutation-ledger-recovery.js";
import type {
  AcknowledgedMutationRecord,
  CompletedMutationRecord,
  MutationResult,
  PreparedProviderAcknowledgementRecord,
  PreparedRecord,
  StartedMutationRecord
} from "../server/mutation-ledger-types.js";
import { prepareSettingsFormatMigrationV1Receipt } from "../server/settings-format-migration-receipt.js";

export const NOW = "2026-01-01T00:00:00.000Z";
export const M1 = `m1.1767225600000.${"d".repeat(32)}`;
export const M2 = `m1.1767225600001.${"e".repeat(32)}`;
export const M3 = `m1.1767225600002.${"f".repeat(32)}`;
export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);
export const HASH_C = "c".repeat(64);
const STORY = "story:story-one" as const;

export function evidence(options: {
  aggregateKey?: MutationLedgerRecoveryEvidence["aggregateKey"];
  key: string;
  aggregate: MutationLedgerRecoveryEvidence["aggregate"];
  started?: StartedMutationRecord;
  prepared?: PreparedRecord;
  completed?: CompletedMutationRecord;
  replacement?: MutationLedgerRecoveryEvidence["transaction"]["replacement"];
  unresolvedProvider?: ProviderRecoveryEvidence;
  originalProvider?: ProviderRecoveryEvidence;
}): MutationLedgerRecoveryEvidence {
  return {
    aggregateKey: options.aggregateKey ?? STORY,
    aggregate: options.aggregate,
    transaction: {
      key: options.key,
      started: options.started ?? null,
      prepared: options.prepared ?? null,
      completed: options.completed ?? null,
      replacement: options.replacement ?? null
    },
    unresolvedProvider: options.unresolvedProvider ?? null,
    originalProvider: options.originalProvider ?? null,
    recoveredAt: NOW
  };
}

export function aggregate(
  stateHash: string,
  lastTransaction: MutationLedgerRecoveryEvidence["aggregate"]["lastTransaction"] = null,
  unresolvedProvider: MutationLedgerRecoveryEvidence["aggregate"]["unresolvedProvider"] = null,
  state: MutationLedgerRecoveryEvidence["aggregate"]["state"] = stateHash === "absent" ? null : storyState()
): MutationLedgerRecoveryEvidence["aggregate"] {
  return { stateHash, state, lastTransaction, unresolvedProvider };
}

export function started(): StartedMutationRecord {
  return parse({
    schema: 1,
    kind: "started",
    aggregateKey: STORY,
    mutationId: M1,
    fingerprintHash: HASH_A,
    method: "continueStory",
    oldStateHash: HASH_A,
    createdAt: NOW
  }, "started");
}

export function localPrepared(key: string, oldStateHash: string, newStateHash: string): PreparedRecord {
  return parse({
    schema: 1,
    kind: "prepared",
    purpose: "mutation",
    aggregateKey: STORY,
    key,
    fingerprintHash: HASH_A,
    method: "renameStory",
    oldStateHash,
    newStateHash,
    startedRecordHash: null,
    result: storyResult(),
    preparedAt: NOW
  }, "prepared");
}

export function deletePrepared(key: string, oldStateHash: string, newStateHash: string): PreparedRecord {
  return parse({
    schema: 1,
    kind: "prepared",
    purpose: "mutation",
    aggregateKey: STORY,
    key,
    fingerprintHash: HASH_A,
    method: "deleteStory",
    oldStateHash,
    newStateHash,
    startedRecordHash: null,
    result: { ...storyResult(), summary: null },
    preparedAt: NOW
  }, "prepared");
}

export function receiptOnlyPrepared(key: string): PreparedRecord {
  return parse({
    schema: 1,
    kind: "prepared",
    purpose: "mutation",
    aggregateKey: STORY,
    key,
    fingerprintHash: HASH_A,
    method: "renameStory",
    oldStateHash: HASH_A,
    newStateHash: HASH_A,
    startedRecordHash: null,
    result: {
      kind: "error",
      code: "conflict",
      aggregateVersion: { kind: "story", revision: "00000000000000000002" }
    },
    preparedAt: NOW
  }, "prepared");
}

export function settingsPrepared(key: string, oldStateHash: string, newStateHash: string): PreparedRecord {
  return parse({
    schema: 1,
    kind: "prepared",
    purpose: "mutation",
    aggregateKey: "settings",
    key,
    fingerprintHash: HASH_A,
    method: "saveSettings",
    oldStateHash,
    newStateHash,
    startedRecordHash: null,
    result: settingsState(),
    preparedAt: NOW
  }, "prepared");
}

export function settingsReceiptOnlyPrepared(key: string): PreparedRecord {
  return parse({
    schema: 1,
    kind: "prepared",
    purpose: "mutation",
    aggregateKey: "settings",
    key,
    fingerprintHash: HASH_A,
    method: "saveSettings",
    oldStateHash: HASH_A,
    newStateHash: HASH_A,
    startedRecordHash: null,
    result: {
      kind: "error",
      code: "conflict",
      aggregateVersion: { kind: "settings", stateGeneration: 2 }
    },
    preparedAt: NOW
  }, "prepared");
}

export function migrationPrepared(): PreparedRecord {
  return parse(prepareSettingsFormatMigrationV1Receipt({
    sourceTag: "file",
    canonicalV1Hash: HASH_A,
    newStateHash: HASH_B,
    preparedAt: NOW
  }), "prepared");
}

export function createPrepared(
  method: "createStory" | "importSillyTavern" | "importMarkdown"
): PreparedRecord {
  const storyId = storyIdForMutation(M2);
  return parse({
    schema: 1,
    kind: "prepared",
    purpose: "mutation",
    aggregateKey: `story:${storyId}`,
    key: M2,
    fingerprintHash: HASH_A,
    method,
    oldStateHash: "absent",
    newStateHash: HASH_A,
    startedRecordHash: null,
    result: storyResult(storyId, "00000000000000000001"),
    preparedAt: NOW
  }, "prepared");
}

export function providerPrepared(): PreparedRecord {
  const providerStarted = started();
  return parse({
    schema: 1,
    kind: "prepared",
    purpose: "mutation",
    aggregateKey: STORY,
    key: M1,
    fingerprintHash: HASH_A,
    method: "continueStory",
    oldStateHash: HASH_B,
    newStateHash: HASH_C,
    startedRecordHash: hashStartedMutationRecord(providerStarted),
    result: storyResult(),
    preparedAt: NOW
  }, "prepared");
}

export function acknowledgementPrepared(
  original: StartedMutationRecord,
  preservedState: "deleted" | "live" = "deleted"
): PreparedProviderAcknowledgementRecord {
  return parse({
    schema: 1,
    kind: "prepared",
    purpose: "provider-acknowledgement",
    aggregateKey: STORY,
    key: M2,
    fingerprintHash: HASH_A,
    method: "acknowledgeUnknownOutcomes",
    oldStateHash: HASH_B,
    newStateHash: HASH_C,
    originalProviderMutationId: M1,
    originalStartedRecordHash: hashStartedMutationRecord(original),
    result: preservedState === "live" ? storyResult() : { ...storyResult(), summary: null },
    preparedAt: NOW
  }, "prepared") as PreparedProviderAcknowledgementRecord;
}

export function completedFor(prepared: PreparedRecord): CompletedMutationRecord {
  return parse({
    schema: 1,
    kind: "completed",
    aggregateKey: prepared.aggregateKey,
    key: prepared.key,
    preparedRecordHash: hashPreparedMutationRecord(prepared),
    completedAt: NOW
  }, "completed");
}

export function acknowledgedFor(
  prepared: PreparedProviderAcknowledgementRecord,
  original: StartedMutationRecord
): AcknowledgedMutationRecord {
  return parse({
    schema: 1,
    kind: "acknowledged",
    aggregateKey: STORY,
    mutationId: M1,
    startedRecordHash: hashStartedMutationRecord(original),
    acknowledgementMutationId: M2,
    acknowledgementPreparedHash: hashPreparedMutationRecord(prepared),
    acknowledgedAt: NOW
  }, "acknowledged");
}

export function providerEvidence(): ProviderRecoveryEvidence {
  return { started: started(), acknowledged: null };
}

export function parse<T extends "started" | "prepared" | "completed" | "acknowledged">(
  value: unknown,
  kind: T
): ExtractRecord<T> {
  const record = parseMutationLedgerRecordText(canonicalJson(value));
  assert.equal(record.kind, kind);
  return record as ExtractRecord<T>;
}

function storyResult(
  storyId = "story-one",
  storyRevision = "00000000000000000002"
): Extract<MutationResult, { kind: "story" }> {
  return {
    kind: "story",
    storyId,
    storyRevision,
    summary: {
      id: storyId,
      title: "Story",
      updatedAt: NOW,
      partCount: 1,
      words: "00000000000000000000",
      forked: false,
      lineCount: "00000000000000000000"
    }
  };
}

export function storyState(
  previousManifestHash: string | null = HASH_A
): Extract<NonNullable<MutationLedgerRecoveryEvidence["aggregate"]["state"]>, { kind: "story" }> {
  return { ...storyResult(), previousManifestHash };
}

export function v5RootState(): ReturnType<typeof storyState> {
  return {
    ...storyState(null),
    storyRevision: "00000000000000000001"
  };
}

export function settingsState(
  settingsStateGeneration = 2
): Extract<MutationResult, { kind: "settings" }> {
  return {
    kind: "settings",
    settingsStateGeneration,
    activeSettingsRevision: 1,
    pendingSettingsRevision: 2
  };
}

export function stateForPrepared(
  prepared: PreparedRecord
): MutationLedgerRecoveryEvidence["aggregate"]["state"] {
  const result = prepared.result;
  if (result.kind === "story") {
    return {
      ...result,
      previousManifestHash: prepared.oldStateHash === "absent" ? null : prepared.oldStateHash
    };
  }
  if (result.kind === "settings") return result;
  if (result.kind === "format-migration-v1") return settingsState();
  return result.aggregateVersion.kind === "story"
    ? { ...storyState(), storyRevision: result.aggregateVersion.revision }
    : settingsState(result.aggregateVersion.stateGeneration);
}

type ExtractRecord<T extends string> = T extends "started" ? StartedMutationRecord
  : T extends "prepared" ? PreparedRecord
    : T extends "completed" ? CompletedMutationRecord
      : AcknowledgedMutationRecord;

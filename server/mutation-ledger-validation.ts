import {
  MutationLedgerFormatError,
  requireFm1Key,
  requireHash256,
  requireLedgerStoryId,
  requireLogicalAggregateKey,
  requireMutationId,
  requireRevision20,
  requireUInt53,
  storyIdFromAggregateKey
} from "./mutation-ledger-scalars.js";
import type {
  AggregateTransactionPointer,
  AggregateVersion,
  DurableMutationMethod,
  Fm1Key,
  LogicalAggregateKey,
  MutationLedgerKey,
  MutationResult,
  Hash256,
  StoryReceiptSummary
} from "./mutation-ledger-types.js";
import {
  isAbsentStoryMutationMethod,
  isDurableMutationMethod,
  isInternalMutationMethod,
  isPreparedDomainError,
  isProviderMutationMethod,
  isSettingsMutationMethod,
  isStoryMutationMethod,
  mutationAggregateKind
} from "./mutation-ledger-types.js";
import { closedRecord, closedShape, literal } from "./story-wire-validation.js";
import { parseStorySummaryV6 } from "./story-v6-codec.js";
import { storyIdForMutation } from "./story-identity.js";
import { REVISION_ONE } from "./story-v6-scalars.js";
import { settingsFormatMigrationV1Identity } from "./settings-format-migration-identity.js";

const STORY_RESULT = closedShape(
  ["kind", "storyId", "storyRevision", "summary"],
  ["factStatesRemoved"]
);
const SETTINGS_RESULT = closedShape([
  "kind", "settingsStateGeneration", "activeSettingsRevision", "pendingSettingsRevision"
]);
const ERROR_RESULT = closedShape(["kind", "code", "aggregateVersion"]);
const MIGRATION_RESULT = closedShape(["kind", "sourceTag", "canonicalV1Hash"]);
const STORY_VERSION = closedShape(["kind", "revision"]);
const SETTINGS_VERSION = closedShape(["kind", "stateGeneration"]);

export interface PreparedMatrix {
  aggregateKey: LogicalAggregateKey;
  key: MutationLedgerKey;
  method: DurableMutationMethod;
  fingerprintHash: Hash256;
  oldStateHash: string;
  newStateHash: string;
  startedRecordHash: string | null;
  result: MutationResult;
}

export function parseMutationResult(value: unknown): MutationResult {
  const candidate = value as Record<string, unknown>;
  switch (candidate?.kind) {
    case "story": return parseStoryResult(value);
    case "settings": return parseSettingsResult(value);
    case "error": return parseErrorResult(value);
    case "format-migration-v1": return parseMigrationResult(value);
    default: throw new MutationLedgerFormatError("result.kind is invalid");
  }
}

export function validatePreparedMutationMatrix(matrix: PreparedMatrix): void {
  const aggregateKind = storyIdFromAggregateKey(matrix.aggregateKey) === null ? "settings" : "story";
  if (mutationAggregateKind(matrix.method) !== aggregateKind) {
    throw new MutationLedgerFormatError("Prepared method and aggregate kind do not match");
  }
  if (matrix.method === "acknowledgeUnknownOutcomes") {
    throw new MutationLedgerFormatError("Acknowledgement requires its dedicated prepared purpose");
  }
  if (isInternalMutationMethod(matrix.method)) {
    validateInternalPrepared(matrix);
    return;
  }
  if (matrix.key.startsWith("fm1:")) throw new MutationLedgerFormatError("User methods require a mutation ID key");
  if ((matrix.oldStateHash === "absent") !== isAbsentStoryMutationMethod(matrix.method)) {
    throw new MutationLedgerFormatError("Only create/import prepared records use absent old state");
  }
  const providerMethod = isProviderMutationMethod(matrix.method);
  if (matrix.result.kind === "error") validatePreparedError(matrix, providerMethod);
  else {
    if ((matrix.startedRecordHash !== null) !== providerMethod) {
      throw new MutationLedgerFormatError("Provider success requires its started record hash");
    }
    if (matrix.oldStateHash === matrix.newStateHash
      && !isReceiptOnlyStorySuccess(matrix, providerMethod)) {
      throw new MutationLedgerFormatError("Successful prepared mutations require a changed aggregate hash");
    }
  }
  if (isStoryMutationMethod(matrix.method)) {
    validateStoryResult(matrix.result, matrix.aggregateKey, matrix.method);
    if (isAbsentStoryMutationMethod(matrix.method)) validateAbsentStoryResult(matrix);
  }
  if (isSettingsMutationMethod(matrix.method)) {
    validateSettingsResult(matrix.result);
    if (matrix.method === "discardPendingSettings" && matrix.result.kind === "settings"
      && matrix.result.pendingSettingsRevision !== null) {
      throw new MutationLedgerFormatError("Discard settings result cannot retain a pending revision");
    }
  }
}

function isReceiptOnlyStorySuccess(
  matrix: PreparedMatrix,
  providerMethod: boolean
): boolean {
  return !providerMethod
    && matrix.result.kind === "story"
    && isStoryMutationMethod(matrix.method)
    && !isAbsentStoryMutationMethod(matrix.method)
    && matrix.method !== "deleteStory"
    && matrix.startedRecordHash === null;
}

export function validateStoryMutationResult(
  result: MutationResult,
  aggregateKey: LogicalAggregateKey,
  method: string
): void {
  validateStoryResult(result, aggregateKey, method);
}

export function requireDurableMethod(value: unknown): DurableMutationMethod {
  if (!isDurableMutationMethod(value)) throw new MutationLedgerFormatError("record.method is invalid");
  return value;
}

export function requireMutationLedgerKey(value: unknown): MutationLedgerKey {
  if (typeof value === "string" && value.startsWith("fm1:")) return requireFm1Key(value);
  return requireMutationId(value, "record.key");
}

export function requireStoryAggregateKey(value: unknown): `story:${string}` {
  const aggregateKey = requireLogicalAggregateKey(value);
  if (aggregateKey === "settings") throw new MutationLedgerFormatError("A story aggregate is required");
  return aggregateKey;
}

export function validateAggregateTransactionPointer(
  value: AggregateTransactionPointer | null,
  aggregateKey: LogicalAggregateKey
): AggregateTransactionPointer | null {
  if (value === null) return null;
  if (value.receiptKind === "user") {
    const mutationId = requireMutationId(value.mutationId, "lastTransaction.mutationId");
    if (value.phase !== "prepared" && (aggregateKey === "settings" || value.phase !== "started")) {
      throw new MutationLedgerFormatError("Aggregate transaction phase is invalid");
    }
    return { receiptKind: "user", mutationId, phase: value.phase };
  }
  if (value.receiptKind === "format-migration-v1" && aggregateKey === "settings" && value.phase === "prepared") {
    return { receiptKind: value.receiptKind, key: requireFm1Key(value.key), phase: "prepared" };
  }
  throw new MutationLedgerFormatError("Aggregate transaction pointer is invalid");
}

export function validateMutationLedgerKey(value: MutationLedgerKey): MutationLedgerKey {
  return value.startsWith("fm1:") ? requireFm1Key(value) : requireMutationId(value, "transaction.key");
}

function parseStoryResult(value: unknown): Extract<MutationResult, { kind: "story" }> {
  const result = closedRecord(value, "story result", STORY_RESULT);
  literal(result.kind, "story", "result.kind");
  const storyId = requireLedgerStoryId(result.storyId, "result.storyId");
  const summary = result.summary === null ? null : parseStorySummary(result.summary);
  const factStatesRemoved = result.factStatesRemoved === undefined
    ? undefined
    : requireUInt53(result.factStatesRemoved, "result.factStatesRemoved");
  if (factStatesRemoved !== undefined && factStatesRemoved < 1) {
    throw new MutationLedgerFormatError("Removed Fact State count must be positive");
  }
  if (summary !== null && summary.id !== storyId) {
    throw new MutationLedgerFormatError("Story result and summary IDs must match");
  }
  return {
    kind: "story",
    storyId,
    storyRevision: requireRevision20(result.storyRevision, "result.storyRevision"),
    summary,
    ...(factStatesRemoved === undefined ? {} : { factStatesRemoved })
  };
}

function parseStorySummary(value: unknown): StoryReceiptSummary {
  try {
    return parseStorySummaryV6(value, "result.summary");
  } catch (error) {
    throw new MutationLedgerFormatError("result.summary is invalid", { cause: error });
  }
}

function parseSettingsResult(value: unknown): Extract<MutationResult, { kind: "settings" }> {
  const result = closedRecord(value, "settings result", SETTINGS_RESULT);
  literal(result.kind, "settings", "result.kind");
  return {
    kind: "settings",
    settingsStateGeneration: requireUInt53(result.settingsStateGeneration, "result.settingsStateGeneration"),
    activeSettingsRevision: requireUInt53(result.activeSettingsRevision, "result.activeSettingsRevision"),
    pendingSettingsRevision: result.pendingSettingsRevision === null
      ? null
      : requireUInt53(result.pendingSettingsRevision, "result.pendingSettingsRevision")
  };
}

function parseErrorResult(value: unknown): Extract<MutationResult, { kind: "error" }> {
  const result = closedRecord(value, "error result", ERROR_RESULT);
  literal(result.kind, "error", "result.kind");
  if (!isPreparedDomainError(result.code)) throw new MutationLedgerFormatError("result.code is not durable");
  return { kind: "error", code: result.code, aggregateVersion: parseAggregateVersion(result.aggregateVersion) };
}

function parseAggregateVersion(value: unknown): AggregateVersion {
  const candidate = value as Record<string, unknown>;
  if (candidate?.kind === "story") {
    const version = closedRecord(value, "story aggregate version", STORY_VERSION);
    return { kind: "story", revision: requireRevision20(version.revision, "aggregateVersion.revision") };
  }
  if (candidate?.kind === "settings") {
    const version = closedRecord(value, "settings aggregate version", SETTINGS_VERSION);
    return {
      kind: "settings",
      stateGeneration: requireUInt53(version.stateGeneration, "aggregateVersion.stateGeneration")
    };
  }
  throw new MutationLedgerFormatError("result.aggregateVersion.kind is invalid");
}

function parseMigrationResult(value: unknown): Extract<MutationResult, { kind: "format-migration-v1" }> {
  const result = closedRecord(value, "format migration result", MIGRATION_RESULT);
  literal(result.kind, "format-migration-v1", "result.kind");
  if (result.sourceTag !== "file" && result.sourceTag !== "absent-default") {
    throw new MutationLedgerFormatError("result.sourceTag is invalid");
  }
  return {
    kind: "format-migration-v1",
    sourceTag: result.sourceTag,
    canonicalV1Hash: requireHash256(result.canonicalV1Hash, "result.canonicalV1Hash")
  };
}

function validateInternalPrepared(matrix: PreparedMatrix): void {
  if (!matrix.key.startsWith("fm1:") || matrix.aggregateKey !== "settings"
    || matrix.oldStateHash === "absent" || matrix.oldStateHash === matrix.newStateHash
    || matrix.startedRecordHash !== null || matrix.result.kind !== "format-migration-v1") {
    throw new MutationLedgerFormatError("Settings migration prepared record has an impossible result relation");
  }
  const identity = settingsFormatMigrationV1Identity(
    matrix.result.sourceTag,
    matrix.result.canonicalV1Hash
  );
  if (identity.key !== matrix.key
    || identity.fingerprintHash !== matrix.fingerprintHash
    || matrix.oldStateHash !== identity.canonicalV1Hash) {
    throw new MutationLedgerFormatError("Settings migration identity does not bind its prepared record");
  }
}

function validatePreparedError(matrix: PreparedMatrix, providerMethod: boolean): void {
  if (matrix.result.kind !== "error") return;
  if (matrix.result.code === "provider_failure" && !providerMethod) {
    throw new MutationLedgerFormatError("provider_failure requires a provider method");
  }
  if (matrix.startedRecordHash === null) {
    if (matrix.oldStateHash === "absent" || matrix.oldStateHash !== matrix.newStateHash) {
      throw new MutationLedgerFormatError("Receipt-only errors require equal present old/new state hashes");
    }
  } else if (!providerMethod || matrix.oldStateHash === matrix.newStateHash) {
    throw new MutationLedgerFormatError("Started terminal errors require a changed provider aggregate");
  }
}

function validateStoryResult(result: MutationResult, aggregateKey: LogicalAggregateKey, method: string): void {
  const storyId = storyIdFromAggregateKey(aggregateKey);
  if (storyId === null) throw new MutationLedgerFormatError("Story result requires a story aggregate");
  if (result.kind === "error") {
    if (result.aggregateVersion.kind !== "story") {
      throw new MutationLedgerFormatError("Story error requires a story aggregate version");
    }
    return;
  }
  if (result.kind !== "story" || result.storyId !== storyId || (result.summary !== null && result.summary.id !== storyId)) {
    throw new MutationLedgerFormatError("Story result identity does not match its aggregate");
  }
  if (method === "deleteStory" && result.summary !== null) {
    throw new MutationLedgerFormatError("Delete story result must not contain a live summary");
  }
  if (method !== "deleteStory" && method !== "acknowledgeUnknownOutcomes" && result.summary === null) {
    throw new MutationLedgerFormatError("Live story result must contain its exact V6 summary");
  }
  if (result.kind === "story" && result.factStatesRemoved !== undefined
    && method !== "deleteNode" && method !== "pruneUnusedTakes") {
    throw new MutationLedgerFormatError("Removed Fact State count requires a branch deletion method");
  }
}

function validateAbsentStoryResult(matrix: PreparedMatrix): void {
  if (matrix.result.kind !== "story") {
    throw new MutationLedgerFormatError("Create/import requires a successful story result");
  }
  const storyId = storyIdForMutation(matrix.key);
  if (matrix.aggregateKey !== `story:${storyId}` || matrix.result.storyId !== storyId
    || matrix.result.storyRevision !== REVISION_ONE) {
    throw new MutationLedgerFormatError("Create/import result does not match its deterministic revision-1 story");
  }
}

function validateSettingsResult(result: MutationResult): void {
  if (result.kind === "settings") return;
  if (result.kind === "error" && result.aggregateVersion.kind === "settings") return;
  throw new MutationLedgerFormatError("Settings method result does not match its aggregate");
}

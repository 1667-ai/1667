import { canonicalJson } from "./canonical-json.js";
import {
  formatMutationLedgerRecord,
  hashPreparedMutationRecord,
  hashStartedMutationRecord,
  parseMutationLedgerRecordText
} from "./mutation-ledger-codec.js";
import {
  requireHash256,
  requireLogicalAggregateKey,
  requireMutationId,
  requireTimeMs,
  storyIdFromAggregateKey
} from "./mutation-ledger-scalars.js";
import {
  validateAggregateTransactionPointer,
  validateMutationLedgerKey,
  parseMutationResult
} from "./mutation-ledger-validation.js";
import type {
  AcknowledgedMutationRecord,
  AggregateTransactionPointer,
  CompletedMutationRecord,
  Hash256,
  LogicalAggregateKey,
  MutationId,
  MutationLedgerKey,
  PreparedRecord,
  RecoveryAggregateEvidence,
  RecoveryStateProjection,
  StartedMutationRecord,
  TimeMs
} from "./mutation-ledger-types.js";
import { REVISION_ONE } from "./story-v6-scalars.js";
import { closedRecord, closedShape } from "./story-wire-validation.js";

const STORY_STATE = closedShape([
  "kind", "storyId", "storyRevision", "summary", "previousManifestHash"
]);

export interface ReplacementRecoveryEvidence {
  readonly stateHash: Hash256;
  readonly oldStateHash: Hash256 | "absent";
  readonly state: RecoveryStateProjection;
}

export interface TransactionRecoveryEvidence {
  readonly key: MutationLedgerKey;
  readonly started: StartedMutationRecord | null;
  readonly prepared: PreparedRecord | null;
  readonly completed: CompletedMutationRecord | null;
  readonly replacement: ReplacementRecoveryEvidence | null;
}

export interface ProviderRecoveryEvidence {
  readonly started: StartedMutationRecord;
  readonly acknowledged: AcknowledgedMutationRecord | null;
}

export interface MutationLedgerRecoveryEvidence {
  readonly aggregateKey: LogicalAggregateKey;
  readonly aggregate: RecoveryAggregateEvidence;
  readonly transaction: TransactionRecoveryEvidence;
  /** Direct lookup named by aggregate.unresolvedProvider, never a scan. */
  readonly unresolvedProvider: ProviderRecoveryEvidence | null;
  /** Required before acknowledgement completion; optional afterward because the original may be collected. */
  readonly originalProvider: ProviderRecoveryEvidence | null;
  readonly recoveredAt: TimeMs;
}

export class MutationLedgerRecoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MutationLedgerRecoveryError";
  }
}

export function normalizeRecoveryEvidence(
  input: MutationLedgerRecoveryEvidence
): MutationLedgerRecoveryEvidence {
  const aggregateKey = requireLogicalAggregateKey(input.aggregateKey);
  const recoveredAt = requireTimeMs(input.recoveredAt, "recoveredAt");
  const stateHash = input.aggregate.stateHash === "absent"
    ? "absent"
    : requireHash256(input.aggregate.stateHash, "aggregate.stateHash");
  const state = normalizeAggregateState(input.aggregate.state, stateHash, aggregateKey, "aggregate.state");
  const lastTransaction = validateAggregateTransactionPointer(input.aggregate.lastTransaction, aggregateKey);
  const unresolvedProvider = input.aggregate.unresolvedProvider === null ? null : {
    mutationId: requireMutationId(input.aggregate.unresolvedProvider.mutationId, "aggregate.unresolvedProvider.mutationId"),
    fingerprintHash: requireHash256(
      input.aggregate.unresolvedProvider.fingerprintHash,
      "aggregate.unresolvedProvider.fingerprintHash"
    )
  };
  if (aggregateKey === "settings" && unresolvedProvider !== null) {
    throw recoveryError("Settings aggregates cannot have unresolved providers");
  }
  if (stateHash === "absent" && (lastTransaction !== null || unresolvedProvider !== null)) {
    throw recoveryError("Absent aggregates cannot contain transaction pointers");
  }

  const key = validateMutationLedgerKey(input.transaction.key);
  if (key.startsWith("fm1:") && aggregateKey !== "settings") {
    throw recoveryError("Internal recovery keys require the settings aggregate");
  }
  const transaction: TransactionRecoveryEvidence = {
    key,
    started: normalizeRecord(input.transaction.started, "started"),
    prepared: normalizeRecord(input.transaction.prepared, "prepared"),
    completed: normalizeRecord(input.transaction.completed, "completed"),
    replacement: normalizeReplacement(input.transaction.replacement, aggregateKey)
  };
  const normalizedUnresolved = normalizeProviderEvidence(input.unresolvedProvider);
  const normalizedOriginal = normalizeProviderEvidence(input.originalProvider);
  validateDuplicateProviderSlots(normalizedUnresolved, normalizedOriginal);
  validateTransactionProviderStarted(transaction, normalizedUnresolved);
  validateTransactionProviderStarted(transaction, normalizedOriginal);
  return {
    ...input,
    aggregateKey,
    recoveredAt,
    aggregate: { stateHash, state, lastTransaction, unresolvedProvider },
    transaction,
    unresolvedProvider: normalizedUnresolved,
    originalProvider: normalizedOriginal
  };
}

export function validateRecoveryRelations(evidence: MutationLedgerRecoveryEvidence): void {
  const { aggregateKey, aggregate, transaction } = evidence;
  validateCurrentRecordIdentities(aggregateKey, transaction);
  validateCompletedRelation(transaction);
  validateStartedPreparedRelation(transaction);
  validateAggregatePointer(aggregateKey, aggregate, transaction);
  validateStoryAggregateRelations(evidence);
  validateTerminalProviderResolution(evidence);
  validateTerminalAggregateLineage(evidence);

  const prepared = transaction.prepared;
  if (prepared !== null && aggregate.stateHash === prepared.newStateHash) {
    if (aggregate.state === null) throw recoveryError("Prepared state relation requires a present aggregate");
    validatePreparedResultState(prepared, aggregate.state, "installed aggregate");
  }

  const pointer = aggregate.lastTransaction;
  const committedCurrent = prepared !== null && pointer !== null
    && pointerKey(pointer) === transaction.key
    && pointer.phase === "prepared"
    && aggregate.stateHash === prepared.newStateHash;
  if (committedCurrent && transitionClearsProvider(prepared) && aggregate.unresolvedProvider !== null) {
    throw recoveryError("Committed provider transition did not clear unresolved provider state");
  }
}

export function validateReplacementForPrepared(
  replacement: ReplacementRecoveryEvidence | null,
  prepared: PreparedRecord
): void {
  if (replacement === null || replacement.stateHash !== prepared.newStateHash
    || replacement.oldStateHash !== prepared.oldStateHash) {
    throw recoveryError("Uncommitted prepared record requires its exact replacement evidence");
  }
  validatePreparedResultState(prepared, replacement.state, "replacement aggregate");
}

function normalizeAggregateState(
  value: RecoveryStateProjection | null,
  stateHash: Hash256 | "absent",
  aggregateKey: LogicalAggregateKey,
  label: string
): RecoveryStateProjection | null {
  if (stateHash === "absent") {
    if (value !== null) throw recoveryError("Absent aggregate cannot expose present state evidence");
    return null;
  }
  if (value === null) throw recoveryError("Present aggregate requires typed state evidence");
  return normalizePresentState(value, aggregateKey, label);
}

function normalizeReplacement(
  value: ReplacementRecoveryEvidence | null,
  aggregateKey: LogicalAggregateKey
): ReplacementRecoveryEvidence | null {
  if (value === null) return null;
  const replacement = {
    stateHash: requireHash256(value.stateHash, "replacement.stateHash"),
    oldStateHash: value.oldStateHash === "absent"
      ? "absent" as const
      : requireHash256(value.oldStateHash, "replacement.oldStateHash"),
    state: normalizePresentState(value.state, aggregateKey, "replacement.state")
  };
  if (replacement.stateHash === replacement.oldStateHash) {
    throw recoveryError("Replacement aggregate must change the authoritative state hash");
  }
  validateStoryPredecessor(replacement.state, replacement.oldStateHash, "Replacement aggregate");
  return replacement;
}

function normalizePresentState(
  value: RecoveryStateProjection,
  aggregateKey: LogicalAggregateKey,
  label: string
): RecoveryStateProjection {
  const candidate = value as unknown as Record<string, unknown>;
  if (candidate?.kind === "story") {
    const story = closedRecord(value, label, STORY_STATE);
    const parsed = parseMutationResult({
      kind: story.kind,
      storyId: story.storyId,
      storyRevision: story.storyRevision,
      summary: story.summary
    });
    if (parsed.kind !== "story") throw recoveryError(`${label} is not a story projection`);
    const previousManifestHash = story.previousManifestHash === null
      ? null
      : requireHash256(story.previousManifestHash, `${label}.previousManifestHash`);
    if ((parsed.storyRevision === REVISION_ONE) !== (previousManifestHash === null)) {
      throw recoveryError(`${label} revision and predecessor are inconsistent`);
    }
    if (parsed.summary === null && parsed.storyRevision === REVISION_ONE) {
      throw recoveryError(`${label} cannot delete story revision 1`);
    }
    const storyId = storyIdFromAggregateKey(aggregateKey);
    if (storyId === null || parsed.storyId !== storyId) {
      throw recoveryError(`${label} does not match its story aggregate`);
    }
    return { ...parsed, previousManifestHash };
  }
  const parsed = parseMutationResult(value);
  const storyId = storyIdFromAggregateKey(aggregateKey);
  if (storyId === null) {
    if (parsed.kind !== "settings") throw recoveryError(`${label} does not match the settings aggregate`);
    return parsed;
  }
  throw recoveryError(`${label} does not match its story aggregate`);
}

function validatePreparedResultState(
  prepared: PreparedRecord,
  state: RecoveryStateProjection,
  label: string
): void {
  const result = prepared.result;
  if (result.kind === "story" || result.kind === "settings") {
    // Destructive mutation counts belong to the durable receipt. They do not
    // describe aggregate state, so compare only the result's state projection.
    const resultState = result.kind === "story" ? {
      kind: result.kind,
      storyId: result.storyId,
      storyRevision: result.storyRevision,
      summary: result.summary
    } : result;
    const stateResult = state.kind === "story" ? {
      kind: state.kind,
      storyId: state.storyId,
      storyRevision: state.storyRevision,
      summary: state.summary
    } : state;
    if (result.kind !== state.kind || canonicalJson(resultState) !== canonicalJson(stateResult)) {
      throw recoveryError(`Prepared result does not match the exact ${label} projection`);
    }
    return;
  }
  if (result.kind === "error") {
    const version = result.aggregateVersion;
    const matches = version.kind === "story"
      ? state.kind === "story" && version.revision === state.storyRevision
      : state.kind === "settings" && version.stateGeneration === state.settingsStateGeneration;
    if (!matches) throw recoveryError(`Prepared error version does not match the ${label}`);
    return;
  }
  if (state.kind !== "settings") {
    throw recoveryError(`Format migration result does not match the ${label}`);
  }
}

function validateStoryAggregateRelations(evidence: MutationLedgerRecoveryEvidence): void {
  const { aggregate, transaction } = evidence;
  const state = aggregate.state;
  if (state?.kind !== "story") return;
  const pointer = aggregate.lastTransaction;
  if (state.summary === null && (pointer === null || pointer.phase !== "prepared")) {
    throw recoveryError("Deleted story state requires a prepared transaction pointer");
  }
  if (pointer?.phase === "started") {
    const started = evidence.unresolvedProvider?.started;
    if (started !== undefined && started.mutationId === pointer.mutationId) {
      if (aggregate.stateHash === started.oldStateHash) {
        throw recoveryError("Provider-started aggregate must change its authoritative state hash");
      }
      validateStoryPredecessor(state, started.oldStateHash, "Provider-started aggregate");
    }
    return;
  }
  if (pointer !== null && pointerKey(pointer) === transaction.key
    && transaction.prepared !== null && aggregate.stateHash === transaction.prepared.newStateHash) {
    validateStoryPredecessor(state, transaction.prepared.oldStateHash, "Committed story aggregate");
  }
}

function validateStoryPredecessor(
  state: RecoveryStateProjection,
  oldStateHash: Hash256 | "absent",
  label: string
): void {
  if (state.kind !== "story") return;
  const expected = oldStateHash === "absent" ? null : oldStateHash;
  if (state.previousManifestHash !== expected) {
    throw recoveryError(`${label} predecessor does not match its old-state hash`);
  }
}

function validateDuplicateProviderSlots(
  unresolved: ProviderRecoveryEvidence | null,
  original: ProviderRecoveryEvidence | null
): void {
  if (unresolved === null || original === null
    || unresolved.started.mutationId !== original.started.mutationId) return;
  if (hashStartedMutationRecord(unresolved.started) !== hashStartedMutationRecord(original.started)
    || ((unresolved.acknowledged === null) !== (original.acknowledged === null))
    || (unresolved.acknowledged !== null && original.acknowledged !== null
      && formatMutationLedgerRecord(unresolved.acknowledged) !== formatMutationLedgerRecord(original.acknowledged))) {
    throw recoveryError("Direct evidence for one provider mutation is inconsistent between recovery slots");
  }
}

function validateTransactionProviderStarted(
  transaction: TransactionRecoveryEvidence,
  provider: ProviderRecoveryEvidence | null
): void {
  if (provider === null || provider.started.mutationId !== transaction.key) return;
  if (transaction.started === null
    || formatMutationLedgerRecord(transaction.started) !== formatMutationLedgerRecord(provider.started)) {
    throw recoveryError("Direct evidence for one provider started record is inconsistent between recovery slots");
  }
}

function validateTerminalProviderResolution(evidence: MutationLedgerRecoveryEvidence): void {
  const { aggregate, transaction } = evidence;
  const prepared = transaction.prepared;
  if (transaction.completed === null || prepared === null) return;
  const resolvedProviderId = prepared.purpose === "provider-acknowledgement"
    ? prepared.originalProviderMutationId
    : prepared.startedRecordHash === null ? null : prepared.key;
  if (resolvedProviderId !== null && aggregate.unresolvedProvider?.mutationId === resolvedProviderId) {
    throw recoveryError("Completed provider transaction did not durably clear its provider");
  }
}

function validateTerminalAggregateLineage(evidence: MutationLedgerRecoveryEvidence): void {
  const { aggregate, transaction } = evidence;
  const prepared = transaction.prepared;
  const state = aggregate.state;
  if (transaction.completed === null || prepared === null) return;
  if (state === null) {
    if (prepared.aggregateKey === "settings") {
      throw recoveryError("Completed settings receipt requires a present settings aggregate");
    }
    return;
  }

  const result = prepared.result;
  if (state.kind === "settings") {
    const terminalGeneration = result.kind === "settings"
      ? result.settingsStateGeneration
      : result.kind === "error" && result.aggregateVersion.kind === "settings"
        ? result.aggregateVersion.stateGeneration
        : null;
    if (terminalGeneration === null) return;
    if (state.settingsStateGeneration < terminalGeneration) {
      throw recoveryError("Current settings generation precedes its completed receipt");
    }
    if (state.settingsStateGeneration === terminalGeneration && aggregate.stateHash !== prepared.newStateHash) {
      throw recoveryError("Current settings at completed receipt generation has a different state hash");
    }
    return;
  }
  const terminalRevision = result.kind === "story"
    ? result.storyRevision
    : result.kind === "error" && result.aggregateVersion.kind === "story"
      ? result.aggregateVersion.revision
      : null;
  if (terminalRevision === null) return;
  if (state.storyRevision < terminalRevision) {
    throw recoveryError("Current story revision precedes its completed receipt");
  }
  if (state.storyRevision === terminalRevision && aggregate.stateHash !== prepared.newStateHash) {
    throw recoveryError("Current story at completed receipt revision has a different state hash");
  }
  if (state.storyRevision > terminalRevision && result.kind === "story"
    && result.summary === null && state.summary !== null) {
    throw recoveryError("Deleted completed story receipt cannot precede live story state");
  }
}

function validateCurrentRecordIdentities(
  aggregateKey: LogicalAggregateKey,
  transaction: TransactionRecoveryEvidence
): void {
  if (transaction.started !== null && (
    transaction.started.aggregateKey !== aggregateKey || transaction.started.mutationId !== transaction.key
  )) throw recoveryError("Started record identity does not match its direct lookup");
  if (transaction.prepared !== null && (
    transaction.prepared.aggregateKey !== aggregateKey || transaction.prepared.key !== transaction.key
  )) throw recoveryError("Prepared record identity does not match its direct lookup");
  if (transaction.completed !== null && (
    transaction.completed.aggregateKey !== aggregateKey || transaction.completed.key !== transaction.key
  )) throw recoveryError("Completed record identity does not match its direct lookup");
}

function validateCompletedRelation(transaction: TransactionRecoveryEvidence): void {
  if (transaction.completed === null) return;
  if (transaction.prepared === null
    || transaction.completed.preparedRecordHash !== hashPreparedMutationRecord(transaction.prepared)) {
    throw recoveryError("Completed record does not bind the prepared record");
  }
}

function validateStartedPreparedRelation(transaction: TransactionRecoveryEvidence): void {
  const prepared = transaction.prepared;
  if (prepared === null) return;
  const started = transaction.started;
  if (prepared.purpose !== "mutation" || prepared.startedRecordHash === null) {
    if (started !== null) throw recoveryError("Prepared record cannot retain an unbound started record");
    return;
  }
  if (started === null
    || hashStartedMutationRecord(started) !== prepared.startedRecordHash
    || started.method !== prepared.method
    || started.fingerprintHash !== prepared.fingerprintHash) {
    throw recoveryError("Prepared record does not bind its provider started record");
  }
  if (prepared.oldStateHash === started.oldStateHash) {
    throw recoveryError("Provider terminal record must follow a hash-changing started aggregate");
  }
}

function validateAggregatePointer(
  aggregateKey: LogicalAggregateKey,
  aggregate: RecoveryAggregateEvidence,
  transaction: TransactionRecoveryEvidence
): void {
  const pointer = aggregate.lastTransaction;
  if (pointer?.phase === "started" && (
    aggregate.unresolvedProvider === null
    || aggregate.unresolvedProvider.mutationId !== pointer.mutationId
  )) throw recoveryError("Started aggregate pointer does not name its unresolved provider");
  if (pointer === null || pointerKey(pointer) !== transaction.key) return;
  if (pointer.phase === "started") {
    if (aggregateKey === "settings" || transaction.started === null) {
      throw recoveryError("Started aggregate pointer has invalid direct evidence");
    }
    const unresolved = aggregate.unresolvedProvider;
    if (unresolved === null || unresolved.mutationId !== transaction.started.mutationId
      || unresolved.fingerprintHash !== transaction.started.fingerprintHash) {
      throw recoveryError("Started aggregate pointer does not match unresolved provider evidence");
    }
  } else if (transaction.prepared === null) {
    throw recoveryError("Prepared aggregate pointer has no prepared record");
  }
}

function transitionClearsProvider(prepared: PreparedRecord): boolean {
  return prepared.purpose === "provider-acknowledgement"
    || (prepared.purpose === "mutation"
      && (prepared.startedRecordHash !== null || prepared.oldStateHash === "absent"));
}

function normalizeProviderEvidence(value: ProviderRecoveryEvidence | null): ProviderRecoveryEvidence | null {
  if (value === null) return null;
  return {
    started: normalizeRecord(value.started, "started")!,
    acknowledged: normalizeRecord(value.acknowledged, "acknowledged")
  };
}

function normalizeRecord<T extends "started" | "prepared" | "completed" | "acknowledged">(
  value: MutationLedgerRecordForKind<T> | null,
  kind: T
): MutationLedgerRecordForKind<T> | null {
  if (value === null) return null;
  const parsed = parseMutationLedgerRecordText(formatMutationLedgerRecord(value));
  if (parsed.kind !== kind) throw recoveryError(`Expected ${kind} recovery record`);
  return parsed as MutationLedgerRecordForKind<T>;
}

type MutationLedgerRecordForKind<T extends string> =
  T extends "started" ? StartedMutationRecord
    : T extends "prepared" ? PreparedRecord
      : T extends "completed" ? CompletedMutationRecord
        : AcknowledgedMutationRecord;

function pointerKey(pointer: AggregateTransactionPointer): MutationLedgerKey {
  return pointer.receiptKind === "user" ? pointer.mutationId : pointer.key;
}

function recoveryError(message: string): MutationLedgerRecoveryError {
  return new MutationLedgerRecoveryError(message);
}

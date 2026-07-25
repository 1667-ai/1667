import {
  formatMutationLedgerRecord,
  hashPreparedMutationRecord,
  hashStartedMutationRecord,
  parseMutationLedgerRecordText
} from "./mutation-ledger-codec.js";
import {
  MutationLedgerRecoveryError,
  normalizeRecoveryEvidence,
  validateRecoveryRelations,
  validateReplacementForPrepared
} from "./mutation-ledger-recovery-evidence.js";
import type {
  MutationLedgerRecoveryEvidence,
  ProviderRecoveryEvidence
} from "./mutation-ledger-recovery-evidence.js";
import type {
  AcknowledgedMutationRecord,
  AggregateTransactionPointer,
  CompletedMutationRecord,
  MutationId,
  MutationLedgerKey,
  PreparedRecord,
  StartedMutationRecord,
  TimeMs
} from "./mutation-ledger-types.js";

export { MutationLedgerRecoveryError } from "./mutation-ledger-recovery-evidence.js";
export type {
  MutationLedgerRecoveryEvidence,
  ProviderRecoveryEvidence,
  ReplacementRecoveryEvidence,
  TransactionRecoveryEvidence
} from "./mutation-ledger-recovery-evidence.js";

export type MutationLedgerRecoveryAction =
  | { readonly kind: "discard-replacement"; readonly key: MutationLedgerKey }
  | { readonly kind: "discard-record"; readonly key: MutationLedgerKey; readonly recordKind: "started" | "prepared" }
  | { readonly kind: "write-acknowledged"; readonly record: AcknowledgedMutationRecord }
  | { readonly kind: "write-completed"; readonly record: CompletedMutationRecord }
  | {
      readonly kind: "report-provider-outcome";
      readonly mutationId: MutationId;
      readonly outcome: "generation-outcome-unknown";
    };

export interface MutationLedgerRecoveryPlan {
  readonly actions: readonly MutationLedgerRecoveryAction[];
}

/**
 * Plans bounded direct-lookup recovery. The evidence has one transaction slot,
 * one unresolved-provider slot, and one acknowledgement-original slot; callers
 * cannot supply or request an aggregate scan through this API.
 */
export function planMutationLedgerRecovery(input: MutationLedgerRecoveryEvidence): MutationLedgerRecoveryPlan {
  try {
    const evidence = normalizeRecoveryEvidence(input);
    validateRecoveryRelations(evidence);
    return planValidatedRecovery(evidence);
  } catch (error) {
    if (error instanceof MutationLedgerRecoveryError) throw error;
    throw new MutationLedgerRecoveryError("Mutation ledger recovery evidence is invalid", { cause: error });
  }
}

function planValidatedRecovery(evidence: MutationLedgerRecoveryEvidence): MutationLedgerRecoveryPlan {
  const actions: MutationLedgerRecoveryAction[] = [];
  const { aggregateKey, aggregate, transaction } = evidence;
  const pointer = aggregate.lastTransaction;
  const pointsToCurrent = pointer !== null && pointerKey(pointer) === transaction.key;

  planUnresolvedProvider(evidence, actions);

  if (transaction.completed !== null) {
    const prepared = transaction.prepared!;
    if (transaction.replacement !== null) {
      throw recoveryError("Completed receipt cannot retain a replacement aggregate");
    }
    if (pointer !== null && pointerKey(pointer) === transaction.key && pointer.phase === "started") {
      throw recoveryError("Completed receipt cannot coexist with its started aggregate pointer");
    }
    if (isReceiptOnlyPrepared(prepared) && pointer !== null && pointerKey(pointer) === transaction.key) {
      throw recoveryError("Completed receipt-only mutation cannot install an aggregate pointer");
    }
    // Story revisions always replace their transaction pointer. Settings may
    // later change state while ADR003 activation edges preserve the same pointer.
    if (aggregateKey !== "settings" && pointer !== null && pointerKey(pointer) === transaction.key
      && pointer.phase === "prepared" && aggregate.stateHash !== prepared.newStateHash) {
      throw recoveryError("Completed story receipt pointer has a stale aggregate hash");
    }
    if (prepared.purpose === "provider-acknowledgement") {
      validateTerminalAcknowledgement(evidence, prepared, hashPreparedMutationRecord(prepared));
    }
    return frozenPlan(actions);
  }

  if (transaction.prepared !== null) {
    const prepared = transaction.prepared;
    const preparedHash = hashPreparedMutationRecord(prepared);
    const receiptOnly = isReceiptOnlyPrepared(prepared);

    if (receiptOnly) {
      if (aggregate.stateHash !== prepared.oldStateHash || pointsToCurrent) {
        throw recoveryError("Receipt-only prepared record must leave aggregate state and pointer unchanged");
      }
      if (transaction.replacement !== null) {
        throw recoveryError("Receipt-only prepared record cannot have a replacement aggregate");
      }
      if (transaction.completed === null) actions.push(completedAction(prepared, preparedHash, evidence.recoveredAt));
      return frozenPlan(actions);
    }

    const committed = pointsToCurrent && pointer?.phase === "prepared" && aggregate.stateHash === prepared.newStateHash;
    if (committed) {
      if (transaction.replacement !== null) {
        throw recoveryError("Committed aggregate cannot retain its replacement path");
      }
      if (prepared.purpose === "provider-acknowledgement") {
        planCommittedAcknowledgement(evidence, prepared, preparedHash, actions);
      } else if (transaction.completed === null) {
        actions.push(completedAction(prepared, preparedHash, evidence.recoveredAt));
      }
      return frozenPlan(actions);
    }

    if ((pointsToCurrent && pointer?.phase !== "started") || aggregate.stateHash !== prepared.oldStateHash) {
      throw recoveryError("Prepared record hashes or aggregate pointer are stale");
    }
    validateReplacementForPrepared(transaction.replacement, prepared);
    if (transaction.replacement !== null) actions.push({ kind: "discard-replacement", key: transaction.key });
    actions.push({ kind: "discard-record", key: transaction.key, recordKind: "prepared" });
    if (transaction.started !== null && !providerSlotsUse(evidence, transaction.started)) {
      if (aggregate.stateHash !== transaction.started.oldStateHash) {
        throw recoveryError("Unreferenced started record has a stale old-state hash");
      }
      actions.push({ kind: "discard-record", key: transaction.key, recordKind: "started" });
    }
    return frozenPlan(actions);
  }

  if (pointsToCurrent && pointer?.phase === "prepared") {
    throw recoveryError("Aggregate points to a missing prepared record");
  }

  if (transaction.replacement !== null) {
    if (aggregate.stateHash !== transaction.replacement.oldStateHash
      || (pointsToCurrent && pointer?.phase !== "started")) {
      throw recoveryError("Unreferenced replacement has a stale old-state hash");
    }
    actions.push({ kind: "discard-replacement", key: transaction.key });
  }

  if (transaction.started !== null && !providerSlotsUse(evidence, transaction.started)) {
    if (aggregate.stateHash !== transaction.started.oldStateHash || pointsToCurrent) {
      throw recoveryError("Unreferenced started record has a stale old-state hash");
    }
    actions.push({ kind: "discard-record", key: transaction.key, recordKind: "started" });
  }
  return frozenPlan(actions);
}

function planUnresolvedProvider(
  evidence: MutationLedgerRecoveryEvidence,
  actions: MutationLedgerRecoveryAction[]
): void {
  const pointer = evidence.aggregate.unresolvedProvider;
  const direct = evidence.unresolvedProvider;
  if (pointer === null) {
    if (direct !== null) throw recoveryError("Unresolved-provider evidence exists after the aggregate cleared it");
    return;
  }
  if (direct === null) throw recoveryError("Aggregate unresolved provider has no direct started evidence");
  const started = direct.started;
  if (started.aggregateKey !== evidence.aggregateKey || started.mutationId !== pointer.mutationId
    || started.fingerprintHash !== pointer.fingerprintHash) {
    throw recoveryError("Unresolved provider does not match its started record");
  }
  if (direct.acknowledged !== null) throw recoveryError("Acknowledged record cannot precede durable provider clear");
  actions.push({
    kind: "report-provider-outcome",
    mutationId: started.mutationId,
    outcome: "generation-outcome-unknown"
  });
}

function planCommittedAcknowledgement(
  evidence: MutationLedgerRecoveryEvidence,
  prepared: Extract<PreparedRecord, { purpose: "provider-acknowledgement" }>,
  preparedHash: string,
  actions: MutationLedgerRecoveryAction[]
): void {
  if (evidence.aggregate.unresolvedProvider !== null) {
    throw recoveryError("Committed acknowledgement did not clear unresolved provider state");
  }
  const original = evidence.originalProvider;
  if (original === null) throw recoveryError("Committed acknowledgement has no original started evidence");
  const startedHash = hashStartedMutationRecord(original.started);
  if (original.started.aggregateKey !== evidence.aggregateKey
    || original.started.mutationId !== prepared.originalProviderMutationId
    || startedHash !== prepared.originalStartedRecordHash) {
    throw recoveryError("Committed acknowledgement does not bind the original started record");
  }
  if (original.acknowledged === null) {
    actions.push({
      kind: "write-acknowledged",
      record: validatedOutput({
        schema: 1,
        kind: "acknowledged",
        aggregateKey: prepared.aggregateKey,
        mutationId: prepared.originalProviderMutationId,
        startedRecordHash: startedHash,
        acknowledgementMutationId: prepared.key,
        acknowledgementPreparedHash: preparedHash,
        acknowledgedAt: evidence.recoveredAt
      })
    });
  } else {
    validateAcknowledgedBinding(evidence, prepared, preparedHash, original.acknowledged, startedHash);
  }
  if (evidence.transaction.completed === null) {
    actions.push(completedAction(prepared, preparedHash, evidence.recoveredAt));
  }
}

function validateTerminalAcknowledgement(
  evidence: MutationLedgerRecoveryEvidence,
  prepared: Extract<PreparedRecord, { purpose: "provider-acknowledgement" }>,
  preparedHash: string
): void {
  const original = evidence.originalProvider;
  if (original === null) return;
  if (original.acknowledged === null) {
    throw recoveryError("Retained original provider evidence lacks its acknowledged record");
  }
  const startedHash = hashStartedMutationRecord(original.started);
  if (original.started.aggregateKey !== evidence.aggregateKey
    || original.started.mutationId !== prepared.originalProviderMutationId
    || startedHash !== prepared.originalStartedRecordHash) {
    throw recoveryError("Completed acknowledgement does not bind its original started record");
  }
  validateAcknowledgedBinding(evidence, prepared, preparedHash, original.acknowledged, startedHash);
}

function validateAcknowledgedBinding(
  evidence: MutationLedgerRecoveryEvidence,
  prepared: Extract<PreparedRecord, { purpose: "provider-acknowledgement" }>,
  preparedHash: string,
  acknowledged: AcknowledgedMutationRecord,
  startedHash: string
): void {
  if (acknowledged.aggregateKey !== evidence.aggregateKey
    || acknowledged.mutationId !== prepared.originalProviderMutationId
    || acknowledged.startedRecordHash !== startedHash
    || acknowledged.acknowledgementMutationId !== prepared.key
    || acknowledged.acknowledgementPreparedHash !== preparedHash) {
    throw recoveryError("Original acknowledged record does not bind the committed acknowledgement");
  }
}

function completedAction(
  prepared: PreparedRecord,
  preparedHash: string,
  completedAt: TimeMs
): MutationLedgerRecoveryAction {
  return {
    kind: "write-completed",
    record: validatedOutput({
      schema: 1,
      kind: "completed",
      aggregateKey: prepared.aggregateKey,
      key: prepared.key,
      preparedRecordHash: preparedHash,
      completedAt
    })
  };
}

function isReceiptOnlyPrepared(prepared: PreparedRecord): boolean {
  return prepared.purpose === "mutation"
    && prepared.startedRecordHash === null && prepared.oldStateHash === prepared.newStateHash;
}

function pointerKey(pointer: AggregateTransactionPointer): MutationLedgerKey {
  return pointer.receiptKind === "user" ? pointer.mutationId : pointer.key;
}

function providerEvidenceUses(
  evidence: ProviderRecoveryEvidence | null,
  started: StartedMutationRecord
): boolean {
  return evidence !== null && evidence.started.mutationId === started.mutationId
    && hashStartedMutationRecord(evidence.started) === hashStartedMutationRecord(started);
}

function providerSlotsUse(
  evidence: MutationLedgerRecoveryEvidence,
  started: StartedMutationRecord
): boolean {
  return providerEvidenceUses(evidence.unresolvedProvider, started)
    || providerEvidenceUses(evidence.originalProvider, started);
}

function validatedOutput<T extends CompletedMutationRecord | AcknowledgedMutationRecord>(record: T): T {
  const parsed = parseMutationLedgerRecordText(formatMutationLedgerRecord(record));
  return parsed as T;
}

function frozenPlan(actions: MutationLedgerRecoveryAction[]): MutationLedgerRecoveryPlan {
  actions.forEach(Object.freeze);
  return Object.freeze({ actions: Object.freeze(actions) });
}

function recoveryError(message: string): MutationLedgerRecoveryError {
  return new MutationLedgerRecoveryError(message);
}

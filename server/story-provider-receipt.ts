import {
  GenerationResultError,
  isTerminalGenerationFailure,
  ProviderError,
  ProviderRecoveryRequiredError,
  ServiceError
} from "./errors.js";
import type {
  MutationCoordinatorRequest,
  StoryMutationTarget
} from "./mutation-coordinator.js";
import { hashStartedMutationRecord } from "./mutation-ledger-codec.js";
import type { StoryMutationReceipt } from "./mutation-ledger-store.js";
import type { ProviderMutationMethod } from "./mutation-ledger-types.js";
import {
  isPreparedDomainError,
  type PreparedDomainError
} from "./mutation-ledger-types.js";
import { corruptStoryReceipt } from "./story-mutation-transaction.js";

export function receiptOnlyProviderError(
  error: unknown
): PreparedDomainError | null {
  if (error instanceof ProviderError) {
    return "provider_failure";
  }
  if (!(error instanceof ServiceError) || !isPreparedDomainError(error.code)) {
    return null;
  }
  if (error.code === "provider_failure"
    && !isTerminalGenerationFailure(error)) {
    return null;
  }
  return error.code;
}

export function requireMatchingProviderReceipt(
  receipt: StoryMutationReceipt,
  request: MutationCoordinatorRequest<StoryMutationTarget>,
  method: ProviderMutationMethod
): void {
  if (receipt.started !== null && (
    receipt.started.aggregateKey !== request.scope
    || receipt.started.mutationId !== request.mutationId
    || receipt.started.method !== method
    || receipt.started.fingerprintHash !== request.fingerprint
  )) {
    throw providerIdempotencyConflict();
  }
  if (receipt.prepared !== null) {
    if (receipt.prepared.purpose !== "mutation"
      || receipt.prepared.aggregateKey !== request.scope
      || receipt.prepared.key !== request.mutationId
      || receipt.prepared.method !== method
      || receipt.prepared.fingerprintHash !== request.fingerprint
      || (receipt.prepared.startedRecordHash === null
        && (receipt.prepared.result.kind !== "error"
          || receipt.prepared.oldStateHash !== receipt.prepared.newStateHash))) {
      throw providerIdempotencyConflict();
    }
  } else if (receipt.completed !== null || receipt.acknowledged !== null) {
    throw corruptStoryReceipt(request.mutationId);
  }
}

export function requireUnacknowledgedProviderReceipt(
  receipt: StoryMutationReceipt,
  request: MutationCoordinatorRequest<StoryMutationTarget>,
  method: ProviderMutationMethod
): void {
  if (receipt.acknowledged !== null) {
    requireMatchingAcknowledgedProviderReceipt(receipt, request, method);
    throw providerOutcomeAcknowledged(request.mutationId);
  }
  requireMatchingProviderReceipt(receipt, request, method);
}

export function requireMatchingAcknowledgedProviderReceipt(
  receipt: StoryMutationReceipt,
  request: MutationCoordinatorRequest<StoryMutationTarget>,
  method: ProviderMutationMethod
): void {
  const started = receipt.started;
  const acknowledged = receipt.acknowledged;
  if (started === null || acknowledged === null
    || started.aggregateKey !== request.scope
    || started.mutationId !== request.mutationId
    || started.method !== method
    || started.fingerprintHash !== request.fingerprint
    || acknowledged.aggregateKey !== request.scope
    || acknowledged.mutationId !== request.mutationId
    || acknowledged.startedRecordHash !== hashStartedMutationRecord(started)
    || receipt.prepared !== null
    || receipt.completed !== null) {
    throw providerIdempotencyConflict();
  }
}

export function providerOutcomeUnknown(
  mutationId: string
): ProviderRecoveryRequiredError {
  return new ProviderRecoveryRequiredError(mutationId);
}

export function providerOutcomeAcknowledged(mutationId: string): ServiceError {
  return new ServiceError(
    409,
    `The interrupted model request ${mutationId} is closed and cannot run again.`,
    "generation_outcome_unknown_acknowledged"
  );
}

export function terminalProviderConflict(
  error: unknown
): {
  error: GenerationResultError;
  code: PreparedDomainError;
} | null {
  if (error instanceof GenerationResultError
    && isPreparedDomainError(error.code)) {
    return { error, code: error.code };
  }
  if (error instanceof ServiceError && error.status >= 400
    && error.status < 500) {
    const terminal = new GenerationResultError(error.status, error.message);
    if (isPreparedDomainError(terminal.code)) {
      return { error: terminal, code: terminal.code };
    }
  }
  return null;
}

function providerIdempotencyConflict(): ServiceError {
  return new ServiceError(
    409,
    "Mutation ID was already used for different provider input.",
    "idempotency_conflict"
  );
}

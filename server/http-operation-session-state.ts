import type { HttpCapabilityScope } from "../shared/http-auth.js";
import {
  isTerminalHttpOperationState,
  type HttpOperationReservationResponse,
  type HttpOperationState,
  type HttpOperationStatusResponse
} from "../shared/http-operation-protocol.js";
import type { HttpSupervisedOperationDescriptor } from "../shared/supervised-serve-protocol.js";
import {
  parseStoryAggregateVersion,
  type StoryAggregateVersion
} from "../shared/story-aggregate-version.js";
import { isWorkerMutationMethod } from "../shared/worker-protocol.js";
import { ServiceError } from "./errors.js";
import { requireMutationId as requireLedgerMutationId } from "./mutation-ledger-scalars.js";

export interface HttpOperationSessionRecord {
  readonly id: string;
  readonly scope: HttpCapabilityScope;
  readonly createdAt: number;
  readonly originKey: string;
  readonly capability: string;
  lastActivityAt: number;
  lastSequence: bigint;
  closed: boolean;
  active: number;
  reservationHistory: number[];
  closeWaiters: Array<() => void>;
}

export interface HttpOperationRecord {
  readonly sessionId: string;
  readonly sequence: bigint;
  readonly scope: HttpCapabilityScope;
  readonly ticket: string;
  readonly method: string;
  readonly path: string;
  readonly operation: HttpSupervisedOperationDescriptor["operation"];
  readonly mutationId: string | null;
  readonly expectedAggregateVersion: StoryAggregateVersion | null;
  readonly deadline: number;
  readonly deadlineEpochMs: number;
  readonly startDeadline: number;
  readonly startDeadlineEpochMs: number;
  readonly lifetime: HttpOperationReservationResponse["lifetime"];
  readonly lifetimeMs: number;
  readonly abort: AbortController;
  state: HttpOperationState;
  cancelRequested: boolean;
  terminalAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  hardTimer: ReturnType<typeof setTimeout> | null;
}

export function canonicalHttpOperationMethod(value: string): string {
  const method = value.toUpperCase();
  if (!/^[A-Z]+$/.test(method)) {
    throw new ServiceError(400, "HTTP operation method is invalid", "invalid_request");
  }
  return method;
}

export function canonicalHttpOperationPath(value: string): string {
  if (!value.startsWith("/api/")
    || value.includes("?")
    || value.includes("#")
    || value.includes("//")) {
    throw new ServiceError(400, "HTTP operation path is invalid", "invalid_request");
  }
  return value;
}

export function requestedHttpOperationLifetime(
  value: number | undefined
): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ServiceError(
      400,
      "requestedLifetimeMs must be a positive integer",
      "invalid_request"
    );
  }
  return value;
}

export function requireHttpOperationMutationId(
  value: string | undefined,
  method: HttpSupervisedOperationDescriptor["operation"]
): string | null {
  if (!isWorkerMutationMethod(method)) {
    if (value !== undefined) {
      throw new ServiceError(
        400,
        "Read-only HTTP operations cannot carry mutationId",
        "invalid_request"
      );
    }
    return null;
  }
  try {
    return requireLedgerMutationId(value);
  } catch {
    throw new ServiceError(
      400,
      "Mutating HTTP operations require a canonical mutationId",
      "invalid_request"
    );
  }
}

export function requireHttpOperationExpectedStoryVersion(
  value: StoryAggregateVersion | undefined,
  scope: HttpCapabilityScope,
  method: HttpSupervisedOperationDescriptor["operation"]
): StoryAggregateVersion | null {
  const storyMutation = scope === "story" && isWorkerMutationMethod(method);
  if (!storyMutation) {
    if (value !== undefined) {
      throw new ServiceError(
        400,
        "Only mutating story operations can carry expectedAggregateVersion",
        "invalid_request"
      );
    }
    return null;
  }
  if (value === undefined) {
    throw new ServiceError(
      400,
      "Mutating story operations require expectedAggregateVersion",
      "invalid_request"
    );
  }
  try {
    const version = parseStoryAggregateVersion(
      value,
      "expectedAggregateVersion"
    );
    const createsStory = method === "createStory"
      || method === "importSillyTavern"
      || method === "importMarkdown";
    if (createsStory !== (version.kind === "absent")) {
      throw new Error(
        createsStory
          ? `${method} requires an absent aggregate version`
          : `${method} requires an existing aggregate version`
      );
    }
    return version;
  } catch (error) {
    throw new ServiceError(
      400,
      error instanceof Error ? error.message : "expectedAggregateVersion is invalid",
      "invalid_request"
    );
  }
}

export function httpOperationKey(sessionId: string, sequence: bigint): string {
  return `${sessionId}:${sequence}`;
}

export function httpOperationStatusResponse(
  listenerInstanceId: string,
  operation: HttpOperationRecord
): HttpOperationStatusResponse {
  return {
    listenerInstanceId,
    sessionId: operation.sessionId,
    sequence: operation.sequence.toString(),
    state: operation.state,
    terminal: isTerminalHttpOperationState(operation.state),
    cancelRequested: operation.cancelRequested
  };
}

export function operationSessionTerminal(): ServiceError {
  return new ServiceError(
    410,
    "HTTP operation session is terminal",
    "operation_session_terminal"
  );
}

export function operationSessionUnauthorized(): ServiceError {
  return new ServiceError(
    401,
    "Missing or invalid HTTP operation-session capability",
    "unauthorized"
  );
}

export function operationAdmissionBusy(message: string): ServiceError {
  return new ServiceError(503, message, "resource_busy");
}

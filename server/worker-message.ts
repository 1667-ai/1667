import {
  LEGACY_WORKER_PROTOCOL_VERSION,
  PRE_Q_WORKER_PROTOCOL_VERSION,
  PREDECESSOR_WORKER_PROTOCOL_VERSION,
  WORKER_PROTOCOL_VERSION,
  isMutatingWorkerMethod,
  isWorkerMutationMethod,
  isWorkerMethod,
  isWorkerOperationId,
  type MainToWorkerMessage,
  type WorkerOperationId
} from "../shared/worker-protocol.js";
import { ServiceError } from "./errors.js";
import { requireString } from "./validation.js";

export function parseWorkerBootstrap(
  message: Record<string, unknown>
): Extract<MainToWorkerMessage, { type: "bootstrap" }> {
  if (message.externalDataLock !== true) {
    throw new ServiceError(400, "bootstrap must retain the external data lock");
  }
  return {
    type: "bootstrap",
    dataDir: requireString(message.dataDir, "dataDir"),
    externalDataLock: true,
    ...(message.machineDir === undefined
      ? {}
      : { machineDir: requireString(message.machineDir, "machineDir") }),
    ...(message.freshDataDirectory === true ? { freshDataDirectory: true } as const : {})
  };
}

export function parseWorkerRequest(
  message: Record<string, unknown>,
  id: WorkerOperationId
): Extract<MainToWorkerMessage, { type: "request" }> {
  if (!isWorkerMethod(message.method)) throw new ServiceError(400, "Unknown worker method");
  const legacyEnvelopeMutation = isMutatingWorkerMethod(message.method);
  const deadlineMs = message.deadlineMs;
  if (typeof deadlineMs !== "number" || !Number.isSafeInteger(deadlineMs)) {
    throw new ServiceError(400, "Worker request deadline must be an integer timestamp");
  }
  const mutationId = message.mutationId === undefined
    ? undefined
    : requireString(message.mutationId, "mutationId");
  if (legacyEnvelopeMutation && mutationId === undefined) {
    throw new ServiceError(400, "Mutating worker requests require a mutation ID");
  }
  if (!legacyEnvelopeMutation && mutationId !== undefined) {
    throw new ServiceError(400, "This worker request must not include an outer mutation ID");
  }
  const protocolVersion = message.protocolVersion;
  if (!Number.isSafeInteger(protocolVersion)
    || (protocolVersion !== WORKER_PROTOCOL_VERSION
      && !(legacyEnvelopeMutation
        && (protocolVersion === LEGACY_WORKER_PROTOCOL_VERSION
          || protocolVersion === PRE_Q_WORKER_PROTOCOL_VERSION
          || protocolVersion === PREDECESSOR_WORKER_PROTOCOL_VERSION)))) {
    throw new ServiceError(400, "Unsupported worker request protocol version");
  }
  return {
    type: "request",
    id,
    method: message.method,
    input: message.input,
    protocolVersion,
    deadlineMs,
    mutationId,
    ...(message.expectedAggregateVersion === undefined ? {} : {
      expectedAggregateVersion: message.expectedAggregateVersion
    })
  };
}

export function parseWorkerOperationId(value: unknown): WorkerOperationId {
  if (!isWorkerOperationId(value)) {
    throw new ServiceError(400, "Malformed worker operation ID");
  }
  return Object.freeze({
    workerInstanceId: value.workerInstanceId,
    sequence: value.sequence
  });
}

export function rawWorkerMutationOutcome(
  message: Record<string, unknown>
): "terminal" | undefined {
  return isWorkerMethod(message.method) && isMutatingWorkerMethod(message.method)
    ? "terminal"
    : undefined;
}

export function preServiceWorkerMutationOutcome(
  message: Record<string, unknown>
): "terminal" | undefined {
  return isWorkerMethod(message.method) && isWorkerMutationMethod(message.method)
    ? "terminal"
    : undefined;
}

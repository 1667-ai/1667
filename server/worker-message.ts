import {
  LEGACY_WORKER_PROTOCOL_VERSION,
  PRE_Q_WORKER_PROTOCOL_VERSION,
  PREDECESSOR_WORKER_PROTOCOL_VERSION,
  canonicalWorkerInputProtocolVersion,
  isCurrentWorkerInputProtocolVersion,
  isManifestOnlyDurabilityEligible,
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
    ...(message.printLogs === true ? { printLogs: true } as const : {}),
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
    || (!isCurrentWorkerInputProtocolVersion(protocolVersion)
      && !(legacyEnvelopeMutation
        && (protocolVersion === LEGACY_WORKER_PROTOCOL_VERSION
          || protocolVersion === PRE_Q_WORKER_PROTOCOL_VERSION
          || protocolVersion === PREDECESSOR_WORKER_PROTOCOL_VERSION)))) {
    throw new ServiceError(400, "Unsupported worker request protocol version");
  }
  if (message.durability !== undefined) {
    if (message.durability !== "manifest-only") {
      throw new ServiceError(400, "Worker request durability must be manifest-only when present");
    }
    // The marker is a caller promise that no durable replay source exists
    // and that losing the request re-costs at most one human action. The
    // shared eligibility predicate mirrors the transport's marker site, so a
    // marked request that embeds irreplaceable content — for example a
    // createNode settling a stopped generation — fails closed here.
    if (!isManifestOnlyDurabilityEligible(message.method, message.input)
      || message.expectedAggregateVersion === undefined) {
      throw new ServiceError(
        400,
        "Manifest-only durability requires an eligible local mutation with an expected aggregate version"
      );
    }
  }
  return {
    type: "request",
    id,
    method: message.method,
    input: message.input,
    protocolVersion: canonicalWorkerInputProtocolVersion(protocolVersion),
    deadlineMs,
    mutationId,
    ...(message.expectedAggregateVersion === undefined ? {} : {
      expectedAggregateVersion: message.expectedAggregateVersion
    }),
    ...(message.durability === undefined ? {} : {
      durability: "manifest-only" as const
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

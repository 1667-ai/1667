import {
  isWorkerInstanceId,
  isWorkerOperationId,
  type WorkerOperationId,
  type WorkerOperationState,
  type WorkerToMainMessage
} from "../../shared/worker-protocol.js";
import { parseBuildIdentity } from "../../shared/build-identity.js";
import { decodeFailureEnvelope } from "../../shared/failure-envelope.js";

export function isWorkerMessage(value: unknown): value is WorkerToMainMessage {
  return decodeWorkerMessage(value) !== null;
}

export function decodeWorkerMessage(
  value: unknown
): WorkerToMainMessage | null {
  try {
    if (!isRecord(value)) return null;
    switch (value.type) {
      case "stopped":
        return hasExactKeys(value, ["type"])
          ? Object.freeze({ type: "stopped" })
          : null;
      case "starting":
      case "ready":
        return decodeLifecycleMessage(value);
      case "protocolError":
        return decodeProtocolError(value);
      case "result":
      case "complete":
        return decodeResultMessage(value);
      case "operation":
        return decodeOperationMessage(value);
      case "delta":
        return decodeDeltaMessage(value);
      case "error":
        return decodeErrorMessage(value);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function decodeLifecycleMessage(
  message: Record<string, unknown>
): WorkerToMainMessage | null {
  if (!hasExactKeys(message, [
    "type",
    "protocolVersion",
    "buildIdentity",
    "workerInstanceId"
  ])
    || (message.type !== "starting" && message.type !== "ready")
    || typeof message.protocolVersion !== "number"
    || !Number.isSafeInteger(message.protocolVersion)
    || !isWorkerInstanceId(message.workerInstanceId)) {
    return null;
  }
  return Object.freeze({
    type: message.type,
    protocolVersion: message.protocolVersion,
    buildIdentity: parseBuildIdentity(message.buildIdentity),
    workerInstanceId: message.workerInstanceId
  });
}

function decodeProtocolError(
  message: Record<string, unknown>
): WorkerToMainMessage | null {
  if (!hasExactKeys(message, ["type", "failure"])) return null;
  const failure = decodeFailureEnvelope(message.failure);
  return failure === null
    ? null
    : Object.freeze({ type: "protocolError", failure });
}

function decodeResultMessage(
  message: Record<string, unknown>
): WorkerToMainMessage | null {
  if (!hasExactKeys(message, ["type", "id", "value"])
    || (message.type !== "result" && message.type !== "complete")) {
    return null;
  }
  const id = decodeOperationId(message.id);
  return id === null
    ? null
    : Object.freeze({ type: message.type, id, value: message.value });
}

function decodeOperationMessage(
  message: Record<string, unknown>
): WorkerToMainMessage | null {
  if (!hasExactKeys(message, ["type", "id", "state", "terminal"])) {
    return null;
  }
  const id = decodeOperationId(message.id);
  const state = decodeOperationState(message.state);
  if (id === null
    || state === null
    || message.terminal !== (state !== "running")) {
    return null;
  }
  return Object.freeze({
    type: "operation",
    id,
    state,
    terminal: message.terminal
  });
}

function decodeDeltaMessage(
  message: Record<string, unknown>
): WorkerToMainMessage | null {
  if (!hasExactKeys(message, ["type", "id", "sequence", "text"])) return null;
  const id = decodeOperationId(message.id);
  if (id === null
    || typeof message.sequence !== "number"
    || !Number.isSafeInteger(message.sequence)
    || message.sequence < 0
    || typeof message.text !== "string") {
    return null;
  }
  return Object.freeze({
    type: "delta",
    id,
    sequence: message.sequence,
    text: message.text
  });
}

function decodeErrorMessage(
  message: Record<string, unknown>
): WorkerToMainMessage | null {
  if (!hasExactKeys(
    message,
    ["type", "id", "failure"],
    ["mutationOutcome"]
  )) return null;
  const id = decodeOperationId(message.id);
  const failure = decodeFailureEnvelope(message.failure);
  const outcome = message.mutationOutcome;
  if (id === null
    || failure === null
    || (outcome !== undefined
      && outcome !== "terminal"
      && outcome !== "uncertain")) {
    return null;
  }
  return Object.freeze({
    type: "error",
    id,
    failure,
    ...(outcome === undefined ? {} : { mutationOutcome: outcome })
  });
}

function decodeOperationId(value: unknown): WorkerOperationId | null {
  return isWorkerOperationId(value)
    ? Object.freeze({
        workerInstanceId: value.workerInstanceId,
        sequence: value.sequence
      })
    : null;
}

function decodeOperationState(value: unknown): WorkerOperationState | null {
  return value === "running"
    || value === "completed"
    || value === "canceled"
    || value === "failed"
    || value === "unknown"
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) =>
    Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => allowed.has(key));
}

export function isShutdownTerminalMessage(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && (value as { type?: unknown }).type === "stopped";
}

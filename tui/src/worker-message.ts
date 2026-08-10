import {
  MAX_DELTA_BATCH_BYTES,
  MAX_UNACKNOWLEDGED_DELTA_BYTES,
  isWorkerInstanceId,
  isWorkerOperationId,
  type WorkerOperationId,
  type WorkerOperationState,
  type WorkerToMainMessage
} from "../../shared/worker-protocol.js";
import {
  isProviderMutationId
} from "../../shared/provider-recovery.js";
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
  if ((message.type !== "result" && message.type !== "complete")
    || !hasExactKeys(
      message,
      ["type", "id", "value"],
      message.type === "complete" ? ["stoppedText"] : []
    )) {
    return null;
  }
  const id = decodeOperationId(message.id);
  const stoppedText = message.stoppedText;
  if (id === null
    || (stoppedText !== undefined
      && (typeof stoppedText !== "string"
        || stoppedText.length === 0
        || new TextEncoder().encode(stoppedText).byteLength
          > MAX_DELTA_BATCH_BYTES))) {
    return null;
  }
  return Object.freeze({
    type: message.type,
    id,
    value: message.value,
    ...(stoppedText === undefined ? {} : { stoppedText })
  });
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
  if (!hasExactKeys(message, ["type", "id", "sequence", "text"], ["reasoning"])) return null;
  const id = decodeOperationId(message.id);
  const reasoning = decodeDeltaReasoning(message.reasoning);
  if (id === null
    || typeof message.sequence !== "number"
    || !Number.isSafeInteger(message.sequence)
    || message.sequence < 0
    || typeof message.text !== "string"
    || reasoning === undefined) {
    return null;
  }
  return Object.freeze({
    type: "delta",
    id,
    sequence: message.sequence,
    text: message.text,
    ...(reasoning === null ? {} : { reasoning })
  });
}

/** null = the field was absent (a prose delta, the common case); undefined
 *  = present but malformed, which the caller treats as a decode failure. */
function decodeDeltaReasoning(
  value: unknown
): { tokenCount: number } | null | undefined {
  if (value === undefined) return null;
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || !hasExactKeys(value as Record<string, unknown>, ["tokenCount"])
  ) return undefined;
  const tokenCount = (value as Record<string, unknown>).tokenCount;
  return typeof tokenCount === "number"
    && Number.isSafeInteger(tokenCount)
    && tokenCount >= 0
    ? Object.freeze({ tokenCount })
    : undefined;
}

function decodeErrorMessage(
  message: Record<string, unknown>
): WorkerToMainMessage | null {
  if (!hasExactKeys(
    message,
    ["type", "id", "failure"],
    ["mutationOutcome", "providerMutationId", "unsentText"]
  )) return null;
  const id = decodeOperationId(message.id);
  const failure = decodeFailureEnvelope(message.failure);
  const outcome = message.mutationOutcome;
  const providerMutationId = message.providerMutationId;
  // The reclaimed tail spans at most the credit window plus one buffered
  // batch, so the transport bound is the window total, not one batch.
  const unsentText = message.unsentText;
  if (id === null
    || failure === null
    || (providerMutationId !== undefined
      && !isProviderMutationId(providerMutationId))
    || (outcome !== undefined
      && outcome !== "terminal"
      && outcome !== "uncertain")
    || (unsentText !== undefined
      && (typeof unsentText !== "string"
        || unsentText.length === 0
        || new TextEncoder().encode(unsentText).byteLength
          > MAX_UNACKNOWLEDGED_DELTA_BYTES))) {
    return null;
  }
  return Object.freeze({
    type: "error",
    id,
    failure,
    ...(providerMutationId === undefined
      ? {}
      : { providerMutationId }),
    ...(outcome === undefined ? {} : { mutationOutcome: outcome }),
    ...(unsentText === undefined ? {} : { unsentText })
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

import {
  decodeFailureEnvelope,
  type FailureEnvelope
} from "./failure-envelope.js";
import {
  isProviderMutationId,
  type ProviderRecoveryContext
} from "./provider-recovery.js";
import {
  parseStoryAggregateVersion,
  type StoryAggregateVersion
} from "./story-aggregate-version.js";
import {
  isWorkerOperationId,
  isWorkerMethod,
  workerOperationKey,
  type MainToWorkerMessage,
  type WorkerOperationId,
  type WorkerToMainMessage,
  type WorkerCancelReason,
  type WorkerMethod
} from "./worker-protocol.js";

/** IPC channel used by the preload script to transfer one MessagePort. */
export const DESKTOP_PORT_CONNECT_CHANNEL = "1667:desktop-port";

/** Window message used by preload to deliver the other end of the port. */
export const DESKTOP_PORT_WINDOW_MESSAGE = "1667:desktop-port-ready";

/** Keep the Renderer-facing credit window equal to the Worker-facing bound. */
export const DESKTOP_MAX_UNACKNOWLEDGED_DELTA_BATCHES = 8;

/** Correlation exists only until the Host allocates a worker-shaped id. */
export type DesktopCallId = string;

export interface DesktopRecoveryWarning {
  readonly mutationId: string;
  readonly method: WorkerMethod;
  readonly storyId: string | null;
  readonly providerRecovery?: ProviderRecoveryContext;
  readonly resolution: "archived" | "cleared";
  readonly error: FailureEnvelope;
}

type WorkerRequest = Extract<MainToWorkerMessage, { type: "request" }>;
type WorkerAck = Extract<MainToWorkerMessage, { type: "ack" }>;
type WorkerCancel = Extract<MainToWorkerMessage, { type: "cancel" }>;
type WorkerTerminalAck = Extract<MainToWorkerMessage, { type: "terminalAck" }>;
type WorkerResult = Extract<WorkerToMainMessage, { type: "result" }>;
type WorkerError = Extract<WorkerToMainMessage, { type: "error" }>;
type WorkerDelta = Extract<WorkerToMainMessage, { type: "delta" }>;
type WorkerComplete = Extract<WorkerToMainMessage, { type: "complete" }>;
type WorkerOperation = Extract<WorkerToMainMessage, { type: "operation" }>;
type WorkerProtocolError = Extract<WorkerToMainMessage, { type: "protocolError" }>;

/**
 * Renderer request. The Host fills the worker id, protocol, deadline, and
 * mutation durability fields. The Renderer never controls those fields.
 */
export type DesktopRendererRequest = Omit<WorkerRequest,
  "id" | "protocolVersion" | "deadlineMs" | "mutationId" | "durability"
  | "expectedAggregateVersion"
> & {
  readonly callId: DesktopCallId;
  readonly expectedAggregateVersion?: StoryAggregateVersion;
};

export type DesktopRendererMessage =
  | DesktopRendererRequest
  | WorkerAck
  | WorkerCancel
  | WorkerTerminalAck
  | {
      readonly type: "dismissArchivedMutation";
      readonly callId: DesktopCallId;
      readonly mutationId: string;
    };

/** Main messages use the existing worker protocol shapes wherever possible. */
export type DesktopMainMessage =
  | WorkerResult
  | WorkerError
  | WorkerDelta
  | WorkerComplete
  | WorkerOperation
  | WorkerProtocolError
  | {
      /** Host allocated the worker-shaped id for the pending call. */
      readonly type: "accepted";
      readonly callId: DesktopCallId;
      readonly id: WorkerOperationId;
    }
  | {
      /** Host rejected a call before it allocated a worker operation. */
      readonly type: "rejected";
      readonly callId: DesktopCallId;
      readonly failure: FailureEnvelope;
    }
  | {
      /** Terminal reasoning tail has no field in the frozen worker protocol. */
      readonly type: "reasoningStopped";
      readonly id: WorkerOperationId;
      readonly text: string;
    }
  | {
      readonly type: "dismissedArchivedMutation";
      readonly callId: DesktopCallId;
      readonly mutationId: string;
    }
  | {
      readonly type: "dismissalError";
      readonly callId: DesktopCallId;
      readonly mutationId: string;
      readonly failure: FailureEnvelope;
    }
  | {
      readonly type: "recoveryWarnings";
      readonly warnings: readonly DesktopRecoveryWarning[];
    };

const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

/** Decode a Renderer message before it reaches the Host. */
export function decodeDesktopRendererMessage(
  value: unknown
): DesktopRendererMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "request":
      return decodeRequest(value);
    case "ack":
      return hasExactKeys(value, ["type", "id", "sequence"])
        && isWorkerOperationId(value.id)
        && isSequence(value.sequence)
        ? value as DesktopRendererMessage
        : null;
    case "cancel":
      return hasExactKeys(value, ["type", "id", "reason"])
        && isWorkerOperationId(value.id)
        && isCancelReason(value.reason)
        ? value as DesktopRendererMessage
        : null;
    case "terminalAck":
      return hasExactKeys(value, ["type", "id"])
        && isWorkerOperationId(value.id)
        ? value as DesktopRendererMessage
        : null;
    case "dismissArchivedMutation":
      return hasExactKeys(value, ["type", "callId", "mutationId"])
        && isCallId(value.callId)
        && isProviderMutationId(value.mutationId)
        ? value as DesktopRendererMessage
        : null;
    default:
      return null;
  }
}

/** Decode a main-process message before it reaches the Client facade. */
export function decodeDesktopMainMessage(
  value: unknown
): DesktopMainMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "accepted":
      return hasExactKeys(value, ["type", "callId", "id"])
        && isCallId(value.callId)
        && isWorkerOperationId(value.id)
        ? value as DesktopMainMessage
        : null;
    case "rejected": {
      if (!hasExactKeys(value, ["type", "callId", "failure"])
        || !isCallId(value.callId)) return null;
      const failure = decodeFailureEnvelope(value.failure);
      return failure === null ? null : { ...value, failure } as DesktopMainMessage;
    }
    case "result":
      return hasExactKeys(value, ["type", "id", "value"])
        && isWorkerOperationId(value.id)
        ? value as DesktopMainMessage
        : null;
    case "delta":
      return decodeDelta(value);
    case "complete":
      return hasExactKeys(value, ["type", "id", "value"], ["stoppedText"])
        && isWorkerOperationId(value.id)
        && isOptionalText(value.stoppedText)
        ? value as DesktopMainMessage
        : null;
    case "error":
      return decodeError(value);
    case "operation":
      return hasExactKeys(value, ["type", "id", "state", "terminal"])
        && isWorkerOperationId(value.id)
        && isOperationState(value.state)
        && value.terminal === (value.state !== "running")
        ? value as DesktopMainMessage
        : null;
    case "protocolError": {
      if (!hasExactKeys(value, ["type", "failure"])) return null;
      const failure = decodeFailureEnvelope(value.failure);
      return failure === null ? null : { type: "protocolError", failure };
    }
    case "reasoningStopped":
      return hasExactKeys(value, ["type", "id", "text"])
        && isWorkerOperationId(value.id)
        && typeof value.text === "string"
        ? value as DesktopMainMessage
        : null;
    case "dismissedArchivedMutation":
      return hasExactKeys(value, ["type", "callId", "mutationId"])
        && isCallId(value.callId)
        && isProviderMutationId(value.mutationId)
        ? value as DesktopMainMessage
        : null;
    case "dismissalError": {
      if (!hasExactKeys(value, ["type", "callId", "mutationId", "failure"])
        || !isCallId(value.callId)
        || !isProviderMutationId(value.mutationId)) return null;
      const failure = decodeFailureEnvelope(value.failure);
      return failure === null ? null : { ...value, failure } as DesktopMainMessage;
    }
    case "recoveryWarnings":
      return hasExactKeys(value, ["type", "warnings"])
        && Array.isArray(value.warnings)
        ? value as DesktopMainMessage
        : null;
    default:
      return null;
  }
}

function decodeRequest(
  value: Record<string, unknown>
): DesktopRendererRequest | null {
  if (!hasExactKeys(value, ["type", "callId", "method", "input"], ["expectedAggregateVersion"])
    || !isCallId(value.callId)
    || typeof value.method !== "string") return null;
  // Reuse the worker protocol's single method registry.
  const method = value.method as WorkerMethod;
  if (!isWorkerMethod(method)) return null;
  if (value.expectedAggregateVersion === undefined) {
    return value as DesktopRendererRequest;
  }
  try {
    return {
      ...value,
      expectedAggregateVersion: parseStoryAggregateVersion(
        value.expectedAggregateVersion,
        "request.expectedAggregateVersion"
      )
    } as DesktopRendererRequest;
  } catch {
    return null;
  }
}

function decodeDelta(value: Record<string, unknown>): DesktopMainMessage | null {
  if (!hasExactKeys(value, ["type", "id", "sequence", "text"], ["reasoning"])
    || !isWorkerOperationId(value.id)
    || !isSequence(value.sequence)
    || typeof value.text !== "string") return null;
  if (value.reasoning !== undefined
    && (!isRecord(value.reasoning)
      || !hasExactKeys(value.reasoning, ["tokenCount"])
      || !isSequence(value.reasoning.tokenCount))) return null;
  return value as DesktopMainMessage;
}

function decodeError(value: Record<string, unknown>): DesktopMainMessage | null {
  if (!hasExactKeys(
    value,
    ["type", "id", "failure"],
    ["mutationOutcome", "providerMutationId", "unsentText"]
  ) || !isWorkerOperationId(value.id)) return null;
  const failure = decodeFailureEnvelope(value.failure);
  if (failure === null || !isOptionalText(value.unsentText)
    || (value.mutationOutcome !== undefined
      && value.mutationOutcome !== "terminal"
      && value.mutationOutcome !== "uncertain")
    || (value.providerMutationId !== undefined
      && !isProviderMutationId(value.providerMutationId))) return null;
  return { ...value, failure } as DesktopMainMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => allowed.has(key));
}

function isCallId(value: unknown): value is DesktopCallId {
  return typeof value === "string" && CALL_ID_PATTERN.test(value);
}

function isSequence(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}

function isCancelReason(value: unknown): value is WorkerCancelReason {
  return value === "user" || value === "deadline" || value === "shutdown";
}

function isOptionalText(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOperationState(value: unknown): boolean {
  return value === "running"
    || value === "completed"
    || value === "canceled"
    || value === "failed"
    || value === "unknown";
}

export { workerOperationKey };

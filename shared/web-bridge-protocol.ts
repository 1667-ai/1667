import {
  isBuildIdentity,
  type BuildIdentity
} from "./build-identity.js";
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
  MAX_UNACKNOWLEDGED_DELTA_BATCHES,
  isWorkerOperationId,
  isWorkerMethod,
  workerOperationKey,
  type MainToWorkerMessage,
  type WorkerOperationId,
  type WorkerToMainMessage,
  type WorkerCancelReason,
  type WorkerMethod
} from "./worker-protocol.js";

/** WebSocket subprotocol the browser and `host/web-bridge-server.ts` both
 * advertise. The server never echoes any other offered protocol, including
 * the token below, back to the client. */
export const WEB_BRIDGE_SUBPROTOCOL = "1667.bridge.1";

/** Prefix on the second `Sec-WebSocket-Protocol` offer that carries the
 * per-run token, the same one `/api/status` requires as a bearer credential. */
export const WEB_BRIDGE_TOKEN_PREFIX = "1667.token.";

/** The one path `host/web-bridge-server.ts` upgrades. */
export const WEB_BRIDGE_PATH = "/api/bridge";

/** Bun's `ws` shim does not enforce its own `maxPayload` (verified against
 * Bun 1.3.14): the bridge server checks every inbound frame's byte length
 * itself and closes 1009 over this bound. */
export const MAX_BRIDGE_MESSAGE_BYTES = 32 * 1024 * 1024;

/** One browser can open several tabs; each tab gets its own bridge over the
 * shared host, up to this many at once. */
export const MAX_BRIDGE_CONNECTIONS = 8;

/** Keep the browser-facing credit window equal to the Worker-facing bound. */
export const WEB_BRIDGE_MAX_UNACKNOWLEDGED_DELTA_BATCHES = MAX_UNACKNOWLEDGED_DELTA_BATCHES;

/** Correlation exists only until the Host allocates a worker-shaped id. */
export type BridgeCallId = string;

export interface BridgeRecoveryWarning {
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
 * Browser request. The Host fills the worker id, protocol, deadline, and
 * mutation durability fields. The browser never controls those fields.
 */
export type BridgeClientRequest = Omit<WorkerRequest,
  "id" | "protocolVersion" | "deadlineMs" | "mutationId" | "durability"
  | "expectedAggregateVersion"
> & {
  readonly callId: BridgeCallId;
  readonly expectedAggregateVersion?: StoryAggregateVersion;
};

export type BridgeClientMessage =
  | BridgeClientRequest
  | WorkerAck
  | WorkerCancel
  | WorkerTerminalAck
  | {
      readonly type: "dismissArchivedMutation";
      readonly callId: BridgeCallId;
      readonly mutationId: string;
    };

/** Host messages use the existing worker protocol shapes wherever possible. */
export type BridgeHostMessage =
  | WorkerResult
  | WorkerError
  | WorkerDelta
  | WorkerComplete
  | WorkerOperation
  | WorkerProtocolError
  | {
      /** The first frame on every connection, before any request can be
       * accepted. `openWebBridgeTransport` resolves only after this arrives;
       * a `workerProtocolVersion` the browser bundle does not share with the
       * running host closes the socket and rejects with a clear error, so a
       * stale tab left open across an upgrade never sends a request the host
       * cannot answer. */
      readonly type: "hello";
      readonly workerProtocolVersion: number;
      readonly build: BuildIdentity;
      readonly recoveryWarnings: readonly BridgeRecoveryWarning[];
    }
  | {
      /** Host allocated the worker-shaped id for the pending call. */
      readonly type: "accepted";
      readonly callId: BridgeCallId;
      readonly id: WorkerOperationId;
    }
  | {
      /** Host rejected a call before it allocated a worker operation. */
      readonly type: "rejected";
      readonly callId: BridgeCallId;
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
      readonly callId: BridgeCallId;
      readonly mutationId: string;
    }
  | {
      readonly type: "dismissalError";
      readonly callId: BridgeCallId;
      readonly mutationId: string;
      readonly failure: FailureEnvelope;
    }
  | {
      readonly type: "recoveryWarnings";
      readonly warnings: readonly BridgeRecoveryWarning[];
    };

export const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

/**
 * `WorkerOperationId.sequence` is a native `bigint`. `JSON.stringify` throws
 * on one without a replacer — the removed desktop bridge never needed this,
 * because Electron's `MessagePort` carries a `bigint` through structured
 * clone unchanged, and this bridge's frames are JSON text instead. Every
 * frame on this bridge goes through `encodeBridgeMessage`/
 * `decodeBridgeMessageText` rather than a bare `JSON.stringify`/`JSON.parse`,
 * so this is the one place that conversion happens. The reviver requires a
 * `workerInstanceId` sibling before it treats a `"sequence"` string as one,
 * because `ack` and `delta` each carry their own unrelated numeric
 * `sequence` alongside an `id`.
 */
function bridgeJsonReplacer(this: unknown, _key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function bridgeJsonReviver(this: unknown, key: string, value: unknown): unknown {
  return key === "sequence"
    && isRecord(this)
    && typeof this.workerInstanceId === "string"
    && typeof value === "string"
    && /^[0-9]+$/u.test(value)
    ? BigInt(value)
    : value;
}

/** Encode one frame for the wire. Both ends of this bridge use this instead
 * of a bare `JSON.stringify`, for `bridgeJsonReplacer` above. */
export function encodeBridgeMessage(
  message: BridgeClientMessage | BridgeHostMessage
): string {
  return JSON.stringify(message, bridgeJsonReplacer);
}

/** Parse one frame off the wire, before `decodeBridgeClientMessage` /
 * `decodeBridgeHostMessage` validate its shape. Returns `null` rather than
 * throwing on text that is not valid JSON, matching every other decoder in
 * this module. */
export function decodeBridgeMessageText(raw: string): unknown {
  try {
    return JSON.parse(raw, bridgeJsonReviver);
  } catch {
    return null;
  }
}

/** The three methods that carry a binary field the JSON wire cannot hold
 * directly (verified against `shared/worker-protocol.ts`'s `WorkerMethodContract`).
 * Every other method's input crosses the bridge unchanged. */
const BINARY_INPUT_FIELD: Partial<Record<WorkerMethod, string>> = {
  importLorebook: "archiveBytes",
  importCard: "cardBytes",
  stageStoryImage: "bytes"
};

const BASE64_CHUNK_LENGTH = 0x8000;

/** `btoa`/`atob` only: both ends of this bridge run without Node's `Buffer`
 * (the browser has none, and `client/web-bridge-transport.ts` is checked to
 * run with browser globals only). Chunked so `String.fromCharCode` never
 * receives more arguments than an engine's call-stack allows. */
function bridgeBytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_LENGTH) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_LENGTH));
  }
  return btoa(binary);
}

function base64ToBridgeBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Replace a request's binary field with base64 before it joins a JSON
 * frame. Every other method's input returns unchanged. */
export function encodeBridgeRequestInput(method: WorkerMethod, input: unknown): unknown {
  const field = BINARY_INPUT_FIELD[method];
  if (field === undefined || !isRecord(input)) return input;
  const bytes = input[field];
  return bytes instanceof Uint8Array
    ? { ...input, [field]: bridgeBytesToBase64(bytes) }
    : input;
}

/** Reverse `encodeBridgeRequestInput` once a request's JSON frame is parsed. */
export function decodeBridgeRequestInput(method: WorkerMethod, input: unknown): unknown {
  const field = BINARY_INPUT_FIELD[method];
  if (field === undefined || !isRecord(input)) return input;
  const encoded = input[field];
  return typeof encoded === "string"
    ? { ...input, [field]: base64ToBridgeBytes(encoded) }
    : input;
}

/** Decode a browser message before it reaches the Host. */
export function decodeBridgeClientMessage(
  value: unknown
): BridgeClientMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "request":
      return decodeRequest(value);
    case "ack":
      return hasExactKeys(value, ["type", "id", "sequence"])
        && isWorkerOperationId(value.id)
        && isSequence(value.sequence)
        ? value as BridgeClientMessage
        : null;
    case "cancel":
      return hasExactKeys(value, ["type", "id", "reason"])
        && isWorkerOperationId(value.id)
        && isCancelReason(value.reason)
        ? value as BridgeClientMessage
        : null;
    case "terminalAck":
      return hasExactKeys(value, ["type", "id"])
        && isWorkerOperationId(value.id)
        ? value as BridgeClientMessage
        : null;
    case "dismissArchivedMutation":
      return hasExactKeys(value, ["type", "callId", "mutationId"])
        && isCallId(value.callId)
        && isProviderMutationId(value.mutationId)
        ? value as BridgeClientMessage
        : null;
    default:
      return null;
  }
}

/** Decode a Host message before it reaches the browser facade. */
export function decodeBridgeHostMessage(
  value: unknown
): BridgeHostMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "hello":
      return hasExactKeys(value, ["type", "workerProtocolVersion", "build", "recoveryWarnings"])
        && isSequence(value.workerProtocolVersion)
        && isBuildIdentity(value.build)
        && Array.isArray(value.recoveryWarnings)
        ? value as BridgeHostMessage
        : null;
    case "accepted":
      return hasExactKeys(value, ["type", "callId", "id"])
        && isCallId(value.callId)
        && isWorkerOperationId(value.id)
        ? value as BridgeHostMessage
        : null;
    case "rejected": {
      if (!hasExactKeys(value, ["type", "callId", "failure"])
        || !isCallId(value.callId)) return null;
      const failure = decodeFailureEnvelope(value.failure);
      return failure === null ? null : { ...value, failure } as BridgeHostMessage;
    }
    case "result":
      // `value` is optional on the wire: `JSON.stringify` drops a key whose
      // value is `undefined`, which a resolved call's result can be.
      return hasExactKeys(value, ["type", "id"], ["value"])
        && isWorkerOperationId(value.id)
        ? value as BridgeHostMessage
        : null;
    case "delta":
      return decodeDelta(value);
    case "complete":
      return hasExactKeys(value, ["type", "id"], ["value", "stoppedText"])
        && isWorkerOperationId(value.id)
        && isOptionalText(value.stoppedText)
        ? value as BridgeHostMessage
        : null;
    case "error":
      return decodeError(value);
    case "operation":
      return hasExactKeys(value, ["type", "id", "state", "terminal"])
        && isWorkerOperationId(value.id)
        && isOperationState(value.state)
        && value.terminal === (value.state !== "running")
        ? value as BridgeHostMessage
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
        ? value as BridgeHostMessage
        : null;
    case "dismissedArchivedMutation":
      return hasExactKeys(value, ["type", "callId", "mutationId"])
        && isCallId(value.callId)
        && isProviderMutationId(value.mutationId)
        ? value as BridgeHostMessage
        : null;
    case "dismissalError": {
      if (!hasExactKeys(value, ["type", "callId", "mutationId", "failure"])
        || !isCallId(value.callId)
        || !isProviderMutationId(value.mutationId)) return null;
      const failure = decodeFailureEnvelope(value.failure);
      return failure === null ? null : { ...value, failure } as BridgeHostMessage;
    }
    case "recoveryWarnings":
      return hasExactKeys(value, ["type", "warnings"])
        && Array.isArray(value.warnings)
        ? value as BridgeHostMessage
        : null;
    default:
      return null;
  }
}

function decodeRequest(
  value: Record<string, unknown>
): BridgeClientRequest | null {
  if (!hasExactKeys(value, ["type", "callId", "method", "input"], ["expectedAggregateVersion"])
    || !isCallId(value.callId)
    || typeof value.method !== "string") return null;
  // Reuse the worker protocol's single method registry.
  const method = value.method as WorkerMethod;
  if (!isWorkerMethod(method)) return null;
  if (value.expectedAggregateVersion === undefined) {
    return value as BridgeClientRequest;
  }
  try {
    return {
      ...value,
      expectedAggregateVersion: parseStoryAggregateVersion(
        value.expectedAggregateVersion,
        "request.expectedAggregateVersion"
      )
    } as BridgeClientRequest;
  } catch {
    return null;
  }
}

function decodeDelta(value: Record<string, unknown>): BridgeHostMessage | null {
  if (!hasExactKeys(value, ["type", "id", "sequence", "text"], ["reasoning"])
    || !isWorkerOperationId(value.id)
    || !isSequence(value.sequence)
    || typeof value.text !== "string") return null;
  if (value.reasoning !== undefined
    && (!isRecord(value.reasoning)
      || !hasExactKeys(value.reasoning, ["tokenCount"])
      || !isSequence(value.reasoning.tokenCount))) return null;
  return value as BridgeHostMessage;
}

function decodeError(value: Record<string, unknown>): BridgeHostMessage | null {
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
  return { ...value, failure } as BridgeHostMessage;
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

function isCallId(value: unknown): value is BridgeCallId {
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

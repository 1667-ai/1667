import type { HttpCapabilityScope } from "./http-auth.js";
import { parseCanonicalLoopbackOrigin } from "./http-loopback-origin.js";
import type {
  HttpOperationReservationRequest,
  HttpOperationReservationResponse,
  HttpOperationLifetime
} from "./http-operation-protocol.js";
import { HTTP_OPERATION_LIFETIME_MS } from "./http-operation-protocol.js";
import {
  isWorkerMethod,
  isWorkerMutationMethod,
  messageByteLength
} from "./worker-protocol.js";
import { isDurableMutationId } from "./durable-mutation-id.js";
import {
  MAX_CREDENTIAL_NAMES_PER_STATE,
  isCredentialEnvironmentName
} from "./credential-slot-policy.js";
import {
  isDiagnosticReference,
  type DiagnosticReference
} from "./diagnostic-reference.js";
export { isCredentialEnvironmentName } from "./credential-slot-policy.js";

export const SUPERVISED_SERVE_PROTOCOL_VERSION = 1;
export const SUPERVISED_SERVE_DESCRIPTOR_CAPACITY = 1_024;
export const SUPERVISED_SERVE_IPC_MAX_BYTES = 256 * 1_024;

export interface HttpSupervisedOperationDescriptor {
  readonly listenerInstanceId: string;
  readonly sessionId: string;
  readonly sequence: string;
  readonly scope: HttpCapabilityScope;
  readonly operation: HttpOperationReservationRequest["operation"];
  readonly mutationId: string | null;
  readonly lifetime: HttpOperationReservationResponse["lifetime"];
  readonly deadlineDelayMs: number;
}

export type SupervisedRecoveryState =
  | "committed"
  | "not-committed"
  | "generation-outcome-unknown";

export type ChildToSupervisorMessage =
  | { readonly type: "secret-request"; readonly names: readonly string[] }
  | { readonly type: "secret-ack" }
  | { readonly type: "reserve"; readonly requestId: string; readonly descriptor: HttpSupervisedOperationDescriptor }
  | { readonly type: "terminal"; readonly descriptor: HttpSupervisedOperationDescriptor }
  | {
      readonly type: "hard-deadline";
      readonly sessionId: string;
      readonly sequence: string;
    }
  | {
      readonly type: "recovered";
      readonly results: readonly {
        readonly sessionId: string;
        readonly sequence: string;
        readonly state: SupervisedRecoveryState;
      }[];
    }
  | { readonly type: "ready"; readonly origin: string; readonly dataDir: string }
  | {
      readonly type: "fatal";
      readonly message: string;
      readonly diagnosticRef?: DiagnosticReference;
    };

export type SupervisorToChildMessage =
  | { readonly type: "reserve-ack"; readonly requestId: string; readonly accepted: boolean }
  | { readonly type: "recover"; readonly descriptors: readonly HttpSupervisedOperationDescriptor[] }
  | { readonly type: "activate" }
  | { readonly type: "shutdown" };

export function supervisedOperationKey(
  descriptor: Pick<HttpSupervisedOperationDescriptor, "sessionId" | "sequence">
): string {
  return `${descriptor.sessionId}:${descriptor.sequence}`;
}

export function sameSupervisedOperationDescriptor(
  left: HttpSupervisedOperationDescriptor,
  right: HttpSupervisedOperationDescriptor
): boolean {
  return left.listenerInstanceId === right.listenerInstanceId
    && left.sessionId === right.sessionId
    && left.sequence === right.sequence
    && left.scope === right.scope
    && left.operation === right.operation
    && left.mutationId === right.mutationId
    && left.lifetime === right.lifetime
    && left.deadlineDelayMs === right.deadlineDelayMs;
}

export function decodeChildToSupervisorMessage(
  value: unknown
): ChildToSupervisorMessage {
  requireBoundedMessage(value);
  const message = record(value, "child message");
  switch (message.type) {
    case "secret-request": {
      exactKeys(message, ["type", "names"]);
      const names = stringArray(
        message.names,
        MAX_CREDENTIAL_NAMES_PER_STATE,
        64,
        "credential names"
      );
      if (names.some((name) => !isCredentialEnvironmentName(name))
        || names.some((name, index) =>
          index > 0 && names[index - 1]! >= name)) {
        throw invalid("credential names are invalid or not strictly sorted");
      }
      return { type: "secret-request", names };
    }
    case "secret-ack":
      exactKeys(message, ["type"]);
      return { type: "secret-ack" };
    case "reserve":
      exactKeys(message, ["type", "requestId", "descriptor"]);
      return {
        type: "reserve",
        requestId: boundedString(message.requestId, 160, "request ID"),
        descriptor: decodeDescriptor(message.descriptor)
      };
    case "terminal":
      exactKeys(message, ["type", "descriptor"]);
      return { type: "terminal", descriptor: decodeDescriptor(message.descriptor) };
    case "hard-deadline": {
      exactKeys(message, ["type", "sessionId", "sequence"]);
      const identity = decodeOperationIdentity(
        message.sessionId,
        message.sequence
      );
      return { type: "hard-deadline", ...identity };
    }
    case "recovered": {
      exactKeys(message, ["type", "results"]);
      if (!Array.isArray(message.results)
        || message.results.length > SUPERVISED_SERVE_DESCRIPTOR_CAPACITY) {
        throw invalid("recovery results exceed their bound");
      }
      return {
        type: "recovered",
        results: message.results.map(decodeRecoveryResult)
      };
    }
    case "ready": {
      exactKeys(message, ["type", "origin", "dataDir"]);
      const origin = boundedString(message.origin, 160, "origin");
      parseCanonicalLoopbackOrigin(origin);
      return {
        type: "ready",
        origin,
        dataDir: boundedString(message.dataDir, 4_096, "data directory")
      };
    }
    case "fatal":
      exactKeys(message, [
        "type",
        "message",
        ...(message.diagnosticRef === undefined ? [] : ["diagnosticRef"])
      ]);
      if (message.diagnosticRef !== undefined
        && !isDiagnosticReference(message.diagnosticRef)) {
        throw invalid("fatal diagnostic reference is invalid");
      }
      return {
        type: "fatal",
        message: boundedString(message.message, 4_096, "fatal message"),
        ...(message.diagnosticRef === undefined
          ? {}
          : { diagnosticRef: message.diagnosticRef })
      };
    default:
      throw invalid("unknown child message type");
  }
}

export function decodeSupervisorToChildMessage(
  value: unknown
): SupervisorToChildMessage {
  requireBoundedMessage(value);
  const message = record(value, "supervisor message");
  switch (message.type) {
    case "reserve-ack":
      exactKeys(message, ["type", "requestId", "accepted"]);
      if (typeof message.accepted !== "boolean") {
        throw invalid("reserve acknowledgement is invalid");
      }
      return {
        type: "reserve-ack",
        requestId: boundedString(message.requestId, 160, "request ID"),
        accepted: message.accepted
      };
    case "recover":
      exactKeys(message, ["type", "descriptors"]);
      if (!Array.isArray(message.descriptors)
        || message.descriptors.length > SUPERVISED_SERVE_DESCRIPTOR_CAPACITY) {
        throw invalid("recovery descriptors exceed their bound");
      }
      return {
        type: "recover",
        descriptors: message.descriptors.map(decodeDescriptor)
      };
    case "activate":
      exactKeys(message, ["type"]);
      return { type: "activate" };
    case "shutdown":
      exactKeys(message, ["type"]);
      return { type: "shutdown" };
    default:
      throw invalid("unknown supervisor message type");
  }
}

function decodeDescriptor(value: unknown): HttpSupervisedOperationDescriptor {
  const descriptor = record(value, "operation descriptor");
  exactKeys(descriptor, [
    "listenerInstanceId", "sessionId", "sequence", "scope", "operation",
    "mutationId", "lifetime", "deadlineDelayMs"
  ]);
  const listenerInstanceId = boundedString(
    descriptor.listenerInstanceId,
    64,
    "listener instance ID"
  );
  if (!/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/
    .test(listenerInstanceId)) {
    throw invalid("listener instance ID is invalid");
  }
  const sessionId = boundedString(descriptor.sessionId, 32, "session ID");
  if (!/^[0-9a-f]{32}$/.test(sessionId)) throw invalid("session ID is invalid");
  const sequence = boundedString(descriptor.sequence, 20, "operation sequence");
  if (!/^[1-9][0-9]{0,19}$/.test(sequence)
    || BigInt(sequence) > (1n << 64n) - 1n) {
    throw invalid("operation sequence is invalid");
  }
  if (descriptor.scope !== "story" && descriptor.scope !== "admin") {
    throw invalid("operation scope is invalid");
  }
  if (!isWorkerMethod(descriptor.operation)) {
    throw invalid("operation method is invalid");
  }
  const mutationId = descriptor.mutationId;
  if (mutationId !== null
    && !isDurableMutationId(mutationId)) {
    throw invalid("operation mutation ID is invalid");
  }
  if (isWorkerMutationMethod(descriptor.operation) !== (mutationId !== null)) {
    throw invalid("operation mutation identity does not match its method");
  }
  const lifetime = descriptor.lifetime;
  if (!isLifetime(lifetime)) throw invalid("operation lifetime is invalid");
  const deadlineDelayMs = descriptor.deadlineDelayMs;
  if (!Number.isSafeInteger(deadlineDelayMs)
    || (deadlineDelayMs as number) <= 0
    || (deadlineDelayMs as number) > HTTP_OPERATION_LIFETIME_MS[lifetime]) {
    throw invalid("operation deadline is invalid");
  }
  return {
    listenerInstanceId,
    sessionId,
    sequence,
    scope: descriptor.scope,
    operation: descriptor.operation,
    mutationId,
    lifetime,
    deadlineDelayMs: deadlineDelayMs as number
  };
}

function decodeRecoveryResult(value: unknown): {
  readonly sessionId: string;
  readonly sequence: string;
  readonly state: SupervisedRecoveryState;
} {
  const result = record(value, "recovery result");
  exactKeys(result, ["sessionId", "sequence", "state"]);
  const { sessionId, sequence } = decodeOperationIdentity(
    result.sessionId,
    result.sequence
  );
  if (result.state !== "committed"
    && result.state !== "not-committed"
    && result.state !== "generation-outcome-unknown") {
    throw invalid("recovery state is invalid");
  }
  return { sessionId, sequence, state: result.state };
}

function decodeOperationIdentity(
  sessionValue: unknown,
  sequenceValue: unknown
): { readonly sessionId: string; readonly sequence: string } {
  const sessionId = boundedString(sessionValue, 32, "session ID");
  const sequence = boundedString(sequenceValue, 20, "operation sequence");
  if (!/^[0-9a-f]{32}$/.test(sessionId)
    || !/^[1-9][0-9]{0,19}$/.test(sequence)
    || BigInt(sequence) > (1n << 64n) - 1n) {
    throw invalid("operation identity is invalid");
  }
  return { sessionId, sequence };
}

function isLifetime(value: unknown): value is HttpOperationLifetime {
  return value === "control"
    || value === "local"
    || value === "transfer"
    || value === "provider-check"
    || value === "generation"
    || value === "fact-consistency";
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw invalid("message fields are invalid");
  }
}

function boundedString(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw invalid(`${label} is invalid`);
  }
  return value;
}

function stringArray(
  value: unknown,
  maxEntries: number,
  maxLength: number,
  label: string
): string[] {
  if (!Array.isArray(value) || value.length > maxEntries
    || value.some((entry) =>
      typeof entry !== "string" || entry.length === 0 || entry.length > maxLength)) {
    throw invalid(`${label} are invalid`);
  }
  return value as string[];
}

function requireBoundedMessage(value: unknown): void {
  const size = messageByteLength(value);
  if (size === null || size > SUPERVISED_SERVE_IPC_MAX_BYTES) {
    throw invalid("message exceeds its canonical bound");
  }
}

function invalid(message: string): Error {
  return new Error(`Invalid supervised serve IPC: ${message}`);
}

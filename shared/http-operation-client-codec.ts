import {
  bearerAuthorization,
  HTTP_AUTHORIZATION_HEADER,
  type HttpCapabilityScope
} from "./http-auth.js";
import {
  isTerminalHttpOperationState,
  type HttpOperationLifetime,
  type HttpOperationReservationResponse,
  type HttpOperationSessionEnvelope,
  type HttpOperationStatusResponse
} from "./http-operation-protocol.js";
import {
  HTTP_API_PROTOCOL_VERSION,
  HTTP_CLIENT_PROTOCOL_HEADER,
  HTTP_SERVER_INSTANCE_HEADER,
  isHttpRecoveryWarning,
  type HttpRecoveryWarning
} from "./http-protocol.js";

export function controlHeaders(
  serverInstanceId: string,
  capability: string
): Record<string, string> {
  return {
    [HTTP_CLIENT_PROTOCOL_HEADER]: String(HTTP_API_PROTOCOL_VERSION),
    [HTTP_SERVER_INSTANCE_HEADER]: serverInstanceId,
    [HTTP_AUTHORIZATION_HEADER]: bearerAuthorization(capability)
  };
}

export async function jsonRecord(
  response: Response
): Promise<Record<string, unknown>> {
  const value: unknown = await response.json().catch(() => null);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("1667 operation response was not a JSON object");
  }
  return value as Record<string, unknown>;
}

export function decodeSession(
  value: Record<string, unknown>,
  scope: HttpCapabilityScope,
  serverInstanceId: string
): HttpOperationSessionEnvelope {
  const recoveryWarnings = decodeRecoveryWarnings(value.recoveryWarnings);
  if (value.listenerInstanceId !== serverInstanceId
    || value.scope !== scope
    || typeof value.sessionId !== "string"
    || !/^[0-9a-f]{32}$/.test(value.sessionId)
    || typeof value.capability !== "string"
    || !/^[0-9a-f]{64}$/.test(value.capability)
    || typeof value.idleTimeoutMs !== "number"
    || !Number.isSafeInteger(value.idleTimeoutMs)
    || value.idleTimeoutMs <= 0) {
    throw new Error("1667 returned an invalid operation session");
  }
  return {
    listenerInstanceId: serverInstanceId,
    sessionId: value.sessionId,
    scope,
    capability: value.capability,
    idleTimeoutMs: value.idleTimeoutMs,
    recoveryWarnings
  };
}

export function decodeReservation(
  value: Record<string, unknown>,
  serverInstanceId: string,
  session: HttpOperationSessionEnvelope
): HttpOperationReservationResponse {
  const lifetime = value.lifetime;
  if (value.listenerInstanceId !== serverInstanceId
    || value.sessionId !== session.sessionId
    || typeof value.ticket !== "string"
    || typeof value.sequence !== "string"
    || !/^[1-9][0-9]{0,19}$/.test(value.sequence)
    || typeof value.deadlineEpochMs !== "number"
    || !Number.isSafeInteger(value.deadlineEpochMs)
    || typeof value.startDeadlineEpochMs !== "number"
    || !Number.isSafeInteger(value.startDeadlineEpochMs)
    || !isHttpOperationLifetime(lifetime)) {
    throw new Error("1667 returned an invalid operation reservation");
  }
  return {
    listenerInstanceId: serverInstanceId,
    sessionId: session.sessionId,
    sequence: value.sequence,
    ticket: value.ticket,
    lifetime,
    deadlineEpochMs: value.deadlineEpochMs,
    startDeadlineEpochMs: value.startDeadlineEpochMs
  };
}

export function decodeStatus(
  value: Record<string, unknown>,
  serverInstanceId: string,
  sessionId: string,
  sequence: string
): HttpOperationStatusResponse | null {
  const state = value.state;
  if (value.listenerInstanceId !== serverInstanceId
    || value.sessionId !== sessionId
    || value.sequence !== sequence
    || !isHttpOperationState(state)
    || typeof value.terminal !== "boolean"
    || value.terminal !== isTerminalHttpOperationState(state)
    || typeof value.cancelRequested !== "boolean") {
    return null;
  }
  return {
    listenerInstanceId: serverInstanceId,
    sessionId,
    sequence,
    state,
    terminal: isTerminalHttpOperationState(state),
    cancelRequested: value.cancelRequested
  };
}

export function unrefDeadlineOutsideWindowsBun(
  timer: ReturnType<typeof setTimeout>
): void {
  if (process.platform !== "win32" || !("bun" in process.versions)) {
    timer.unref?.();
  }
}

function decodeRecoveryWarnings(value: unknown): HttpRecoveryWarning[] {
  if (!Array.isArray(value)) {
    throw new Error("1667 returned an invalid operation session");
  }
  return value.map((warning) => {
    if (!isHttpRecoveryWarning(warning)) {
      throw new Error("1667 returned an invalid operation session");
    }
    return {
      mutationId: warning.mutationId,
      method: warning.method,
      storyId: warning.storyId,
      code: warning.code,
      message: warning.message,
      status: warning.status,
      ...(warning.providerRecovery === undefined
        ? {}
        : { providerRecovery: warning.providerRecovery }),
      ...(warning.diagnosticRef === undefined
        ? {}
        : { diagnosticRef: warning.diagnosticRef })
    };
  });
}

function isHttpOperationLifetime(
  value: unknown
): value is HttpOperationLifetime {
  return value === "control"
    || value === "local"
    || value === "transfer"
    || value === "provider-check"
    || value === "generation";
}

function isHttpOperationState(
  value: unknown
): value is HttpOperationStatusResponse["state"] {
  return value === "reserved"
    || value === "running"
    || value === "completed"
    || value === "canceled"
    || value === "failed";
}

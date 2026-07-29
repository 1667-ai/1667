import {
  HttpOperationClient,
  type HttpOperationClientOptions
} from "../shared/http-operation-client.js";
import {
  HttpListenerAuthority,
  type HttpListenerBinding,
  type HttpListenerReplacementOutcome,
  type OperationFetch
} from "../shared/http-listener-authority.js";
import {
  HTTP_OPERATION_RESERVATION_PATH,
  HTTP_OPERATION_SESSION_PATH,
  HTTP_OPERATION_TICKET_HEADER
} from "../shared/http-operation-protocol.js";

export const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
export const REPLACEMENT_INSTANCE_ID =
  "22222222-2222-4222-8222-222222222222";
export const SESSION_ID = "aa".repeat(16);

export function operationClient(
  fetch: OperationFetch,
  shutdownSignal?: AbortSignal,
  confirmListenerReplacement?: (
    previousInstanceId: string,
    signal: AbortSignal
  ) => Promise<HttpListenerReplacementOutcome>,
  onSession?: HttpOperationClientOptions["onSession"]
): HttpOperationClient & { readonly binding: HttpListenerBinding } {
  const binding: HttpListenerBinding = {
    authRecord: {
      schema: 1,
      origin: "http://127.0.0.1:7373",
      instanceId: INSTANCE_ID,
      capabilities: {
        story: "11".repeat(32),
        admin: "22".repeat(32)
      }
    },
    fetch
  };
  const authority = new HttpListenerAuthority({
    root: "http://127.0.0.1:7373",
    binding,
    ...(confirmListenerReplacement === undefined
      ? {}
      : {
          confirmReplacement: async (
            previousInstanceId: string,
            signal: AbortSignal
          ) => await confirmListenerReplacement(previousInstanceId, signal)
        })
  });
  if (shutdownSignal?.aborted === true) {
    authority.dispose(shutdownSignal.reason);
  } else {
    shutdownSignal?.addEventListener(
      "abort",
      () => authority.dispose(shutdownSignal.reason),
      { once: true }
    );
  }
  return Object.assign(new HttpOperationClient({
    authority,
    onSession
  }), { binding });
}

export function replacementBinding(
  fetch: OperationFetch = async () => Response.json({ ok: true }),
  instanceId = REPLACEMENT_INSTANCE_ID
): HttpListenerBinding {
  return {
    authRecord: {
      schema: 1,
      origin: "http://127.0.0.1:7373",
      instanceId,
      capabilities: {
        story: "33".repeat(32),
        admin: "44".repeat(32)
      }
    },
    fetch
  };
}

export function operationFixture(
  control: (
    pathname: string,
    init: RequestInit | undefined
  ) => Promise<Response>,
  lifetimeMs = 2_000,
  onReservation?: (init: RequestInit | undefined) => void,
  recoveryWarnings: unknown[] = [],
  instanceId = INSTANCE_ID,
  sessionId = SESSION_ID
): OperationFetch {
  let sequence = 0;
  return async (input, init) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === HTTP_OPERATION_SESSION_PATH) {
      return Response.json({
        listenerInstanceId: instanceId,
        sessionId,
        scope: "story",
        capability: "bb".repeat(32),
        idleTimeoutMs: 60_000,
        recoveryWarnings
      }, { status: 201 });
    }
    if (pathname === HTTP_OPERATION_RESERVATION_PATH) {
      onReservation?.(init);
      sequence += 1;
      return Response.json({
        listenerInstanceId: instanceId,
        sessionId,
        sequence: String(sequence),
        ticket: `${sessionId}.${sequence}.${"cc".repeat(32)}`,
        lifetime: "local",
        deadlineEpochMs: Date.now() + lifetimeMs,
        startDeadlineEpochMs: Date.now() + Math.min(1_000, lifetimeMs)
      }, { status: 201 });
    }
    return await control(pathname, init);
  };
}

export function terminalStatus(
  init: RequestInit | undefined,
  instanceId = INSTANCE_ID
): Response {
  const [sessionId, sequence] = (
    new Headers(init?.headers).get(HTTP_OPERATION_TICKET_HEADER) ?? ""
  ).split(".");
  return Response.json({
    listenerInstanceId: instanceId,
    sessionId,
    sequence,
    state: "completed",
    terminal: true,
    cancelRequested: false
  });
}

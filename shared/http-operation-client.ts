import {
  bearerAuthorization,
  HTTP_AUTHORIZATION_HEADER,
  type HttpAuthRecord,
  type HttpCapabilityScope
} from "./http-auth.js";
import { createDurableMutationId } from "./durable-mutation-id.js";
import {
  callerCancellationForLifetime,
  resolveHttpApiRoute,
  type HttpCallerCancellationStrategy
} from "./http-operation-policy.js";
import {
  HTTP_OPERATION_RESERVATION_PATH,
  HTTP_OPERATION_SESSION_PATH,
  HTTP_OPERATION_TICKET_HEADER,
  HTTP_OPERATION_CANCEL_GRACE_MS,
  HTTP_OPERATION_LIFETIME_MS,
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
import type { StoryAggregateVersion } from "./story-aggregate-version.js";
import { isWorkerMutationMethod } from "./worker-protocol.js";
import {
  decodeHttpFailurePayload,
  diagnosticReferenceFromFailure,
  type CompatibleHttpFailureEnvelope
} from "./failure-envelope.js";

export type OperationFetch = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>;

type SessionRecord = HttpOperationSessionEnvelope;
const GENERATION_CANCEL_HANDOFF_MS = 150;
const GENERATION_SETTLEMENT_HANDOFF_MS = 500;

interface SessionAttempt {
  readonly listenerInstanceId: string;
  readonly value: Promise<SessionRecord>;
  readonly controller: AbortController;
  settled: boolean;
  waiters: number;
}

export interface HttpOperationLease {
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly mutationId: string | null;
  cancel(): Promise<void>;
  settle(): Promise<void>;
}

export interface HttpOperationRunOptions<T> {
  readonly method: string;
  readonly path: string;
  readonly serverInstanceId: string;
  /** Caller-owned durable identity, retained independently of this transport. */
  readonly mutationId?: string;
  readonly requestedLifetimeMs?: number;
  readonly expectedAggregateVersion?: StoryAggregateVersion;
  readonly callerSignal?: AbortSignal;
  /** Last application guard before the reserved operation may be sent. */
  readonly beforeSend?: (lease: HttpOperationLease) => void | Promise<void>;
  /** Owns the complete response body/stream before returning. */
  readonly execute: (lease: HttpOperationLease) => Promise<T>;
  /** Transport-only retry policy. Durable mutations reuse the same identity. */
  readonly shouldRetry?: (error: unknown) => boolean;
}

export class HttpOperationError extends Error {
  constructor(readonly failure: CompatibleHttpFailureEnvelope) {
    super(failure.message);
    this.name = "HttpOperationError";
  }

  get status(): number {
    return this.failure.status ?? 500;
  }

  get code(): string {
    return this.failure.code;
  }

  get diagnosticRef(): string | null {
    return diagnosticReferenceFromFailure(this.failure);
  }
}

export interface HttpOperationClientOptions {
  readonly root: string;
  readonly authRecord: HttpAuthRecord;
  /** Reads authority that may be rebound after a proven listener replacement. */
  readonly currentAuthRecord?: () => HttpAuthRecord;
  readonly fetch: OperationFetch;
  readonly shutdownSignal?: AbortSignal;
  readonly confirmListenerReplacement?: (
    previousInstanceId: string
  ) => Promise<boolean>;
  readonly onSession?: (
    scope: HttpCapabilityScope,
    payload: HttpOperationSessionEnvelope
  ) => void;
}

/** Client-side owner for ephemeral scope sessions and per-request leases. */
export class HttpOperationClient {
  private readonly sessions = new Map<HttpCapabilityScope, SessionAttempt>();
  private readonly shutdown = new AbortController();
  private readonly onExternalShutdown = () => this.dispose();

  constructor(private readonly options: HttpOperationClientOptions) {
    if (options.shutdownSignal?.aborted === true) {
      this.dispose();
    } else {
      options.shutdownSignal?.addEventListener(
        "abort",
        this.onExternalShutdown,
        { once: true }
      );
    }
  }

  dispose(): void {
    if (this.shutdown.signal.aborted) return;
    this.options.shutdownSignal?.removeEventListener(
      "abort",
      this.onExternalShutdown
    );
    this.shutdown.abort(
      this.options.shutdownSignal?.reason
        ?? new DOMException("1667 HTTP operation client shut down", "AbortError")
    );
    for (const attempt of this.sessions.values()) {
      attempt.controller.abort(this.shutdown.signal.reason);
    }
    this.sessions.clear();
  }

  /**
   * Single owner for reserve -> last guard -> send -> durable retry -> settle.
   * Callers must consume the complete response inside execute.
   */
  async run<T>(options: HttpOperationRunOptions<T>): Promise<T> {
    this.shutdown.signal.throwIfAborted();
    let retryMutationId = options.mutationId;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const lease = await this.reserve(
        options.method,
        options.path,
        options.serverInstanceId,
        options.requestedLifetimeMs,
        options.callerSignal,
        retryMutationId,
        options.expectedAggregateVersion
      );
      let sent = false;
      try {
        options.callerSignal?.throwIfAborted();
        await options.beforeSend?.(lease);
        sent = true;
        return await options.execute(lease);
      } catch (error) {
        const retry = sent
          && attempt === 0
          && lease.mutationId !== null
          && !this.shutdown.signal.aborted
          && options.callerSignal?.aborted !== true
          && options.shouldRetry?.(error) === true;
        if (!retry) throw error;
        retryMutationId = lease.mutationId;
      } finally {
        const settlement = lease.settle();
        if (!sent || options.callerSignal?.aborted === true) {
          await Promise.all([settlement, lease.cancel()]);
        } else {
          await settlement;
        }
      }
    }
    throw new Error(
      `${options.method.toUpperCase()} ${options.path} operation retry was exhausted`
    );
  }

  async reserve(
    method: string,
    path: string,
    serverInstanceId: string,
    requestedLifetimeMs: number | undefined,
    callerSignal?: AbortSignal,
    retryMutationId?: string,
    expectedAggregateVersion?: StoryAggregateVersion
  ): Promise<HttpOperationLease> {
    this.shutdown.signal.throwIfAborted();
    const policy = resolveHttpApiRoute(method, path);
    const scope = policy.scope;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = await this.session(
        scope,
        serverInstanceId,
        callerSignal
      );
      const mutation = isWorkerMutationMethod(policy.method);
      if (!mutation && retryMutationId !== undefined) {
        throw new Error("Read-only HTTP operations cannot reuse mutation identity");
      }
      const mutationId = mutation
        ? retryMutationId ?? createDurableMutationId()
        : undefined;
      const response = await this.options.fetch(
        `${this.options.root}${HTTP_OPERATION_RESERVATION_PATH}`,
        {
          method: "POST",
          headers: {
            ...controlHeaders(serverInstanceId, session.capability),
            "content-type": "application/json"
          },
          body: JSON.stringify({
            method,
            path,
            operation: policy.method,
            ...(requestedLifetimeMs === undefined
              ? {}
              : { requestedLifetimeMs }),
            ...(mutationId === undefined ? {} : { mutationId }),
            ...(expectedAggregateVersion === undefined
              ? {}
              : { expectedAggregateVersion })
          }),
          redirect: "error",
          signal: callerSignal
        }
      );
      if (response.status === 410 && attempt === 0) {
        this.sessions.delete(scope);
        continue;
      }
      const payload = await jsonRecord(response);
      if (!response.ok) throw responseError(response, payload);
      const reservation = decodeReservation(payload, serverInstanceId, session);
      return operationLease(
        this.options.fetch,
        this.options.root,
        serverInstanceId,
        session.capability,
        reservation.ticket,
        reservation.sessionId,
        reservation.sequence,
        mutationId ?? null,
        reservation.deadlineEpochMs,
        callerSignal,
        this.shutdown.signal,
        this.options.confirmListenerReplacement,
        callerCancellationForLifetime(policy.lifetime)
      );
    }
    throw new Error("1667 operation-session retry was exhausted");
  }

  private async session(
    scope: HttpCapabilityScope,
    serverInstanceId: string,
    callerSignal?: AbortSignal
  ): Promise<SessionRecord> {
    this.shutdown.signal.throwIfAborted();
    let current = this.sessions.get(scope);
    if (current?.listenerInstanceId !== serverInstanceId) {
      current?.controller.abort(
        new Error("1667 listener instance changed")
      );
      this.sessions.delete(scope);
      current = undefined;
    }
    if (current === undefined) {
      const controller = new AbortController();
      let attempt!: SessionAttempt;
      const timeout = setTimeout(
        () => controller.abort(
          new DOMException(
            "1667 operation-session creation timed out",
            "TimeoutError"
          )
        ),
        HTTP_OPERATION_LIFETIME_MS.control
      );
      unrefDeadlineOutsideWindowsBun(timeout);
      const value = this.createSession(
        scope,
        serverInstanceId,
        controller.signal
      ).catch((error: unknown) => {
        if (this.sessions.get(scope) === attempt) this.sessions.delete(scope);
        throw error;
      }).finally(() => {
        attempt.settled = true;
        clearTimeout(timeout);
      });
      attempt = {
        listenerInstanceId: serverInstanceId,
        value,
        controller,
        settled: false,
        waiters: 0
      };
      this.sessions.set(scope, attempt);
      current = attempt;
    }

    current.waiters += 1;
    try {
      return await withCallerCancellation(current.value, callerSignal);
    } finally {
      current.waiters -= 1;
      if (!current.settled && current.waiters === 0) {
        current.controller.abort(
          callerSignal?.reason
            ?? new DOMException("Operation canceled", "AbortError")
        );
      }
    }
  }

  private async createSession(
    scope: HttpCapabilityScope,
    serverInstanceId: string,
    signal: AbortSignal
  ): Promise<SessionRecord> {
    const authRecord = this.options.currentAuthRecord?.()
      ?? this.options.authRecord;
    if (authRecord.origin !== this.options.root
      || authRecord.instanceId !== serverInstanceId) {
      throw new Error("1667 listener authority changed before session creation");
    }
    const listenerCapability = authRecord.capabilities[scope];
    const response = await this.options.fetch(
      `${this.options.root}${HTTP_OPERATION_SESSION_PATH}`,
      {
        method: "POST",
        headers: controlHeaders(serverInstanceId, listenerCapability),
        redirect: "error",
        signal
      }
    );
    const payload = await jsonRecord(response);
    if (!response.ok) throw responseError(response, payload);
    const decoded = decodeSession(payload, scope, serverInstanceId);
    this.options.onSession?.(scope, decoded);
    return decoded;
  }
}

async function withCallerCancellation<T>(
  value: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (signal === undefined) return await value;
  if (signal.aborted) throw signal.reason
    ?? new DOMException("Operation canceled", "AbortError");
  return await new Promise<T>((resolve, reject) => {
    const aborted = () => {
      reject(signal.reason ?? new DOMException("Operation canceled", "AbortError"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    void value.then(
      (result) => {
        signal.removeEventListener("abort", aborted);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      }
    );
  });
}

function operationLease(
  fetch: OperationFetch,
  root: string,
  serverInstanceId: string,
  capability: string,
  ticket: string,
  sessionId: string,
  sequence: string,
  mutationId: string | null,
  deadlineEpochMs: number,
  callerSignal: AbortSignal | undefined,
  shutdownSignal: AbortSignal,
  confirmListenerReplacement:
    HttpOperationClientOptions["confirmListenerReplacement"],
  callerCancellation: HttpCallerCancellationStrategy
): HttpOperationLease {
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadline.abort(new DOMException(
      "1667 operation deadline exceeded",
      "TimeoutError"
    )),
    Math.max(0, deadlineEpochMs - Date.now())
  );
  unrefDeadlineOutsideWindowsBun(deadlineTimer);
  const callerTransport = new AbortController();
  const signal = AbortSignal.any([
    ...(callerSignal === undefined
      ? []
      : [callerCancellation === "operation-first"
          ? callerTransport.signal
          : callerSignal]),
    deadline.signal,
    shutdownSignal
  ]);
  const headers = {
    ...controlHeaders(serverInstanceId, capability),
    [HTTP_OPERATION_TICKET_HEADER]: ticket
  };
  const cancellation = new AbortController();
  const settlementHandoff = new AbortController();
  let transportTimer: ReturnType<typeof setTimeout> | null = null;
  let settlementTimer: ReturnType<typeof setTimeout> | null = null;
  let canceled: Promise<boolean> | null = null;
  let settled: Promise<void> | null = null;
  let settlementComplete = false;
  let lease!: HttpOperationLease;
  const cancelOperation = () => settlementComplete
    ? Promise.resolve(false)
    : canceled ??= confirmOperationCancellation(
        fetch,
        `${root}/api/operations/cancel`,
        headers,
        AbortSignal.any([
          cancellation.signal,
          AbortSignal.timeout(
            callerCancellation === "operation-first"
              ? GENERATION_CANCEL_HANDOFF_MS
              : HTTP_OPERATION_LIFETIME_MS.control
          )
        ]),
        serverInstanceId,
        sessionId,
        sequence
      );
  const abortHandler = () => {
    if (callerCancellation === "transport-first") {
      void lease.cancel();
      return;
    }
    settlementTimer ??= setTimeout(() => {
      settlementHandoff.abort();
    }, GENERATION_SETTLEMENT_HANDOFF_MS);
    transportTimer ??= setTimeout(() => {
      callerTransport.abort(callerSignal?.reason);
    }, GENERATION_CANCEL_HANDOFF_MS);
    void cancelOperation();
  };
  lease = {
    headers,
    signal,
    mutationId,
    cancel: async () => {
      await cancelOperation();
    },
    settle: () => settled ??= acknowledgeWhenTerminal(
      fetch,
      root,
      headers,
      serverInstanceId,
      sessionId,
      sequence,
      deadlineEpochMs,
      AbortSignal.any([shutdownSignal, settlementHandoff.signal]),
      confirmListenerReplacement
    ).finally(() => {
      settlementComplete = true;
      callerSignal?.removeEventListener("abort", abortHandler);
      clearTimeout(deadlineTimer);
      if (transportTimer !== null) clearTimeout(transportTimer);
      if (settlementTimer !== null) clearTimeout(settlementTimer);
      deadline.abort();
      cancellation.abort();
      settlementHandoff.abort();
    })
  };
  if (callerSignal?.aborted === true) abortHandler();
  else callerSignal?.addEventListener("abort", abortHandler, { once: true });
  return lease;
}

async function acknowledgeWhenTerminal(
  fetch: OperationFetch,
  root: string,
  headers: Readonly<Record<string, string>>,
  serverInstanceId: string,
  sessionId: string,
  sequence: string,
  deadlineEpochMs: number,
  stopSignal: AbortSignal,
  confirmListenerReplacement:
    HttpOperationClientOptions["confirmListenerReplacement"]
): Promise<void> {
  const unavailableAfterEpochMs =
    deadlineEpochMs + HTTP_OPERATION_CANCEL_GRACE_MS;
  let pollDelayMs = 5;
  for (;;) {
    if (stopSignal.aborted) return;
    const now = Date.now();
    const statusSignal = AbortSignal.any([
      stopSignal,
      AbortSignal.timeout(Math.max(
        1,
        Math.min(
          HTTP_OPERATION_LIFETIME_MS.control,
          now < unavailableAfterEpochMs
            ? unavailableAfterEpochMs - now
            : HTTP_OPERATION_LIFETIME_MS.control
        )
      ))
    ]);
    const response = await fetch(`${root}/api/operations/status`, {
      headers,
      redirect: "error",
      signal: statusSignal
    }).catch(() => null);
    if (response === null
      && confirmListenerReplacement !== undefined
      && await withCallerCancellation(
        confirmListenerReplacement(serverInstanceId),
        stopSignal
      ).catch(() => false)) {
      return;
    }
    if (response !== null && (
      response.status === 401
      || response.status === 403
      || response.status === 404
      || response.status === 410
      || replacedListener(response, serverInstanceId)
    )) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    if (response !== null) {
      const payload = await jsonRecord(response).catch(() => null);
      const status = payload === null
        ? null
        : decodeStatus(payload, serverInstanceId, sessionId, sequence);
      if (response.ok && status?.terminal === true) {
        await control(
          fetch,
          `${root}/api/operations/terminal`,
          "DELETE",
          headers,
          AbortSignal.timeout(HTTP_OPERATION_LIFETIME_MS.control)
        ).catch(() => undefined);
        return;
      }
    }
    const remainingUntilUnavailable =
      unavailableAfterEpochMs - Date.now();
    if (!await waitForPoll(
      remainingUntilUnavailable > 0
        ? Math.min(pollDelayMs, remainingUntilUnavailable)
        : pollDelayMs,
      stopSignal
    )) return;
    pollDelayMs = Math.min(100, pollDelayMs * 2);
  }
}

async function waitForPoll(
  delayMs: number,
  shutdownSignal: AbortSignal
): Promise<boolean> {
  if (shutdownSignal.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => finish(true), delayMs);
    const onShutdown = () => finish(false);
    const finish = (completed: boolean) => {
      clearTimeout(timer);
      shutdownSignal.removeEventListener("abort", onShutdown);
      resolve(completed);
    };
    shutdownSignal.addEventListener("abort", onShutdown, { once: true });
  });
}

async function control(
  fetch: OperationFetch,
  url: string,
  method: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return;
  await fetch(url, {
    method,
    headers,
    redirect: "error",
    signal
  }).catch(() => undefined);
}

async function requestOperationCancellation(
  fetch: OperationFetch,
  url: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
  serverInstanceId: string,
  sessionId: string,
  sequence: string
): Promise<boolean> {
  if (signal.aborted) return false;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      redirect: "error",
      signal
    });
    if (!response.ok) return false;
    const status = decodeStatus(
      await jsonRecord(response),
      serverInstanceId,
      sessionId,
      sequence
    );
    return status !== null
      && (status.cancelRequested || status.terminal);
  } catch {
    return false;
  }
}

async function confirmOperationCancellation(
  fetch: OperationFetch,
  url: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
  serverInstanceId: string,
  sessionId: string,
  sequence: string
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await requestOperationCancellation(
      fetch,
      url,
      headers,
      signal,
      serverInstanceId,
      sessionId,
      sequence
    )) {
      return true;
    }
    if (attempt === 0 && !await waitForPoll(25, signal)) return false;
  }
  return false;
}

function replacedListener(
  response: Response,
  serverInstanceId: string
): boolean {
  const responseInstanceId = response.headers.get(HTTP_SERVER_INSTANCE_HEADER);
  return responseInstanceId !== null && responseInstanceId !== serverInstanceId;
}

function unrefDeadlineOutsideWindowsBun(
  timer: ReturnType<typeof setTimeout>
): void {
  if (process.platform !== "win32" || !("bun" in process.versions)) {
    timer.unref?.();
  }
}

function controlHeaders(
  serverInstanceId: string,
  capability: string
): Record<string, string> {
  return {
    [HTTP_CLIENT_PROTOCOL_HEADER]: String(HTTP_API_PROTOCOL_VERSION),
    [HTTP_SERVER_INSTANCE_HEADER]: serverInstanceId,
    [HTTP_AUTHORIZATION_HEADER]: bearerAuthorization(capability)
  };
}

async function jsonRecord(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json().catch(() => null);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("1667 operation response was not a JSON object");
  }
  return value as Record<string, unknown>;
}

function decodeSession(
  value: Record<string, unknown>,
  scope: HttpCapabilityScope,
  serverInstanceId: string
): SessionRecord {
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

function decodeReservation(
  value: Record<string, unknown>,
  serverInstanceId: string,
  session: SessionRecord
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
        : {
            providerRecovery: warning.providerRecovery
          }),
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

function decodeStatus(
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

function isHttpOperationState(
  value: unknown
): value is HttpOperationStatusResponse["state"] {
  return value === "reserved"
    || value === "running"
    || value === "completed"
    || value === "canceled"
    || value === "failed";
}

function responseError(
  response: Response,
  payload: Record<string, unknown>
): Error {
  return new HttpOperationError(decodeHttpFailurePayload(
    payload,
    `1667 operation request failed (${response.status})`,
    response.status
  ));
}

import {
  HTTP_OPERATION_CANCEL_GRACE_MS,
  HTTP_OPERATION_LIFETIME_MS,
  HTTP_OPERATION_TICKET_HEADER
} from "./http-operation-protocol.js";
import {
  HTTP_SERVER_INSTANCE_HEADER
} from "./http-protocol.js";
import type {
  HttpListenerReplacementOutcome,
  OperationFetch
} from "./http-listener-authority.js";
import {
  controlHeaders,
  decodeStatus,
  jsonRecord,
  unrefDeadlineOutsideWindowsBun
} from "./http-operation-client-codec.js";
import type {
  HttpCallerCancellationStrategy
} from "./http-operation-policy.js";
import type { FailureEnvelope } from "./failure-envelope.js";

const GENERATION_CANCEL_HANDOFF_MS = 150;
const GENERATION_SETTLEMENT_HANDOFF_MS = 500;

export type HttpOperationSettlement =
  | { readonly kind: "settled" }
  | { readonly kind: "failed"; readonly failure: FailureEnvelope }
  | Extract<HttpListenerReplacementOutcome, { readonly kind: "rebound" }>
  | Extract<HttpListenerReplacementOutcome, { readonly kind: "replaced" }>;

export interface HttpOperationLease {
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly mutationId: string | null;
  /** Exact listener transport that created this lease. */
  readonly fetch: OperationFetch;
  cancel(): Promise<void>;
  settle(): Promise<HttpOperationSettlement>;
}

type ConfirmListenerReplacement = (
  previousInstanceId: string,
  observedReplacement?: boolean,
  callerSignal?: AbortSignal
) => Promise<HttpListenerReplacementOutcome>;

export function createHttpOperationLease(input: {
  readonly fetch: OperationFetch;
  readonly root: string;
  readonly serverInstanceId: string;
  readonly capability: string;
  readonly ticket: string;
  readonly sessionId: string;
  readonly sequence: string;
  readonly mutationId: string | null;
  readonly deadlineEpochMs: number;
  readonly callerSignal: AbortSignal | undefined;
  readonly shutdownSignal: AbortSignal;
  readonly confirmListenerReplacement: ConfirmListenerReplacement;
  readonly callerCancellation: HttpCallerCancellationStrategy;
}): HttpOperationLease {
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadline.abort(new DOMException(
      "1667 operation deadline exceeded",
      "TimeoutError"
    )),
    Math.max(0, input.deadlineEpochMs - Date.now())
  );
  unrefDeadlineOutsideWindowsBun(deadlineTimer);
  const callerTransport = new AbortController();
  const signal = AbortSignal.any([
    ...(input.callerSignal === undefined
      ? []
      : [callerTransport.signal]),
    deadline.signal,
    input.shutdownSignal
  ]);
  const headers = {
    ...controlHeaders(input.serverInstanceId, input.capability),
    [HTTP_OPERATION_TICKET_HEADER]: input.ticket
  };
  const cancellation = new AbortController();
  const settlementHandoff = new AbortController();
  let settlementTimer: ReturnType<typeof setTimeout> | null = null;
  let canceled: Promise<boolean> | null = null;
  let settled: Promise<HttpOperationSettlement> | null = null;
  let settlementStarted = false;
  let settlementComplete = false;
  let lease!: HttpOperationLease;
  const startSettlementHandoff = () => {
    if (input.callerCancellation !== "operation-first") return;
    settlementTimer ??= setTimeout(() => {
      settlementHandoff.abort();
    }, GENERATION_SETTLEMENT_HANDOFF_MS);
  };
  const cancelOperation = () => settlementComplete
    ? Promise.resolve(false)
    : canceled ??= confirmOperationCancellation(
        input.fetch,
        `${input.root}/api/operations/cancel`,
        headers,
        AbortSignal.any([
          cancellation.signal,
          AbortSignal.timeout(
            input.callerCancellation === "operation-first"
              ? GENERATION_CANCEL_HANDOFF_MS
              : HTTP_OPERATION_LIFETIME_MS.control
          )
        ]),
        input.serverInstanceId,
        input.sessionId,
        input.sequence
      );
  const abortHandler = () => {
    if (input.callerCancellation === "transport-first") {
      void lease.cancel();
      callerTransport.abort(input.callerSignal?.reason);
      return;
    }
    // The cancel control request is bounded, but the response transport is
    // not. The server can have accepted SSE deltas that remain backpressured
    // after the caller stops. Keep draining until terminal so the caller can
    // settle that exact tail rather than losing it behind a fixed handoff.
    void cancelOperation();
    // Once terminal settlement is active there is no response drain left to
    // protect, so bound its status polling from this cancellation point.
    if (settlementStarted) startSettlementHandoff();
  };
  lease = {
    headers,
    signal,
    mutationId: input.mutationId,
    fetch: input.fetch,
    cancel: async () => {
      await cancelOperation();
    },
    settle: () => {
      if (settled !== null) return settled;
      // Set this before the first status fetch. A fetch implementation can
      // synchronously deliver caller cancellation before this call returns.
      settlementStarted = true;
      // An operation-first Stop keeps the response draining. Start this
      // bounded status window only once that drain returns to its owner.
      if (input.callerSignal?.aborted === true) startSettlementHandoff();
      settled = acknowledgeWhenTerminal(
        input,
        headers,
        AbortSignal.any([
          input.shutdownSignal,
          settlementHandoff.signal
        ])
      ).finally(() => {
        settlementComplete = true;
        input.callerSignal?.removeEventListener("abort", abortHandler);
        clearTimeout(deadlineTimer);
        if (settlementTimer !== null) clearTimeout(settlementTimer);
        deadline.abort();
        cancellation.abort();
        settlementHandoff.abort();
      });
      return settled;
    }
  };
  if (input.callerSignal?.aborted === true) abortHandler();
  else input.callerSignal?.addEventListener(
    "abort",
    abortHandler,
    { once: true }
  );
  return lease;
}

async function acknowledgeWhenTerminal(
  input: Parameters<typeof createHttpOperationLease>[0],
  headers: Readonly<Record<string, string>>,
  stopSignal: AbortSignal
): Promise<HttpOperationSettlement> {
  const unavailableAfterEpochMs =
    input.deadlineEpochMs + HTTP_OPERATION_CANCEL_GRACE_MS;
  let pollDelayMs = 5;
  for (;;) {
    if (stopSignal.aborted) return { kind: "settled" };
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
    let response = await input.fetch(`${input.root}/api/operations/status`, {
      headers,
      redirect: "error",
      signal: statusSignal
    }).catch(() => null);
    if (response === null) {
      const outcome = await replacementOutcome(input, false, stopSignal);
      if (outcome.kind !== "unchanged") return outcome;
    }
    if (response !== null
      && replacedListener(response, input.serverInstanceId)) {
      await response.body?.cancel().catch(() => undefined);
      const outcome = await replacementOutcome(input, true, stopSignal);
      if (outcome.kind !== "unchanged") return outcome;
      response = null;
    }
    if (response !== null && (
      response.status === 401
      || response.status === 403
      || response.status === 404
      || response.status === 410
    )) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "settled" };
    }
    if (response !== null) {
      const payload = await jsonRecord(response).catch(() => null);
      const status = payload === null
        ? null
        : decodeStatus(
            payload,
            input.serverInstanceId,
            input.sessionId,
            input.sequence
          );
      if (response.ok && status?.terminal === true) {
        await control(
          input.fetch,
          `${input.root}/api/operations/terminal`,
          "DELETE",
          headers,
          AbortSignal.timeout(HTTP_OPERATION_LIFETIME_MS.control)
        ).catch(() => undefined);
        return status.state === "failed" && status.failure !== undefined
          ? { kind: "failed", failure: status.failure }
          : { kind: "settled" };
      }
    }
    const remainingUntilUnavailable =
      unavailableAfterEpochMs - Date.now();
    if (!await waitForPoll(
      remainingUntilUnavailable > 0
        ? Math.min(pollDelayMs, remainingUntilUnavailable)
        : pollDelayMs,
      stopSignal
    )) return { kind: "settled" };
    pollDelayMs = Math.min(100, pollDelayMs * 2);
  }
}

async function replacementOutcome(
  input: Parameters<typeof createHttpOperationLease>[0],
  observedReplacement: boolean,
  stopSignal: AbortSignal
): Promise<HttpListenerReplacementOutcome> {
  return await input.confirmListenerReplacement(
    input.serverInstanceId,
    observedReplacement,
    stopSignal
  ).catch(() => ({ kind: "unchanged" as const }));
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

import type { IncomingMessage, ServerResponse } from "node:http";
import { toPublicServiceError } from "./service-error-policy.js";
import { abortOnDisconnect, openSse } from "./http.js";
import type { InternalErrorReporter } from "./internal-error-reporter.js";
import {
  createFailureEnvelope,
  failureWireFields,
  type FailureEnvelope
} from "../shared/failure-envelope.js";
import { GenerationStoppedError } from "./errors.js";
import { DeltaBatcher } from "./delta-batcher.js";
import { SSE_HEARTBEAT_INTERVAL_MS } from "../shared/sse.js";
import type { ReasoningStreamDelta } from "./providers.js";

export async function streamResponse<T>(
  request: IncomingMessage,
  response: ServerResponse,
  run: (
    onDelta: (text: string) => Promise<void>,
    signal: AbortSignal,
    /** Reasoning ("thinking") text, kept apart from `onDelta`'s story prose:
     *  it reaches the client only through its own `"reasoning"` SSE frame,
     *  never through a `"delta"` frame. */
    onReasoning: (delta: ReasoningStreamDelta) => Promise<void>
  ) => Promise<T | null>,
  done: (value: T) => Record<string, unknown>,
  operationSignal?: AbortSignal,
  errorReporter?: InternalErrorReporter,
  operation?: string,
  onTerminalFailure?: (failure: FailureEnvelope) => void,
  options: {
    /** Keep a committed result visible after a selected operation abort. */
    readonly preserveDoneAfterOperationAbort?: (reason: unknown) => boolean;
  } = {}
): Promise<void> {
  const abort = abortOnDisconnect(
    request,
    response,
    operationSignal === undefined
      ? undefined
      : new GenerationStoppedError()
  );
  const signal = operationSignal === undefined
    ? abort.signal
    : AbortSignal.any([operationSignal, abort.signal]);
  let session: ReturnType<typeof openSse> | null = null;
  let firstHeartbeat: ReturnType<typeof setTimeout> | null = null;
  const stopFirstHeartbeat = () => {
    if (firstHeartbeat === null) return;
    clearTimeout(firstHeartbeat);
    firstHeartbeat = null;
  };
  const open = () => {
    stopFirstHeartbeat();
    return session ??= openSse(response, abort);
  };
  firstHeartbeat = setTimeout(() => {
    firstHeartbeat = null;
    if (!signal.aborted) void open().heartbeat();
  }, SSE_HEARTBEAT_INTERVAL_MS);
  if (signal.aborted) stopFirstHeartbeat();
  else signal.addEventListener("abort", stopFirstHeartbeat, { once: true });
  // Batches deltas at the same byte/time thresholds the embedded worker path
  // uses (server/worker-delta-batcher.ts), over the same DeltaBatcher. An
  // HTTP write already carries its own backpressure (openSse.send awaits
  // "drain"), so this "send" needs no readiness gate of its own — it only
  // has to deliver.
  const deltas = new DeltaBatcher(
    async (text) => { await open().send({ type: "delta", text }); }
  );
  // Reasoning gets its own `DeltaBatcher` and its own text accumulator — the
  // same batching policy as prose, on a separate frame type, so a coalesced
  // batch can never mix reasoning and story prose into one `"delta"` frame.
  let reasoningTokenCount = 0;
  const reasoningDeltas = new DeltaBatcher(
    async (text) => {
      await open().send({ type: "reasoning", text, tokenCount: reasoningTokenCount });
    }
  );
  try {
    const value = await run(
      (text) => deltas.push(text),
      signal,
      (delta) => {
        reasoningTokenCount = delta.tokenCount;
        return reasoningDeltas.push(delta.text);
      }
    );
    // A pending batch must reach the client before "done" or "error" — never
    // delayed behind it, and never reordered around it — so every exit path
    // flushes before it decides what terminal event (if any) to send.
    await deltas.flush();
    await reasoningDeltas.flush();
    // A committed utility result can opt into visibility after a user Stop.
    // A disconnected client still owns the transport-level abort and cannot
    // receive a terminal frame. Other streams keep cancellation semantics.
    const preserveDoneAfterOperationAbort = operationSignal?.aborted === true
      && !abort.signal.aborted
      && options.preserveDoneAfterOperationAbort?.(operationSignal.reason) === true;
    if (value === null
      || abort.signal.aborted
      || (signal.aborted && !preserveDoneAfterOperationAbort)) {
      return void response.end();
    }
    await open().send(done(value));
    response.end();
  } catch (error) {
    const expectedCancellation = signal.aborted
      && isExpectedCancellation(error, signal);
    // The operation record owns the known public failure before delta
    // cleanup, diagnostics, or SSE backpressure can cross its hard deadline.
    if (!expectedCancellation) {
      onTerminalFailure?.(
        createFailureEnvelope(toPublicServiceError(error))
      );
    }
    await deltas.flush().catch(() => undefined);
    await reasoningDeltas.flush().catch(() => undefined);
    if (signal.aborted) {
      if (!expectedCancellation) {
        await reportStreamFailure(
          error,
          errorReporter,
          operation
        );
      }
      return void response.end();
    }
    if (session === null) throw error;
    const failure = await reportStreamFailure(error, errorReporter, operation);
    await (session as ReturnType<typeof openSse>).send({
      type: "error",
      ...failureWireFields(failure)
    });
    response.end();
  } finally {
    stopFirstHeartbeat();
    signal.removeEventListener("abort", stopFirstHeartbeat);
    deltas.dispose();
    reasoningDeltas.dispose();
    await (session as ReturnType<typeof openSse> | null)?.close();
  }
}

async function reportStreamFailure(
  error: unknown,
  errorReporter: InternalErrorReporter | undefined,
  operation: string | undefined
): Promise<FailureEnvelope> {
  if (errorReporter === undefined) {
    return createFailureEnvelope(toPublicServiceError(error));
  }
  const reported = await errorReporter.report(error, {
    service: "http-stream",
    ...(operation === undefined ? {} : { operation })
  });
  return reported.failure;
}

function isExpectedCancellation(
  error: unknown,
  signal: AbortSignal
): boolean {
  if (error === signal.reason) return true;
  return error instanceof Error && error.name === "AbortError";
}

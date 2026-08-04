import type { IncomingMessage, ServerResponse } from "node:http";
import { toPublicServiceError } from "./service-error-policy.js";
import { abortOnDisconnect, openSse } from "./http.js";
import type { InternalErrorReporter } from "./internal-error-reporter.js";
import {
  createFailureEnvelope,
  failureWireFields
} from "../shared/failure-envelope.js";
import { GenerationStoppedError } from "./errors.js";
import { DeltaBatcher } from "./delta-batcher.js";

export async function streamResponse<T>(
  request: IncomingMessage,
  response: ServerResponse,
  run: (
    onDelta: (text: string) => Promise<void>,
    signal: AbortSignal
  ) => Promise<T | null>,
  done: (value: T) => Record<string, unknown>,
  operationSignal?: AbortSignal,
  errorReporter?: InternalErrorReporter,
  operation?: string
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
  const open = () => session ??= openSse(response, abort);
  // Batches deltas at the same byte/time thresholds the embedded worker path
  // uses (server/worker-delta-batcher.ts), over the same DeltaBatcher. An
  // HTTP write already carries its own backpressure (openSse.send awaits
  // "drain"), so this "send" needs no readiness gate of its own — it only
  // has to deliver.
  const deltas = new DeltaBatcher(
    async (text) => { await open().send({ type: "delta", text }); }
  );
  try {
    const value = await run(
      (text) => deltas.push(text),
      signal
    );
    // A pending batch must reach the client before "done" or "error" — never
    // delayed behind it, and never reordered around it — so every exit path
    // flushes before it decides what terminal event (if any) to send.
    await deltas.flush();
    if (value === null || signal.aborted) return void response.end();
    await open().send(done(value));
    response.end();
  } catch (error) {
    await deltas.flush().catch(() => undefined);
    if (signal.aborted) {
      if (!isExpectedCancellation(error, signal)) {
        await errorReporter?.report(error, {
          service: "http-stream",
          ...(operation === undefined ? {} : { operation })
        });
      }
      return void response.end();
    }
    if (session === null) throw error;
    const reported = errorReporter === undefined
      ? {
          failure: createFailureEnvelope(toPublicServiceError(error))
        }
      : await errorReporter.report(error, {
          service: "http-stream",
          ...(operation === undefined ? {} : { operation })
        });
    await (session as ReturnType<typeof openSse>).send({
      type: "error",
      ...failureWireFields(reported.failure)
    });
    response.end();
  } finally {
    deltas.dispose();
  }
}

function isExpectedCancellation(
  error: unknown,
  signal: AbortSignal
): boolean {
  if (error === signal.reason) return true;
  return error instanceof Error && error.name === "AbortError";
}

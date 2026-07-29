import type { IncomingMessage, ServerResponse } from "node:http";
import { toPublicServiceError } from "./service-error-policy.js";
import { abortOnDisconnect, openSse } from "./http.js";
import type { InternalErrorReporter } from "./internal-error-reporter.js";
import {
  createFailureEnvelope,
  failureWireFields
} from "../shared/failure-envelope.js";
import { GenerationStoppedError } from "./errors.js";

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
  try {
    const value = await run(
      async (text) => await open().send({ type: "delta", text }),
      signal
    );
    if (value === null || signal.aborted) return void response.end();
    await open().send(done(value));
    response.end();
  } catch (error) {
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
  }
}

function isExpectedCancellation(
  error: unknown,
  signal: AbortSignal
): boolean {
  if (error === signal.reason) return true;
  return error instanceof Error && error.name === "AbortError";
}

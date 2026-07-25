import type { IncomingMessage, ServerResponse } from "node:http";
import { toPublicServiceError } from "./errors.js";
import { abortOnDisconnect, openSse } from "./http.js";

export async function streamResponse<T>(
  request: IncomingMessage,
  response: ServerResponse,
  run: (
    onDelta: (text: string) => Promise<void>,
    signal: AbortSignal
  ) => Promise<T | null>,
  done: (value: T) => Record<string, unknown>,
  operationSignal?: AbortSignal
): Promise<void> {
  const abort = abortOnDisconnect(request, response);
  const signal = operationSignal === undefined
    ? abort.signal
    : AbortSignal.any([abort.signal, operationSignal]);
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
    if (signal.aborted) return void response.end();
    if (session === null) throw error;
    await (session as ReturnType<typeof openSse>).send({
      type: "error",
      message: toPublicServiceError(error).message
    });
    response.end();
  }
}

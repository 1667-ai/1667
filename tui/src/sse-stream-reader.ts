import {
  SSE_IDLE_TIMEOUT_MS,
  splitSseEvents
} from "../../shared/sse.js";

export class SseIdleTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The stream was silent for ${Math.ceil(timeoutMs / 1_000)} seconds.`);
    this.name = "SseIdleTimeoutError";
  }
}

interface SseIdleTimeoutOptions {
  timeoutMs?: number;
  onTimeout?: (error: SseIdleTimeoutError) => void;
}

/** Give an SSE response or read one bounded interval to produce its next byte. */
export async function withSseIdleTimeout<T>(
  operation: Promise<T>,
  options: SseIdleTimeoutOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? SSE_IDLE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stalled = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new SseIdleTimeoutError(timeoutMs);
      reject(error);
      options.onTimeout?.(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, stalled]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** Read arbitrary HTTP bytes with the same per-read liveness bound as SSE. */
export async function readSseText(
  body: ReadableStream<Uint8Array>,
  idleTimeoutMs = SSE_IDLE_TIMEOUT_MS
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await withSseIdleTimeout(reader.read(), {
        timeoutMs: idleTimeoutMs
      });
      if (done) return text + decoder.decode();
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Consume SSE data frames while each network read remains inside one idle bound. */
export async function readSseEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (data: string) => boolean | Promise<boolean>,
  idleTimeoutMs = SSE_IDLE_TIMEOUT_MS
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let searchFrom = 0;
  try {
    for (;;) {
      const { done, value } = await withSseIdleTimeout(reader.read(), {
        timeoutMs: idleTimeoutMs
      });
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const split = splitSseEvents(buffer, searchFrom);
      buffer = split.rest;
      searchFrom = split.nextSearchFrom;
      for (const data of split.events) {
        if (!await onEvent(data)) {
          await reader.cancel().catch(() => undefined);
          return;
        }
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

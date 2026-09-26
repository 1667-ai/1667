import type { IncomingMessage, ServerResponse } from "node:http";
import { SSE_HEARTBEAT_INTERVAL_MS } from "../shared/sse.js";
import { MAX_JSON_BODY_BYTES } from "../shared/types.js";
import { ServiceError } from "./errors.js";
export { optionalString, requireString } from "./validation.js";

/** Compatibility name for the HTTP adapter; domain code uses ServiceError. */
export { ServiceError as HttpError } from "./errors.js";

/** Past this many bytes beyond `maxBytes`, draining gives up and destroys the
 * connection instead of continuing to read — bounded so a pathological
 * sender cannot hold a request open indefinitely once its body is already
 * known to be rejected. Generous relative to `maxBytes` itself (a real
 * caller's body is already within budget), and never below 64 KiB so a
 * small `maxBytes` (a bearer of a tiny route, say 1 KB) still gets a real
 * grace window rather than an effectively-zero one. */
function drainHardCeiling(maxBytes: number): number {
  return Math.max(maxBytes * 4, maxBytes + 65_536);
}

/**
 * Reads a request body capped at `maxBytes`. Verified fact: under Bun 1.3.14's
 * `node:http`, throwing out of a `for await (const chunk of request)` loop
 * and then writing an error response corrupts the reply into a bare 200 with
 * an empty body instead of the intended status — reproduced with a minimal
 * server; confirmed absent under real Node (`cli/test/read-text-body-drain-
 * regression.test.ts` is the regression test, run under Bun since that is
 * where every packaged `1667`/`1667 web` actually runs). The fix is to keep
 * consuming the stream to completion — discarding bytes past `maxBytes`
 * rather than buffering them, and giving up only past `drainHardCeiling`'s
 * bound — so the request always finishes normally, and only then does a
 * still-oversized body throw.
 */
export async function readTextBody(
  request: IncomingMessage,
  maxBytes: number,
  signal?: AbortSignal
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  let oversized = false;
  const hardCeiling = drainHardCeiling(maxBytes);
  const cancel = () => request.destroy();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for await (const chunk of request) {
      if (signal?.aborted === true) throw operationCanceled();
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        oversized = true;
        if (size > hardCeiling) {
          request.destroy();
          break;
        }
        continue;
      }
      chunks.push(buffer);
    }
    if (signal?.aborted === true) throw operationCanceled();
    if (oversized) throw new ServiceError(413, "Request body too large");
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (signal?.aborted === true) throw operationCanceled();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

/** Same drain-then-throw shape as `readTextBody`, for a binary body. */
export async function readBufferBody(
  request: IncomingMessage,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  let oversized = false;
  const hardCeiling = drainHardCeiling(maxBytes);
  const cancel = () => request.destroy();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for await (const chunk of request) {
      if (signal?.aborted === true) throw operationCanceled();
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        oversized = true;
        if (size > hardCeiling) {
          request.destroy();
          break;
        }
        continue;
      }
      chunks.push(buffer);
    }
    if (signal?.aborted === true) throw operationCanceled();
    if (oversized) throw new ServiceError(413, "Request body too large");
    return new Uint8Array(Buffer.concat(chunks));
  } catch (error) {
    if (signal?.aborted === true) throw operationCanceled();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export async function readJsonBody(
  request: IncomingMessage,
  signal?: AbortSignal,
  maxBytes = MAX_JSON_BODY_BYTES
): Promise<Record<string, unknown>> {
  const content = (await readTextBody(
    request,
    maxBytes,
    signal
  )).trim();
  if (content.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new ServiceError(400, "Invalid JSON body");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ServiceError(400, "JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function operationCanceled(): ServiceError {
  return new ServiceError(
    408,
    "HTTP operation deadline exceeded or was canceled",
    "operation_expired"
  );
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store"
  });
  response.end(`${JSON.stringify(body)}\n`);
}

export async function waitForResponseSettlement(
  response: ServerResponse
): Promise<"finished" | "closed"> {
  if (response.writableFinished) return "finished";
  if (response.destroyed || response.closed) return "closed";
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: "finished" | "closed") => {
      if (settled) return;
      settled = true;
      response.off("finish", onFinish);
      response.off("close", onClose);
      resolve(result);
    };
    const onFinish = () => finish("finished");
    const onClose = () => finish(response.writableFinished ? "finished" : "closed");
    response.once("finish", onFinish);
    response.once("close", onClose);
  });
}

export interface SseSession {
  send: (event: Record<string, unknown>) => Promise<void>;
  heartbeat: () => Promise<void>;
  close: () => Promise<void>;
  abort: AbortController;
}

export function abortOnDisconnect(
  request: IncomingMessage,
  response: ServerResponse,
  reason?: unknown
): AbortController {
  const abort = new AbortController();
  const cancel = () => abort.abort(reason);
  request.once("aborted", cancel);
  response.once("close", cancel);
  if (request.aborted || response.destroyed || response.closed) {
    abort.abort(reason);
  }
  return abort;
}

export function openSse(response: ServerResponse, abort: AbortController): SseSession {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive"
  });
  let active = true;
  let writes = Promise.resolve();
  const write = async (chunk: string) => {
    if (response.writableEnded || abort.signal.aborted) return;
    const accepted = response.write(chunk);
    if (accepted) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        response.off("drain", finish);
        response.off("close", finish);
        abort.signal.removeEventListener("abort", finish);
        resolve();
      };
      response.once("drain", finish);
      response.once("close", finish);
      abort.signal.addEventListener("abort", finish, { once: true });
      if (response.destroyed || response.closed || abort.signal.aborted) finish();
    });
  };
  const enqueue = (chunk: string): Promise<void> => {
    if (!active) return Promise.resolve();
    const next = writes.then(() => write(chunk));
    writes = next.catch(() => undefined);
    return next;
  };
  const stopHeartbeats = () => clearInterval(heartbeatTimer);
  const heartbeat = () => enqueue(": heartbeat\n\n");
  const heartbeatTimer = setInterval(() => { void heartbeat(); }, SSE_HEARTBEAT_INTERVAL_MS);
  abort.signal.addEventListener("abort", stopHeartbeats, { once: true });
  return {
    send: async (event) => await enqueue(`data: ${JSON.stringify(event)}\n\n`),
    heartbeat,
    close: async () => {
      if (!active) return;
      active = false;
      stopHeartbeats();
      abort.signal.removeEventListener("abort", stopHeartbeats);
      await writes;
    },
    abort
  };
}

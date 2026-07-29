import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_JSON_BODY_BYTES } from "../shared/types.js";
import { ServiceError } from "./errors.js";
export { optionalString, requireString } from "./validation.js";

/** Compatibility name for the HTTP adapter; domain code uses ServiceError. */
export { ServiceError as HttpError } from "./errors.js";

export async function readTextBody(
  request: IncomingMessage,
  maxBytes: number,
  signal?: AbortSignal
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  const cancel = () => request.destroy();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for await (const chunk of request) {
      if (signal?.aborted === true) throw operationCanceled();
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) throw new ServiceError(413, "Request body too large");
      chunks.push(buffer);
    }
    if (signal?.aborted === true) throw operationCanceled();
    return Buffer.concat(chunks).toString("utf8");
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
  const send = async (event: Record<string, unknown>) => {
    if (response.writableEnded || abort.signal.aborted) return;
    const accepted = response.write(`data: ${JSON.stringify(event)}\n\n`);
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
  return { send, abort };
}

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  HTTP_AUTHORIZATION_HEADER
} from "../shared/http-auth.js";
import {
  HTTP_CLIENT_PROTOCOL_HEADER,
  HTTP_FIDELITY_HEADER,
  HTTP_SERVER_INSTANCE_HEADER
} from "../shared/http-protocol.js";
import { isCanonicalLoopbackOrigin } from "../shared/http-loopback-origin.js";
import { ServiceError } from "./errors.js";
import { HTTP_OPERATION_TICKET_HEADER } from "../shared/http-operation-protocol.js";

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const ALLOWED_HEADERS = new Set([
  HTTP_AUTHORIZATION_HEADER,
  HTTP_CLIENT_PROTOCOL_HEADER,
  HTTP_SERVER_INSTANCE_HEADER,
  HTTP_OPERATION_TICKET_HEADER,
  "content-type"
]);

export function validateDevelopmentOrigin(origin: string | null): string | null {
  if (origin === null) return null;
  if (!isCanonicalLoopbackOrigin(origin)) {
    throw new Error("1667 development origin must be a canonical numeric loopback origin");
  }
  return new URL(origin).origin;
}

export function applyCorsResponseHeaders(
  request: IncomingMessage,
  response: ServerResponse,
  developmentOrigin: string | null
): void {
  const origin = request.headers.origin;
  if (developmentOrigin === null || origin !== developmentOrigin) return;
  response.setHeader("access-control-allow-origin", developmentOrigin);
  response.setHeader("access-control-expose-headers", HTTP_FIDELITY_HEADER);
  response.setHeader("vary", appendVary(response.getHeader("vary"), "Origin"));
}

export function handleCorsPreflight(
  request: IncomingMessage,
  response: ServerResponse,
  developmentOrigin: string | null
): boolean {
  if ((request.method ?? "GET").toUpperCase() !== "OPTIONS") return false;
  const origin = request.headers.origin;
  if (developmentOrigin === null || origin !== developmentOrigin) {
    throw new ServiceError(403, "Forbidden CORS origin");
  }
  const method = request.headers["access-control-request-method"];
  if (typeof method !== "string" || !ALLOWED_METHODS.has(method.toUpperCase())) {
    throw new ServiceError(403, "Forbidden CORS method");
  }
  const requested = String(request.headers["access-control-request-headers"] ?? "")
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  if (requested.length > ALLOWED_HEADERS.size
    || requested.some((header) => !ALLOWED_HEADERS.has(header))) {
    throw new ServiceError(403, "Forbidden CORS headers");
  }
  applyCorsResponseHeaders(request, response, developmentOrigin);
  response.writeHead(204, {
    "access-control-allow-methods": [...ALLOWED_METHODS].join(", "),
    "access-control-allow-headers": [...ALLOWED_HEADERS].join(", "),
    "access-control-max-age": "600",
    "cache-control": "no-store"
  });
  response.end();
  return true;
}

function appendVary(current: number | string | string[] | undefined, value: string): string {
  const values = (Array.isArray(current) ? current : [current ?? ""])
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!values.some((entry) => entry.toLowerCase() === value.toLowerCase())) {
    values.push(value);
  }
  return values.join(", ");
}

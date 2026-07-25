import type { IncomingMessage } from "node:http";
import {
  HTTP_CLIENT_PROTOCOL_HEADER,
  HTTP_MAX_CLIENT_PROTOCOL_VERSION,
  HTTP_MIN_CLIENT_PROTOCOL_VERSION,
  HTTP_SERVER_INSTANCE_HEADER
} from "../shared/http-protocol.js";
import { ServiceError } from "./errors.js";

export function parseCanonicalApiPath(pathname: string): readonly [
  string,
  string?,
  string?,
  string?,
  string?
] {
  const segments = pathname.split("/");
  if (segments[0] !== ""
    || segments[1] !== "api"
    || segments.length < 3
    || segments.slice(2).some((segment) => segment.length === 0)
    || segments.length > 7) {
    throw new ServiceError(400, "API path must use canonical nonempty segments");
  }
  return segments.slice(2) as [
    string,
    string?,
    string?,
    string?,
    string?
  ];
}

export function requireCompatibleHttpClient(request: IncomingMessage): void {
  const rawVersion = request.headers[HTTP_CLIENT_PROTOCOL_HEADER];
  if (typeof rawVersion !== "string" || !/^\d+$/.test(rawVersion)) {
    throw new ServiceError(
      400,
      `Missing or invalid ${HTTP_CLIENT_PROTOCOL_HEADER} header`
    );
  }
  const version = Number(rawVersion);
  if (!Number.isSafeInteger(version)
    || version < HTTP_MIN_CLIENT_PROTOCOL_VERSION
    || version > HTTP_MAX_CLIENT_PROTOCOL_VERSION) {
    throw new ServiceError(
      409,
      `Incompatible 1667 client protocol ${rawVersion}`
    );
  }
}

export function requireCurrentHttpServerInstance(
  request: IncomingMessage,
  instanceId: string
): void {
  const method = (request.method ?? "GET").toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return;
  if (request.headers[HTTP_SERVER_INSTANCE_HEADER] !== instanceId) {
    throw new ServiceError(
      409,
      "The 1667 server changed after compatibility negotiation; reload authoritative state and retry"
    );
  }
}

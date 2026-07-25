import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpAuthRecord } from "../shared/http-auth.js";
import {
  HTTP_OPERATION_RESERVATION_PATH,
  HTTP_OPERATION_SESSION_PATH,
  HTTP_OPERATION_TICKET_HEADER,
  type HttpOperationReservationRequest
} from "../shared/http-operation-protocol.js";
import { ServiceError } from "./errors.js";
import {
  httpBearerCapability,
  requireAnyHttpCapability
} from "./http-authorization.js";
import { readJsonBody, sendJson } from "./http.js";
import type { HttpOperationSessionStore } from "./http-operation-sessions.js";
import type { StoryService } from "./story-service.js";
import { parseStoryAggregateVersion } from "../shared/story-aggregate-version.js";
import { httpRecoveryWarnings } from "./http-recovery-warnings.js";

interface HttpOperationControlContext {
  readonly authRecord: HttpAuthRecord;
  readonly service: StoryService | null;
  readonly operationSessions: HttpOperationSessionStore;
}

export async function handleHttpOperationControl(
  context: HttpOperationControlContext,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  method: string
): Promise<void> {
  if (pathname === HTTP_OPERATION_SESSION_PATH && method === "POST") {
    const scope = requireAnyHttpCapability(request, context.authRecord);
    const session = context.operationSessions.createSession(
      scope,
      requireOperationSessionCapability(request)
    );
    return sendJson(response, 201, {
      ...session,
      recoveryWarnings: httpRecoveryWarnings(context.service, scope)
    });
  }
  const capability = requireOperationSessionCapability(request);
  if (pathname === HTTP_OPERATION_RESERVATION_PATH && method === "POST") {
    const body = await readJsonBody(request, undefined, 4_096);
    return sendJson(response, 201, await context.operationSessions.reserve(
      capability,
      parseReservationRequest(body)
    ));
  }
  const ticket = requireHttpOperationTicket(request);
  if (pathname === "/api/operations/status" && method === "GET") {
    return sendJson(response, 200,
      context.operationSessions.status(capability, ticket));
  }
  if (pathname === "/api/operations/cancel" && method === "POST") {
    return sendJson(response, 200,
      context.operationSessions.cancel(capability, ticket));
  }
  if (pathname === "/api/operations/terminal" && method === "DELETE") {
    context.operationSessions.acknowledge(capability, ticket);
    return sendJson(response, 200, { ok: true });
  }
  if (pathname === "/api/operations/session" && method === "DELETE") {
    await context.operationSessions.closeSession(capability);
    return sendJson(response, 200, { ok: true });
  }
  throw new ServiceError(404, `No route: ${method} ${pathname}`);
}

export function requireOperationSessionCapability(
  request: IncomingMessage
): string {
  const capability = httpBearerCapability(request.headers.authorization);
  if (capability !== null) return capability;
  throw new ServiceError(
    401,
    "Missing or invalid HTTP operation-session capability",
    "unauthorized"
  );
}

export function requireHttpOperationTicket(request: IncomingMessage): string {
  const ticket = request.headers[HTTP_OPERATION_TICKET_HEADER];
  if (typeof ticket === "string" && ticket.length <= 160) return ticket;
  throw new ServiceError(
    400,
    `Missing or invalid ${HTTP_OPERATION_TICKET_HEADER} header`,
    "invalid_request"
  );
}

function parseReservationRequest(
  value: Record<string, unknown>
): HttpOperationReservationRequest {
  if (Object.keys(value).some((key) =>
    ![
      "method",
      "path",
      "operation",
      "requestedLifetimeMs",
      "mutationId",
      "expectedAggregateVersion"
    ]
      .includes(key))) {
    throw new ServiceError(
      400,
      "HTTP operation reservation has unknown fields",
      "invalid_request"
    );
  }
  if (typeof value.method !== "string"
    || typeof value.path !== "string"
    || typeof value.operation !== "string") {
    throw new ServiceError(
      400,
      "HTTP operation reservation requires method and path",
      "invalid_request"
    );
  }
  return {
    method: value.method,
    path: value.path,
    operation: value.operation as HttpOperationReservationRequest["operation"],
    ...(value.requestedLifetimeMs === undefined
      ? {}
      : { requestedLifetimeMs: value.requestedLifetimeMs as number }),
    ...(value.mutationId === undefined
      ? {}
      : { mutationId: value.mutationId as string }),
    ...(value.expectedAggregateVersion === undefined
      ? {}
      : {
          expectedAggregateVersion: parseExpectedAggregateVersion(
            value.expectedAggregateVersion
          )
        })
  };
}

function parseExpectedAggregateVersion(value: unknown) {
  try {
    return parseStoryAggregateVersion(value, "expectedAggregateVersion");
  } catch (error) {
    throw new ServiceError(
      400,
      error instanceof Error ? error.message : "expectedAggregateVersion is invalid",
      "invalid_request"
    );
  }
}

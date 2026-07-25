import type { HttpApiMetadata } from "../../shared/http-protocol.js";
import { parseCanonicalLoopbackOrigin } from "../../shared/http-loopback-origin.js";
import {
  createApi,
  type HttpApiAccess,
  type StoryApi
} from "../src/api.js";
import {
  HTTP_OPERATION_RESERVATION_PATH,
  HTTP_OPERATION_SESSION_PATH,
  HTTP_OPERATION_TICKET_HEADER
} from "../../shared/http-operation-protocol.js";
import {
  HTTP_SERVER_INSTANCE_HEADER
} from "../../shared/http-protocol.js";
import { HTTP_AUTHORIZATION_HEADER } from "../../shared/http-auth.js";

export const TEST_HTTP_INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

export function createTestApi(
  baseUrl: string,
  onMetadata?: (metadata: HttpApiMetadata) => boolean | void,
  onReservation?: (request: Record<string, unknown>) => unknown
): StoryApi {
  return createApi(
    baseUrl,
    onMetadata,
    testHttpAccess(baseUrl, TEST_HTTP_INSTANCE_ID, onReservation)
  );
}

export function testHttpAccess(
  baseUrl: string,
  instanceId = TEST_HTTP_INSTANCE_ID,
  onReservation?: (request: Record<string, unknown>) => unknown
): HttpApiAccess {
  const origin = parseCanonicalLoopbackOrigin(baseUrl).origin;
  const authRecord = {
    schema: 1 as const,
    origin,
    instanceId,
    capabilities: {
      story: "11".repeat(32),
      admin: "22".repeat(32)
    }
  };
  return {
    authRecord,
    fetch: operationAwareFixtureFetch(origin, authRecord, onReservation)
  };
}

function operationAwareFixtureFetch(
  origin: string,
  authRecord: HttpApiAccess["authRecord"],
  onReservation?: (request: Record<string, unknown>) => unknown
): HttpApiAccess["fetch"] {
  const sessions = {
    story: {
      sessionId: "aa".repeat(16),
      capability: "bb".repeat(32),
      sequence: 0
    },
    admin: {
      sessionId: "cc".repeat(16),
      capability: "dd".repeat(32),
      sequence: 0
    }
  };
  return async (input, init) => {
    const url = String(input);
    const pathname = new URL(url, origin).pathname;
    const headers = new Headers(init?.headers);
    const listenerInstanceId = headers.get(HTTP_SERVER_INSTANCE_HEADER)
      ?? authRecord.instanceId;
    if (pathname === HTTP_OPERATION_SESSION_PATH) {
      const authorization = headers.get(HTTP_AUTHORIZATION_HEADER);
      const scope = authorization === `Bearer ${authRecord.capabilities.admin}`
        ? "admin"
        : "story";
      const session = sessions[scope];
      return Response.json({
        listenerInstanceId,
        sessionId: session.sessionId,
        scope,
        capability: session.capability,
        idleTimeoutMs: 60_000,
        recoveryWarnings: []
      }, { status: 201 });
    }
    if (pathname === HTTP_OPERATION_RESERVATION_PATH) {
      const request = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      const override = onReservation?.(request);
      if (override instanceof Response) return override;
      const authorization = headers.get(HTTP_AUTHORIZATION_HEADER);
      const session = authorization === `Bearer ${sessions.admin.capability}`
        ? sessions.admin
        : sessions.story;
      const sequence = String(++session.sequence);
      return Response.json({
        listenerInstanceId,
        sessionId: session.sessionId,
        sequence,
        ticket: `${session.sessionId}.${sequence}.${"ee".repeat(32)}`,
        lifetime: "local",
        deadlineEpochMs: Date.now() + 30_000,
        startDeadlineEpochMs: Date.now() + 5_000
      }, { status: 201 });
    }
    if (pathname === "/api/operations/status"
      || pathname === "/api/operations/cancel") {
      const [sessionId, sequence] = (
        headers.get(HTTP_OPERATION_TICKET_HEADER) ?? ""
      ).split(".");
      return Response.json({
        listenerInstanceId,
        sessionId,
        sequence,
        state: "completed",
        terminal: true,
        cancelRequested: false
      });
    }
    if (pathname === "/api/operations/terminal"
      || pathname === "/api/operations/session") {
      return Response.json({ ok: true });
    }
    return await globalThis.fetch(input, init);
  };
}

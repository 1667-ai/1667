/** Typed HTTP boundary for the additive Aside routes.
 *
 * This module owns URL/query parsing and the complete HTTP dispatch flow. The
 * main router only selects the Aside family and passes existing dependencies.
 */
import { ServiceError } from "./errors.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "./http.js";
import { streamResponse } from "./stream-response.js";
import type { InternalErrorReporter } from "./internal-error-reporter.js";
import type { ReasoningStreamDelta } from "./providers.js";
import type { RunningHttpOperation } from "./http-operation-sessions.js";
import type { StoryService } from "./story-service.js";
import {
  AsideTransportError,
  parseAsideAnchor,
  parseAsideAskBody,
  parseAsideReadRequest,
  parseAsideRetakeBody,
  parseAsideSessionMutationBody
} from "../shared/aside-transport-codec.js";
import type {
  AsideAskRequestValue,
  AsideReadRequest,
  AsideRetakeRequest,
  AsideSessionMutationRequest
} from "../shared/aside-transport.js";

function parse<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof AsideTransportError) {
      throw new ServiceError(400, error.message, "invalid_request");
    }
    throw error;
  }
}

export function parseAsideReadQuery(
  searchParams: URLSearchParams
): AsideReadRequest["anchor"] | undefined {
  if (searchParams.size === 0) return undefined;
  const keys = [...searchParams.keys()];
  if (keys.some((key) => key !== "partId" && key !== "takeId" && key !== "unanchored")) {
    throw new ServiceError(
      400,
      "Aside read query contains unknown fields",
      "invalid_request"
    );
  }
  const unanchored = searchParams.getAll("unanchored");
  if (unanchored.length > 0) {
    if (searchParams.size !== 1 || unanchored.length !== 1 || unanchored[0] !== "true") {
      throw new ServiceError(
        400,
        "Use unanchored=true or partId and takeId",
        "invalid_request"
      );
    }
    return null;
  }
  const partIds = searchParams.getAll("partId");
  const takeIds = searchParams.getAll("takeId");
  if (partIds.length !== 1 || takeIds.length !== 1 || searchParams.size !== 2) {
    throw new ServiceError(
      400,
      "Use unanchored=true or partId and takeId",
      "invalid_request"
    );
  }
  return parse(() => parseAsideReadRequest({
    storyId: "query",
    anchor: parseAsideAnchor({ partId: partIds[0], takeId: takeIds[0] })
  }).anchor);
}

export function parseAsideAskRouteBody(
  storyId: string,
  value: unknown
): AsideAskRequestValue {
  return parse(() => parseAsideAskBody(storyId, value));
}

export function parseAsideSessionMutationRouteBody(
  storyId: string,
  value: unknown
): AsideSessionMutationRequest {
  return parse(() => parseAsideSessionMutationBody(storyId, value));
}

export function parseAsideRetakeRouteBody(
  storyId: string,
  value: unknown
): AsideRetakeRequest {
  return parse(() => parseAsideRetakeBody(storyId, value));
}

type AsideMutationMethod =
  | "askAside"
  | "clearAside"
  | "asideSessionMutation"
  | "retakeAside";

type AsideMutationRunner = (
  method: AsideMutationMethod,
  input: unknown,
  onDelta?: (text: string) => void | Promise<void>,
  signal?: AbortSignal,
  onReasoning?: (delta: ReasoningStreamDelta) => void | Promise<void>,
  canCommitStoppedAside?: () => boolean
) => Promise<unknown>;

export interface AsideHttpHandlerInput {
  readonly storyId: string;
  readonly sub: string | undefined;
  readonly subId: string | undefined;
  readonly action: string | undefined;
  readonly method: string;
  readonly searchParams: URLSearchParams;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly service: StoryService;
  readonly jsonBody: () => Promise<unknown>;
  readonly mutate: AsideMutationRunner;
  readonly operation: RunningHttpOperation;
  readonly errorReporter: InternalErrorReporter;
}

/** Handle the complete take-anchored Aside HTTP surface. */
export async function maybeHandleAsideApi(
  input: AsideHttpHandlerInput
): Promise<boolean> {
  const {
    storyId,
    sub,
    subId,
    action,
    method,
    searchParams,
    request,
    response,
    service,
    jsonBody,
    mutate,
    operation,
    errorReporter
  } = input;
  if (sub !== "aside") return false;
  if (subId === undefined && action === undefined) {
    if (method === "GET") {
      const anchor = parseAsideReadQuery(searchParams);
      await sendJson(
        response,
        200,
        anchor === undefined
          ? await service.getAside(storyId)
          : await service.getAsideV2(storyId, anchor)
      );
      return true;
    }
    if (method === "DELETE") {
      await sendJson(response, 200, await mutate("clearAside", { storyId }));
      return true;
    }
    return false;
  }
  if (subId === "ask" && method === "POST") {
    const askInput = parseAsideAskRouteBody(storyId, await jsonBody());
    await streamResponse(
      request,
      response,
      (onDelta, signal, onReasoning, transportConnected) => mutate(
        "askAside",
        askInput,
        onDelta,
        signal,
        onReasoning,
        () => operation.isUserCancellationAuthoritative()
          && transportConnected()
      ),
      (result) => ({ type: "done", aside: result }),
      operation.signal,
      errorReporter,
      "askAside",
      (failure) => operation.finish({ state: "failed", failure }),
      {
        preserveDoneAfterOperationAbort: () =>
          operation.isUserCancellationAuthoritative()
      }
    );
    return true;
  }
  if (subId === "session" && method === "POST") {
    const sessionInput = parseAsideSessionMutationRouteBody(storyId, await jsonBody());
    await sendJson(
      response,
      200,
      await mutate("asideSessionMutation", sessionInput)
    );
    return true;
  }
  if (subId === "retake" && method === "POST") {
    const retakeInput = parseAsideRetakeRouteBody(storyId, await jsonBody());
    await streamResponse(
      request,
      response,
      (onDelta, signal, onReasoning, transportConnected) => mutate(
        "retakeAside",
        retakeInput,
        onDelta,
        signal,
        onReasoning,
        () => operation.isUserCancellationAuthoritative()
          && transportConnected()
      ),
      (result) => ({ type: "done", aside: result }),
      operation.signal,
      errorReporter,
      "retakeAside",
      (failure) => operation.finish({ state: "failed", failure }),
      {
        preserveDoneAfterOperationAbort: () =>
          operation.isUserCancellationAuthoritative()
      }
    );
    return true;
  }
  return false;
}

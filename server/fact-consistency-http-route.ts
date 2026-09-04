import type { ServerResponse } from "node:http";
import { sendJson } from "./http.js";
import type { StoryService } from "./story-service.js";

type FactConsistencyMutationRunner = (input: unknown) => Promise<unknown>;

export interface FactConsistencyHttpHandlerInput {
  readonly storyId: string;
  readonly sub: string | undefined;
  readonly subId: string | undefined;
  readonly method: string;
  readonly response: ServerResponse;
  readonly service: StoryService;
  readonly jsonBody: () => Promise<Record<string, unknown>>;
  readonly mutate: FactConsistencyMutationRunner;
}

/** Handle the plan, check, and latest-run Fact consistency routes. */
export async function maybeHandleFactConsistencyApi(
  input: FactConsistencyHttpHandlerInput
): Promise<boolean> {
  const {
    storyId,
    sub,
    subId,
    method,
    response,
    service,
    jsonBody,
    mutate
  } = input;
  if (sub !== "fact-consistency") return false;
  if (method === "GET" && subId === undefined) {
    sendJson(response, 200, await service.getFactConsistencyRun(storyId));
    return true;
  }
  if (method !== "POST" || (subId !== "plan" && subId !== "check")) return false;
  const body = await jsonBody();
  const request = {
    storyId,
    focusedPartId: body.focusedPartId,
    scope: body.scope,
    ...(subId === "check" ? { planToken: body.planToken } : {})
  };
  if (subId === "plan") {
    sendJson(response, 200, await service.planFactConsistency(request));
  } else {
    sendJson(response, 200, await mutate(request));
  }
  return true;
}

import { afterEach, expect, test } from "bun:test";
import { apiErrorCode } from "../src/api.js";
import {
  createTestApi,
  testHttpMetadata,
  testStoryPayload
} from "./http-api-fixture.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("HTTP errors expose persisted diagnostic references", async () => {
  const diagnosticRef = "err_deadbeefdeadbeefdeadbeef";
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith("/api/health")) {
      return Response.json(testHttpMetadata());
    }
    return Response.json(
      {
        error: "Internal server error",
        code: "internal",
        diagnosticRef
      },
      { status: 500 }
    );
  }) as typeof fetch;

  const error = await rejection(
    createTestApi("http://127.0.0.1:7373").getSettings()
  );

  expect(error).toMatchObject({
    code: "internal",
    diagnosticRef,
    status: 500
  });
  expect(error.message).toContain(diagnosticRef);
});

test("HTTP streams preserve diagnostics for uncertain public outcomes", async () => {
  const diagnosticRef = "err_deadbeefdeadbeefdeadbeef";
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/health")) {
      return Response.json(testHttpMetadata());
    }
    if (url.endsWith("/api/stories/story")
      && (init?.method ?? "GET") === "GET") {
      return Response.json(testStoryPayload("story"));
    }
    if (url.endsWith("/api/stories/story/continue")) {
      return new Response(
        `data: ${JSON.stringify({
          type: "error",
          code: "generation_outcome_unknown",
          message: "Generation outcome is unknown",
          status: 409,
          diagnosticRef
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } }
      );
    }
    throw new Error(`Unexpected API request: ${url}`);
  }) as typeof fetch;
  const api = createTestApi("http://127.0.0.1:7373");
  await api.loadStory("story");

  const error = await rejection(api.continueStory(
    "story",
    "",
    "generation-id",
    {},
    () => {},
    new AbortController().signal
  ));

  expect(error).toMatchObject({ diagnosticRef, status: 409 });
  expect(apiErrorCode(error)).toBe("generation_outcome_unknown");
  expect(error.message).toContain(diagnosticRef);
});

async function rejection(
  promise: Promise<unknown>
): Promise<Error & Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    return error as Error & Record<string, unknown>;
  }
  throw new Error("Expected promise to reject");
}

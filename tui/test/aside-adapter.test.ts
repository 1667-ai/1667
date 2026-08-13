import { afterEach, expect, test } from "bun:test";
import { createApi } from "../src/api.js";
import { storyApiFromWorkerTransport } from "../src/worker-story-api.js";
import { demoAppSource } from "../src/demo.js";
import {
  testHttpAccess,
  testHttpMetadata,
  testStoryPayload
} from "./http-api-fixture.js";

const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; });

test("HTTP Aside keeps a committed document when its version refresh fails", async () => {
  const aside = {
    notes: [{ question: "Why?", answer: "Because." }]
  };
  let storyLoads = 0;
  let clearVersion: unknown;
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/health") return Response.json(testHttpMetadata());
    if (path === "/api/stories/story" && method === "GET") {
      storyLoads += 1;
      if (storyLoads === 2) throw new TypeError("transient refresh failure");
      return Response.json({
        ...testStoryPayload("story"),
        aggregateVersion: {
          kind: "v6",
          revision: storyLoads === 1
            ? "00000000000000000001"
            : "00000000000000000002"
        }
      });
    }
    if (path === "/api/stories/story/aside/ask" && method === "POST") {
      return terminalStream([
        { type: "delta", text: "Because." },
        { type: "done", aside }
      ]);
    }
    if (path === "/api/stories/story/aside" && method === "DELETE") {
      return Response.json({
        ...testStoryPayload("story"),
        aggregateVersion: {
          kind: "v6",
          revision: "00000000000000000003"
        }
      });
    }
    throw new Error(`Unexpected HTTP request: ${method} ${path}`);
  }) as typeof fetch;

  const baseUrl = "http://127.0.0.1:7373";
  const api = createApi(baseUrl, undefined, {
    ...testHttpAccess(baseUrl, undefined, (reservation) => {
      if (reservation.path === "/api/stories/story/aside"
        && reservation.method === "DELETE") {
        clearVersion = reservation.expectedAggregateVersion;
      }
    })
  });

  expect(await api.askAside(
    "story",
    "Why?",
    () => {},
    new AbortController().signal
  )).toEqual(aside);
  expect(storyLoads).toBe(2);

  const cleared = await api.clearAside("story");
  expect(cleared.aggregateVersion).toEqual({
    kind: "v6",
    revision: "00000000000000000003"
  });
  expect(clearVersion).toEqual({
    kind: "v6",
    revision: "00000000000000000002"
  });
  expect(storyLoads).toBe(3);
});

test("embedded Aside keeps a committed document when its version refresh fails", async () => {
  const source = demoAppSource();
  const aside = {
    notes: [{ question: "Why?", answer: "Because." }]
  };
  const payload = (revision: string) => ({
    ...structuredClone(source.payload),
    id: "story",
    aggregateVersion: { kind: "v6" as const, revision }
  });
  let storyLoads = 0;
  let clearVersion: unknown;
  const api = storyApiFromWorkerTransport({
    call: async (method: string, _input: unknown, options?: {
      expectedAggregateVersion?: unknown;
    }) => {
      if (method === "loadStory") {
        storyLoads += 1;
        if (storyLoads === 2) throw new Error("transient refresh failure");
        return payload(storyLoads === 1
          ? "00000000000000000001"
          : "00000000000000000002");
      }
      if (method === "askAside") return aside;
      if (method === "clearAside") {
        clearVersion = options?.expectedAggregateVersion;
        return payload("00000000000000000003");
      }
      throw new Error(`Unexpected worker method: ${method}`);
    }
  } as never);

  expect(await api.askAside(
    "story",
    "Why?",
    () => {},
    new AbortController().signal
  )).toEqual(aside);
  expect(storyLoads).toBe(2);

  const cleared = await api.clearAside("story");
  expect(cleared.aggregateVersion).toEqual({
    kind: "v6",
    revision: "00000000000000000003"
  });
  expect(clearVersion).toEqual({
    kind: "v6",
    revision: "00000000000000000002"
  });
  expect(storyLoads).toBe(3);
});

function terminalStream(events: readonly Record<string, unknown>[]): Response {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(events.map(
        (event) => `data: ${JSON.stringify(event)}\n\n`
      ).join("")));
      controller.close();
    }
  }), { headers: { "content-type": "text/event-stream" } });
}

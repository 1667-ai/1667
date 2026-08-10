import { afterEach, expect, test } from "bun:test";
import { ApiHttpError, createApi } from "../src/api.js";
import {
  testHttpAccess,
  testHttpMetadata,
  testStoryPayload
} from "./http-api-fixture.js";

const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; });

test("HTTP rewrite terminal stays authoritative beyond the stop control handoff", async () => {
  let transportAbortedBeforeTerminal = false;
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/health") return Response.json(testHttpMetadata());
    if (path === "/api/stories/story") return Response.json(testStoryPayload("story"));
    if (path !== "/api/stories/story/nodes/node/rewrite") {
      throw new Error(`Unexpected HTTP request: ${path}`);
    }
    return new Response(new ReadableStream({
      start(controller) {
        let terminalSent = false;
        controller.enqueue(sse({ type: "delta", text: "before " }));
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          if (!terminalSent) {
            transportAbortedBeforeTerminal = true;
            controller.error(signal.reason);
          }
        }, { once: true });
        setTimeout(() => {
          if (transportAbortedBeforeTerminal) return;
          controller.enqueue(sse({ type: "delta", text: "after " }));
          controller.enqueue(sse({ type: "delta", text: "tail" }));
          controller.enqueue(sse({ type: "done", nodeId: "committed-take" }));
          terminalSent = true;
          controller.close();
        }, 225);
      }
    }), {
      headers: { "content-type": "text/event-stream" }
    });
  }) as typeof fetch;
  const baseUrl = "http://127.0.0.1:7373";
  const api = createApi(baseUrl, undefined, testHttpAccess(baseUrl));
  const stopped = new AbortController();
  const deltas: string[] = [];
  const tails: string[] = [];

  const result = await api.rewriteNode(
    "story",
    "node",
    { start: 0, end: 1, expected: "x", instruction: "" },
    (text) => {
      deltas.push(text);
      stopped.abort();
    },
    stopped.signal,
    undefined,
    (text) => tails.push(text)
  );

  expect(result).toBe("committed-take");
  expect(transportAbortedBeforeTerminal).toBeFalse();
  expect(deltas).toEqual(["before "]);
  expect(tails).toEqual([]);
});

test("HTTP done in the same SSE buffer stays authoritative after onDelta stops", async () => {
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/health") return Response.json(testHttpMetadata());
    if (path === "/api/stories/story") return Response.json(testStoryPayload("story"));
    if (path !== "/api/stories/story/nodes/node/rewrite") {
      throw new Error(`Unexpected HTTP request: ${path}`);
    }
    return terminalStream([
      { type: "delta", text: "accepted" },
      { type: "done", nodeId: "committed-take" }
    ]);
  }) as typeof fetch;
  const baseUrl = "http://127.0.0.1:7373";
  const api = createApi(baseUrl, undefined, testHttpAccess(baseUrl));
  const stopped = new AbortController();
  const deltas: string[] = [];
  const tails: string[] = [];

  const result = await api.rewriteNode(
    "story",
    "node",
    { start: 0, end: 1, expected: "x", instruction: "" },
    (text) => {
      deltas.push(text);
      stopped.abort();
    },
    stopped.signal,
    undefined,
    (text) => tails.push(text)
  );

  expect(result).toBe("committed-take");
  expect(deltas).toEqual(["accepted"]);
  expect(stopped.signal.aborted).toBeTrue();
  expect(tails).toEqual([]);
});

test("HTTP error in the same SSE buffer stays authoritative after Stop and failed settlement", async () => {
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/health") return Response.json(testHttpMetadata());
    if (path === "/api/stories/story") return Response.json(testStoryPayload("story"));
    if (path !== "/api/stories/story/nodes/node/rewrite") {
      throw new Error(`Unexpected HTTP request: ${path}`);
    }
    return terminalStream([
      { type: "delta", text: "accepted" },
      {
        type: "error",
        code: "revision_conflict",
        message: "The rewrite target changed.",
        status: 409
      }
    ]);
  }) as typeof fetch;
  const baseUrl = "http://127.0.0.1:7373";
  let statusCalls = 0;
  const api = createApi(baseUrl, undefined, testHttpAccess(
    baseUrl,
    undefined,
    undefined,
    (path) => {
      if (path !== "/api/operations/status") return undefined;
      statusCalls += 1;
      if (statusCalls !== 2) return undefined;
      return {
        state: "failed",
        failure: {
          code: "revision_conflict",
          message: "The rewrite target changed.",
          status: 409
        }
      };
    }
  ));
  const stopped = new AbortController();
  const deltas: string[] = [];
  const tails: string[] = [];

  const error = await rejection(api.rewriteNode(
    "story",
    "node",
    { start: 0, end: 1, expected: "x", instruction: "" },
    (text) => {
      deltas.push(text);
      stopped.abort();
    },
    stopped.signal,
    undefined,
    (text) => tails.push(text)
  ));

  expect(error instanceof ApiHttpError).toBe(true);
  expect(error).toMatchObject({ code: "revision_conflict", status: 409 });
  expect(statusCalls).toBe(2);
  expect(deltas).toEqual(["accepted"]);
  expect(stopped.signal.aborted).toBeTrue();
  expect(tails).toEqual([]);
});

test("HTTP partial-settlement retry reuses its durable mutation identity after 503", async () => {
  let partialAttempts = 0;
  const mutationIds: unknown[] = [];
  globalThis.fetch = (async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/health") return Response.json(testHttpMetadata());
    if (path === "/api/stories/story") return Response.json(testStoryPayload("story"));
    if (path !== "/api/stories/story/nodes/node/rewrite-partial") {
      throw new Error(`Unexpected HTTP request: ${path}`);
    }
    partialAttempts += 1;
    if (partialAttempts === 1) {
      return Response.json(
        { code: "temporary_failure", message: "Temporary failure" },
        { status: 503 }
      );
    }
    return Response.json({
      committed: { payload: testStoryPayload("story"), nodeId: "node" }
    });
  }) as typeof fetch;
  const baseUrl = "http://127.0.0.1:7373";
  const api = createApi(baseUrl, undefined, {
    ...testHttpAccess(baseUrl, undefined, (reservation) => {
      if (typeof reservation.mutationId === "string") {
        mutationIds.push(reservation.mutationId);
      }
    })
  });

  expect(await rejection(api.commitPartialRewrite(
    "story", "node", "digest", "attempt"
  ))).toMatchObject({ status: 503 });
  const committed = await api.commitPartialRewrite(
    "story", "node", "digest", "attempt"
  );

  expect(committed?.nodeId).toBe("node");
  expect(partialAttempts).toBe(2);
  expect(mutationIds).toHaveLength(2);
  expect(mutationIds[1]).toBe(mutationIds[0]);
});

test("HTTP partial-settlement retry reuses its durable mutation identity after transport loss", async () => {
  let partialAttempts = 0;
  const mutationIds: unknown[] = [];
  globalThis.fetch = (async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/health") return Response.json(testHttpMetadata());
    if (path === "/api/stories/story") return Response.json(testStoryPayload("story"));
    if (path !== "/api/stories/story/nodes/node/rewrite-partial") {
      throw new Error(`Unexpected HTTP request: ${path}`);
    }
    partialAttempts += 1;
    if (partialAttempts < 3) throw new TypeError("connection reset");
    return Response.json({
      committed: { payload: testStoryPayload("story"), nodeId: "node" }
    });
  }) as typeof fetch;
  const baseUrl = "http://127.0.0.1:7373";
  const api = createApi(baseUrl, undefined, {
    ...testHttpAccess(baseUrl, undefined, (reservation) => {
      if (typeof reservation.mutationId === "string") {
        mutationIds.push(reservation.mutationId);
      }
    })
  });

  await rejection(api.commitPartialRewrite("story", "node", "digest", "attempt"));
  expect((await api.commitPartialRewrite(
    "story", "node", "digest", "attempt"
  ))?.nodeId).toBe("node");

  expect(mutationIds).toHaveLength(3);
  expect(mutationIds[1]).toBe(mutationIds[0]);
  expect(mutationIds[2]).toBe(mutationIds[0]);
});

test("HTTP partial-settlement clears its identity after a terminal 4xx", async () => {
  let partialAttempts = 0;
  const mutationIds: unknown[] = [];
  globalThis.fetch = (async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/health") return Response.json(testHttpMetadata());
    if (path === "/api/stories/story") return Response.json(testStoryPayload("story"));
    if (path !== "/api/stories/story/nodes/node/rewrite-partial") {
      throw new Error(`Unexpected HTTP request: ${path}`);
    }
    partialAttempts += 1;
    if (partialAttempts === 1) {
      return Response.json(
        { code: "partial_rewrite_mismatch", message: "Partial rewrite mismatch" },
        { status: 409 }
      );
    }
    return Response.json({
      committed: { payload: testStoryPayload("story"), nodeId: "node" }
    });
  }) as typeof fetch;
  const baseUrl = "http://127.0.0.1:7373";
  const api = createApi(baseUrl, undefined, {
    ...testHttpAccess(baseUrl, undefined, (reservation) => {
      if (typeof reservation.mutationId === "string") {
        mutationIds.push(reservation.mutationId);
      }
    })
  });

  expect(await rejection(api.commitPartialRewrite(
    "story", "node", "digest", "attempt"
  ))).toMatchObject({ status: 409 });
  expect((await api.commitPartialRewrite(
    "story", "node", "digest", "attempt"
  ))?.nodeId).toBe("node");

  expect(mutationIds).toHaveLength(2);
  expect(mutationIds[1]).not.toBe(mutationIds[0]);
});

test("HTTP partial-settlement clears its identity after success", async () => {
  const mutationIds: unknown[] = [];
  globalThis.fetch = (async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/health") return Response.json(testHttpMetadata());
    if (path === "/api/stories/story") return Response.json(testStoryPayload("story"));
    if (path !== "/api/stories/story/nodes/node/rewrite-partial") {
      throw new Error(`Unexpected HTTP request: ${path}`);
    }
    return Response.json({
      committed: { payload: testStoryPayload("story"), nodeId: "node" }
    });
  }) as typeof fetch;
  const baseUrl = "http://127.0.0.1:7373";
  const api = createApi(baseUrl, undefined, {
    ...testHttpAccess(baseUrl, undefined, (reservation) => {
      if (typeof reservation.mutationId === "string") {
        mutationIds.push(reservation.mutationId);
      }
    })
  });

  await api.commitPartialRewrite("story", "node", "digest", "attempt");
  await api.commitPartialRewrite("story", "node", "digest", "attempt");

  expect(mutationIds).toHaveLength(2);
  expect(mutationIds[1]).not.toBe(mutationIds[0]);
});

test("HTTP reasoning frames route to onReasoning, counted, and never to onDelta or story prose", async () => {
  globalThis.fetch = (async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/health") return Response.json(testHttpMetadata());
    if (path === "/api/stories/story") return Response.json(testStoryPayload("story"));
    if (path !== "/api/stories/story/nodes/node/rewrite") {
      throw new Error(`Unexpected HTTP request: ${path}`);
    }
    return terminalStream([
      { type: "reasoning", text: "weigh", tokenCount: 1 },
      { type: "reasoning", text: " options", tokenCount: 2 },
      { type: "delta", text: "accepted" },
      { type: "done", nodeId: "committed-take" }
    ]);
  }) as typeof fetch;
  const baseUrl = "http://127.0.0.1:7373";
  const api = createApi(baseUrl, undefined, testHttpAccess(baseUrl));
  const stopped = new AbortController();
  const deltas: string[] = [];
  const reasoning: Array<{ text: string; tokenCount: number }> = [];

  const result = await api.rewriteNode(
    "story",
    "node",
    { start: 0, end: 1, expected: "x", instruction: "" },
    (text) => { deltas.push(text); },
    stopped.signal,
    undefined,
    undefined,
    (delta) => { reasoning.push(delta); }
  );

  expect(result).toBe("committed-take");
  expect(deltas).toEqual(["accepted"]);
  expect(reasoning).toEqual([
    { text: "weigh", tokenCount: 1 },
    { text: " options", tokenCount: 2 }
  ]);
});

test("HTTP reasoning tail is withheld after Stop and delivered once at terminal settlement, never through onReasoning", async () => {
  // The stream never reaches "done" — it ends mid-generation, the same as a
  // real Stop racing the network. Only then does the withheld-tail delivery
  // path fire; a stream that still reaches its terminal despite an abort
  // stays authoritative and discards the tail instead (the sibling test
  // above this one, and "HTTP done in the same SSE buffer stays
  // authoritative after onDelta stops").
  globalThis.fetch = (async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/health") return Response.json(testHttpMetadata());
    if (path === "/api/stories/story") return Response.json(testStoryPayload("story"));
    if (path !== "/api/stories/story/nodes/node/rewrite") {
      throw new Error(`Unexpected HTTP request: ${path}`);
    }
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(sse({ type: "reasoning", text: "before", tokenCount: 1 }));
        setTimeout(() => {
          controller.enqueue(sse({ type: "reasoning", text: "after", tokenCount: 2 }));
          controller.enqueue(sse({ type: "delta", text: "prose" }));
          controller.close();
        }, 20);
      }
    }), {
      headers: { "content-type": "text/event-stream" }
    });
  }) as typeof fetch;
  const baseUrl = "http://127.0.0.1:7373";
  const api = createApi(baseUrl, undefined, testHttpAccess(baseUrl));
  const stopped = new AbortController();
  const reasoning: Array<{ text: string; tokenCount: number }> = [];
  const reasoningTails: string[] = [];
  const deltas: string[] = [];
  const tails: string[] = [];

  const result = await api.rewriteNode(
    "story",
    "node",
    { start: 0, end: 1, expected: "x", instruction: "" },
    (text) => { deltas.push(text); },
    stopped.signal,
    undefined,
    (tail) => { tails.push(tail); },
    (delta) => {
      reasoning.push(delta);
      stopped.abort();
    },
    (tail) => { reasoningTails.push(tail); }
  );

  expect(result).toBe(null);
  expect(reasoning).toEqual([{ text: "before", tokenCount: 1 }]);
  expect(reasoningTails).toEqual(["after"]);
  expect(deltas).toEqual([]);
  expect(tails).toEqual(["prose"]);
});

function sse(event: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

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

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected rejection");
}

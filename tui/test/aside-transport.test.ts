import { afterEach, expect, test } from "bun:test";
import { createApi } from "../src/api.js";
import {
  storyApiFromWorkerTransport,
  type StoryWorkerTransport
} from "../src/worker-story-api.js";
import {
  testHttpAccess,
  testHttpMetadata,
  testStoryPayload
} from "./http-api-fixture.js";
import {
  parseAsideAskRequestValue,
  parseAsideResponse,
  parseAsideSessionMutationRequest
} from "../../shared/aside-transport-codec.js";

const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; });

const anchor = { partId: "part-1", takeId: "take-2" } as const;
const session = {
  schemaVersion: 2 as const,
  id: "session-2",
  anchor,
  title: "Why the door",
  turns: [{ q: "Why?", a: "Because.", thoughts: "weighing", thoughtTokens: 2 }]
};

test("HTTP Aside v2 carries anchor/session and preserves reasoning callbacks", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  let storyLoads = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const parsed = new URL(url);
    const method = init?.method ?? "GET";
    requests.push({
      url,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body))
    });
    if (parsed.pathname === "/api/health") return Response.json(testHttpMetadata());
    if (parsed.pathname === "/api/stories/story" && method === "GET") {
      storyLoads += 1;
      return Response.json(testStoryPayload("story"));
    }
    if (parsed.pathname === "/api/stories/story/aside" && method === "GET") {
      expect(parsed.searchParams.get("partId")).toBe(anchor.partId);
      expect(parsed.searchParams.get("takeId")).toBe(anchor.takeId);
      return Response.json({
        schemaVersion: 2,
        anchor,
        sessions: [session],
        anchors: [{ ...anchor, sessionCount: 1 }],
        unanchoredCount: 0
      });
    }
    if (parsed.pathname === "/api/stories/story/aside/ask" && method === "POST") {
      return terminalStream([
        { type: "reasoning", text: "weighing", tokenCount: 2 },
        { type: "delta", text: "Because." },
        { type: "done", aside: session }
      ]);
    }
    throw new Error(`Unexpected HTTP request: ${method} ${url}`);
  }) as typeof fetch;

  const api = createApi(
    "http://127.0.0.1:7373",
    undefined,
    testHttpAccess("http://127.0.0.1:7373")
  );
  const read = await api.getAsideV2!({ storyId: "story", anchor });
  expect(read?.sessions[0]?.id).toBe(session.id);

  const prose: string[] = [];
  const reasoning: string[] = [];
  const phases: string[] = [];
  const result = await api.askAsideV2!(
    { storyId: "story", question: "Why?", anchor, sessionId: session.id },
    (text) => prose.push(text),
    {
      onReasoning: (delta) => reasoning.push(`${delta.text}:${delta.tokenCount}`),
      onPhase: (phase) => phases.push(phase)
    },
    new AbortController().signal
  );
  expect(result?.id).toBe(session.id);
  expect(prose).toEqual(["Because."]);
  expect(reasoning).toEqual(["weighing:2"]);
  expect(phases).toEqual(["thinking", "writing"]);
  const ask = requests.find((request) => request.url.endsWith("/aside/ask"));
  expect(ask?.body).toEqual({
    question: "Why?",
    anchor,
    sessionId: session.id
  });
  expect(storyLoads).toBe(2);
});

test("HTTP Aside v2 uses embedded payloads without a post-commit reload", async () => {
  const payload = testStoryPayload("story");
  let storyLoads = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const parsed = new URL(url);
    const method = init?.method ?? "GET";
    if (parsed.pathname === "/api/health") return Response.json(testHttpMetadata());
    if (parsed.pathname === "/api/stories/story" && method === "GET") {
      storyLoads += 1;
      return Response.json(payload);
    }
    if (parsed.pathname === "/api/stories/story/aside/ask" && method === "POST") {
      return terminalStream([{ type: "done", aside: { ...session, payload } }]);
    }
    if (parsed.pathname === "/api/stories/story/aside/retake" && method === "POST") {
      return terminalStream([{ type: "done", aside: { ...session, payload } }]);
    }
    throw new Error(`Unexpected HTTP request: ${method} ${url}`);
  }) as typeof fetch;

  const api = createApi(
    "http://127.0.0.1:7373",
    undefined,
    testHttpAccess("http://127.0.0.1:7373")
  );
  const signal = new AbortController().signal;
  const asked = await api.askAsideV2!(
    { storyId: "story", question: "Why?", anchor, sessionId: session.id },
    () => {},
    undefined,
    signal
  );
  const retaken = await api.retakeAside!(
    { storyId: "story", sessionId: session.id, turnIndex: 0, anchor },
    () => {},
    undefined,
    signal
  );

  expect(asked?.payload?.id).toBe("story");
  expect(retaken?.payload?.id).toBe("story");
  expect(storyLoads).toBe(1);
});

test("HTTP Aside v2 local verbs and retake use distinct endpoints", async () => {
  const requests: Array<{
    pathname: string;
    operation: unknown;
    body: Record<string, unknown>;
  }> = [];
  let storyLoads = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const parsed = new URL(url);
    const method = init?.method ?? "GET";
    if (parsed.pathname === "/api/health") return Response.json(testHttpMetadata());
    if (parsed.pathname === "/api/stories/story" && method === "GET") {
      storyLoads += 1;
      return Response.json(testStoryPayload("story"));
    }
    if ((parsed.pathname === "/api/stories/story/aside/session"
      || parsed.pathname === "/api/stories/story/aside/retake")
      && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({ pathname: parsed.pathname, operation: body.operation, body });
      if (parsed.pathname.endsWith("/retake")) {
        return terminalStream([
          { type: "reasoning", text: "rechecking", tokenCount: 3 },
          { type: "delta", text: "Again." },
          { type: "done", aside: session }
        ]);
      }
      return Response.json(session);
    }
    throw new Error(`Unexpected HTTP request: ${method} ${url}`);
  }) as typeof fetch;

  const api = createApi(
    "http://127.0.0.1:7373",
    undefined,
    testHttpAccess("http://127.0.0.1:7373")
  );
  const turn = { storyId: "story", sessionId: session.id, turnIndex: 0, anchor } as const;
  const deleted = await api.deleteAsideTurn!(turn);
  const reset = await api.resetAside!(turn);
  const cleared = await api.clearAsideSession!({
    storyId: "story",
    sessionId: session.id,
    anchor: null
  });
  const prose: string[] = [];
  const reasoning: string[] = [];
  const phases: string[] = [];
  const retaken = await api.retakeAside!(
    { ...turn, anchor: null },
    (text) => prose.push(text),
    {
      onReasoning: (delta) => reasoning.push(`${delta.text}:${delta.tokenCount}`),
      onPhase: (phase) => phases.push(phase)
    },
    new AbortController().signal
  );

  expect(deleted.id).toBe(session.id);
  expect(reset.id).toBe(session.id);
  expect(cleared.id).toBe(session.id);
  expect(retaken?.id).toBe(session.id);
  expect(prose).toEqual(["Again."]);
  expect(reasoning).toEqual(["rechecking:3"]);
  expect(phases).toEqual(["thinking", "writing"]);
  expect(requests.map(({ pathname }) => pathname)).toEqual([
    "/api/stories/story/aside/session",
    "/api/stories/story/aside/session",
    "/api/stories/story/aside/session",
    "/api/stories/story/aside/retake"
  ]);
  expect(requests.map(({ operation }) => operation)).toEqual([
    "delete-turn", "reset", "clear", undefined
  ]);
  expect(requests[0]?.body).toEqual({
    operation: "delete-turn",
    sessionId: session.id,
    turnIndex: 0,
    anchor
  });
  expect(requests[1]?.body).toEqual({
    operation: "reset",
    sessionId: session.id,
    turnIndex: 0,
    anchor
  });
  expect(requests[2]?.body).toEqual({
    operation: "clear",
    sessionId: session.id,
    anchor: null
  });
  expect(requests[3]?.body).toEqual({
    sessionId: session.id,
    turnIndex: 0,
    anchor: null
  });
  expect(storyLoads).toBe(5);
});

test("worker Aside v2 forwards anchor, session id, and reasoning channels", async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const reasoning: string[] = [];
  const prose: string[] = [];
  const signal = new AbortController().signal;
  let storyLoads = 0;
  const workerCall = async (
    method: string,
    input: unknown,
    options?: {
      onDelta?: (text: string) => void;
      onStopped?: (text: string) => void;
      onReasoning?: (delta: { text: string; tokenCount: number }) => void;
      onReasoningStopped?: (text: string) => void;
      signal?: AbortSignal;
      expectedAggregateVersion?: { kind: "v6"; revision: string };
    }
  ): Promise<unknown> => {
      calls.push({ method, input });
      if (method === "getAside") return {
        schemaVersion: 2,
        anchor,
        sessions: [session],
        anchors: [{ ...anchor, sessionCount: 1 }],
        unanchoredCount: 0
      };
      if (method === "loadStory") {
        storyLoads += 1;
        return {
          ...testStoryPayload("story"),
          aggregateVersion: {
            kind: "v6" as const,
            revision: `0000000000000000000${storyLoads}`
          }
        };
      }
      if (method === "askAside") {
        options?.onReasoning?.({ text: "weighing", tokenCount: 2 });
        options?.onDelta?.("Because.");
        return session;
      }
      if (method === "asideSessionMutation") {
        return session;
      }
      if (method === "retakeAside") {
        options?.onReasoning?.({ text: "rechecking", tokenCount: 3 });
        options?.onDelta?.("Again.");
        return session;
      }
      throw new Error(`Unexpected worker method: ${method}`);
  };
  const api = storyApiFromWorkerTransport({ call: workerCall } as unknown as StoryWorkerTransport);

  const read = await api.getAsideV2!({ storyId: "story", anchor });
  expect(read?.sessions[0]?.id).toBe(session.id);
  const result = await api.askAsideV2!(
    { storyId: "story", question: "Why?", anchor, sessionId: session.id },
    (text) => prose.push(text),
    {
      onReasoning: (delta) => reasoning.push(`${delta.text}:${delta.tokenCount}`),
      onPhase: () => undefined
    },
    signal
  );
  expect(result?.id).toBe(session.id);
  expect(prose).toEqual(["Because."]);
  expect(reasoning).toEqual(["weighing:2"]);
  expect(calls.find((call) => call.method === "askAside")?.input).toEqual({
    storyId: "story",
    question: "Why?",
    anchor,
    sessionId: session.id
  });
  const localTurn = { storyId: "story", sessionId: session.id, turnIndex: 0, anchor } as const;
  await api.deleteAsideTurn!(localTurn);
  await api.resetAside!(localTurn);
  await api.clearAsideSession!({ storyId: "story", sessionId: session.id, anchor: null });
  const retakeProse: string[] = [];
  const retakeThoughts: string[] = [];
  await api.retakeAside!(
    { ...localTurn, anchor: null },
    (text) => retakeProse.push(text),
    { onReasoning: (delta) => retakeThoughts.push(delta.text) },
    signal
  );
  expect(retakeProse).toEqual(["Again."]);
  expect(retakeThoughts).toEqual(["rechecking"]);
  expect(calls.find((call) => call.method === "asideSessionMutation")?.input).toEqual({
    operation: "delete-turn",
    storyId: "story",
    sessionId: session.id,
    turnIndex: 0,
    anchor
  });
  expect(calls.find((call) => call.method === "retakeAside")?.input).toEqual({
    storyId: "story",
    sessionId: session.id,
    turnIndex: 0,
    anchor: null
  });
  expect(storyLoads).toBe(6);
});

test("worker Aside v2 uses embedded payloads without a post-commit reload", async () => {
  const payload = testStoryPayload("story");
  let storyLoads = 0;
  const workerCall = async (
    method: string,
    _input: unknown,
    _options?: unknown
  ): Promise<unknown> => {
    if (method === "loadStory") {
      storyLoads += 1;
      return payload;
    }
    if (method === "askAside" || method === "retakeAside") {
      return { ...session, payload };
    }
    throw new Error(`Unexpected worker method: ${method}`);
  };
  const api = storyApiFromWorkerTransport({ call: workerCall } as unknown as StoryWorkerTransport);
  const signal = new AbortController().signal;

  const asked = await api.askAsideV2!(
    { storyId: "story", question: "Why?", anchor, sessionId: session.id },
    () => {},
    undefined,
    signal
  );
  const retaken = await api.retakeAside!(
    { storyId: "story", sessionId: session.id, turnIndex: 0, anchor },
    () => {},
    undefined,
    signal
  );

  expect(asked?.payload?.id).toBe("story");
  expect(retaken?.payload?.id).toBe("story");
  expect(storyLoads).toBe(1);
});

test("shared Aside codecs preserve the legacy union and reject incomplete verbs", () => {
  const legacy = parseAsideResponse({ notes: [{ question: "Why?", answer: "Because." }] });
  expect("notes" in legacy).toBe(true);
  const parsedSession = parseAsideResponse(session);
  expect("turns" in parsedSession).toBe(true);
  expect(parseAsideAskRequestValue({ storyId: "story", question: "Why?" })).toEqual({
    storyId: "story",
    question: "Why?"
  });
  expect(() => parseAsideSessionMutationRequest({
    storyId: "story",
    operation: "delete-turn",
    sessionId: session.id,
    anchor
  })).toThrow();
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

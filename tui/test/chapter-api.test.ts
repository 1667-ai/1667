import { expect, test } from "bun:test";
import { createTestApi as createApi } from "./http-api-fixture.js";
import type { StoryNode, StoryPayload } from "../../shared/types.js";
import { AI_1667_BUILD_IDENTITY } from "../../shared/build-identity.js";

test("HTTP chapter transport covers create, rename, remove, restore, summarize, and summary edit", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const payload = emptyPayload();
  const summary = node("summary");
  const removed = {
    break: { id: "break", parentPartId: "part", title: "Two", createdAt: "2026-01-01" },
    summaries: [summary]
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/health")) {
      return Response.json({
        buildIdentity: AI_1667_BUILD_IDENTITY,
        serverInstanceId: "11111111-1111-4111-8111-111111111111",
        recoveryWarnings: []
      });
    }
    if (url.endsWith("/preview")) {
      calls.push({ url, method: init?.method ?? "GET", body: undefined });
      return Response.json({
        removedFingerprint: "f".repeat(64),
        aggregateVersion: payload.aggregateVersion
      });
    }
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ url, method: init?.method ?? "GET", body });
    const response = url.endsWith("/chapter-breaks")
      ? { payload, breakId: "break" }
      : init?.method === "DELETE" ? { payload, removed } : payload;
    return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const api = createApi("http://127.0.0.1:7373/");
    await api.loadStory("story");
    calls.length = 0;
    expect((await api.createChapterBreak("story", "part", "Two")).breakId).toBe("break");
    await api.renameChapterBreak("story", "break", "Renamed");
    expect((await api.removeChapterBreak("story", "break")).removed.break.id).toBe("break");
    await api.restoreChapterBreak("story", "break", removed);
    await api.summarizeChapter("story", "break");
    await api.editChapterSummary("story", "summary", "Edited recap", "Old recap");
  } finally {
    globalThis.fetch = original;
  }
  expect(calls.map((call) => [call.method, call.url])).toEqual([
    ["POST", "http://127.0.0.1:7373/api/stories/story/chapter-breaks"],
    ["PATCH", "http://127.0.0.1:7373/api/stories/story/chapter-breaks/break"],
    ["GET", "http://127.0.0.1:7373/api/stories/story/chapter-breaks/break/preview"],
    ["DELETE", "http://127.0.0.1:7373/api/stories/story/chapter-breaks/break"],
    ["POST", "http://127.0.0.1:7373/api/stories/story/chapter-breaks/break/restore"],
    ["POST", "http://127.0.0.1:7373/api/stories/story/chapter-breaks/break/summarize"],
    ["PATCH", "http://127.0.0.1:7373/api/stories/story/nodes/summary"]
  ]);
  expect(calls[0]?.body).toEqual({ parentPartId: "part", title: "Two" });
  expect(calls[3]?.body).toEqual({ removedFingerprint: "f".repeat(64) });
  expect(calls[4]?.body).toEqual(removed);
  expect(calls[6]?.body).toMatchObject({ text: "Edited recap" });
  expect(typeof (calls[6]?.body as { expectedTextHash?: unknown }).expectedTextHash).toBe("string");
});

function emptyPayload(): StoryPayload {
  return {
    id: "story", title: "Story", createdAt: "2026-01-01", updatedAt: "2026-01-01",
    nodes: [], path: [], activeRootId: null, bookmarks: [], recentNodeIds: [],
    facts: [], chapterBreaks: [],
    aggregateVersion: {
      kind: "v6",
      revision: "00000000000000000001"
    }
  };
}

function node(id: string): StoryNode {
  return {
    id, parentId: "part", instruction: "summarize", text: "Old recap", model: "test",
    createdAt: "2026-01-01", activeChildId: null, role: "summary", chapterBreakId: "break",
    coveredExtent: { fromPartId: "part", toPartId: "part" }, madeAt: "2026-01-01"
  };
}

/** HTTP Aside stream and Markdown export fidelity. */
import assert from "node:assert/strict";
import test from "node:test";
import { HTTP_FIDELITY_HEADER } from "../shared/http-protocol.js";
import type { StoryPayload } from "../shared/types.js";
import { ASIDE_ACTIVATED } from "../shared/aside-release.js";
import { API_PROTOCOL_HEADERS, fetchWithApiProtocol } from "./http-test-client.js";
import { json, testApp } from "./story-server-fixture.js";

const linuxTest = process.platform === "linux" ? test : test.skip;

linuxTest("HTTP Aside saves, reports Markdown omission, and clears", async (t) => {
  const base = await testApp(t, "1667-aside-http-");
  let story = await json<StoryPayload>(`${base}/api/stories`, post({
    title: "HTTP Aside"
  }));
  story = await json<StoryPayload>(`${base}/api/stories/${story.id}/nodes`, post({
    parentId: null,
    instruction: "",
    text: "A lantern burned."
  }));

  const ask = await fetchWithApiProtocol(
    `${base}/api/stories/${story.id}/aside/ask`,
    post({ question: "Why did it burn?" })
  );
  if (!ASIDE_ACTIVATED) {
    assert.equal(ask.status, 400);
    assert.equal((await ask.json() as { code?: string }).code, "aside_not_supported");
    for (const method of ["GET", "DELETE"] as const) {
      const response = await fetchWithApiProtocol(
        `${base}/api/stories/${story.id}/aside`,
        { method, headers: API_PROTOCOL_HEADERS }
      );
      assert.equal(response.status, 400);
      assert.equal(
        (await response.json() as { code?: string }).code,
        "aside_not_supported"
      );
    }
    return;
  }
  assert.equal(ask.status, 200);
  assert.match(await ask.text(), /"type":"done"/u);

  const exported = await fetchWithApiProtocol(
    `${base}/api/stories/${story.id}/export`,
    { headers: API_PROTOCOL_HEADERS }
  );
  assert.equal(exported.status, 200);
  assert.equal(
    decodeURIComponent(exported.headers.get(HTTP_FIDELITY_HEADER) ?? ""),
    JSON.stringify(["Side Notes were not exported."])
  );
  const markdown = await exported.text();
  assert.match(markdown, /A lantern burned\./u);
  assert.doesNotMatch(markdown, /Why did it burn\?/u);

  const cleared = await fetchWithApiProtocol(
    `${base}/api/stories/${story.id}/aside`,
    { method: "DELETE", headers: API_PROTOCOL_HEADERS }
  );
  assert.equal(cleared.status, 200);
  const clearedPayload = await cleared.json() as StoryPayload;
  assert.equal(clearedPayload.hasAside, undefined);
});

linuxTest("HTTP Aside v2 preserves anchor and session fields", async (t) => {
  const base = await testApp(t, "1667-aside-http-v2-");
  let story = await json<StoryPayload>(`${base}/api/stories`, post({
    title: "HTTP Aside v2"
  }));
  story = await json<StoryPayload>(`${base}/api/stories/${story.id}/nodes`, post({
    parentId: null,
    instruction: "",
    text: "A lantern burned."
  }));
  if (!ASIDE_ACTIVATED) return;
  const takeId = story.path.at(-1)?.id;
  assert.ok(takeId !== undefined);
  const anchor = { partId: takeId, takeId };

  const firstResponse = await fetchWithApiProtocol(
    `${base}/api/stories/${story.id}/aside/ask`,
    post({ question: "Why did it burn?", anchor })
  );
  assert.equal(firstResponse.status, 200);
  const firstEvent = doneEvent(await firstResponse.text());
  const firstSession = firstEvent.aside as {
    schemaVersion: number;
    id: string;
    anchor: typeof anchor;
    turns: readonly unknown[];
  };
  assert.equal(firstSession.schemaVersion, 2);
  assert.deepEqual(firstSession.anchor, anchor);
  assert.equal(firstSession.turns.length, 1);

  const readResponse = await fetchWithApiProtocol(
    `${base}/api/stories/${story.id}/aside?partId=${encodeURIComponent(anchor.partId)}&takeId=${encodeURIComponent(anchor.takeId)}`,
    { headers: API_PROTOCOL_HEADERS }
  );
  assert.equal(readResponse.status, 200);
  const read = await readResponse.json() as {
    schemaVersion: number;
    sessions: readonly { id: string; anchor: typeof anchor; turns: readonly unknown[] }[];
  };
  assert.equal(read.schemaVersion, 2);
  assert.equal(read.sessions[0]?.id, firstSession.id);
  assert.deepEqual(read.sessions[0]?.anchor, anchor);
  assert.equal(read.sessions[0]?.turns.length, 1);

  const secondResponse = await fetchWithApiProtocol(
    `${base}/api/stories/${story.id}/aside/ask`,
    post({
      question: "What did it light?",
      anchor,
      sessionId: firstSession.id
    })
  );
  assert.equal(secondResponse.status, 200);
  const secondEvent = doneEvent(await secondResponse.text());
  const secondSession = secondEvent.aside as { id: string; turns: readonly unknown[] };
  assert.equal(secondSession.id, firstSession.id);
  assert.equal(secondSession.turns.length, 2);

  const deletedResponse = await fetchWithApiProtocol(
    `${base}/api/stories/${story.id}/aside/session`,
    post({
      operation: "delete-turn",
      sessionId: firstSession.id,
      turnIndex: 0,
      anchor
    })
  );
  assert.equal(deletedResponse.status, 200);
  const deleted = await deletedResponse.json() as {
    id: string;
    anchor: typeof anchor;
    turns: readonly unknown[];
  };
  assert.equal(deleted.id, firstSession.id);
  assert.deepEqual(deleted.anchor, anchor);
  assert.equal(deleted.turns.length, 1);

  const retakeResponse = await fetchWithApiProtocol(
    `${base}/api/stories/${story.id}/aside/retake`,
    post({
      sessionId: firstSession.id,
      turnIndex: 0,
      anchor
    })
  );
  assert.equal(retakeResponse.status, 200);
  const retaken = doneEvent(await retakeResponse.text()).aside as {
    id: string;
    anchor: typeof anchor;
    turns: readonly unknown[];
  };
  assert.equal(retaken.id, firstSession.id);
  assert.deepEqual(retaken.anchor, anchor);
  assert.equal(retaken.turns.length, 1);

  const clearedResponse = await fetchWithApiProtocol(
    `${base}/api/stories/${story.id}/aside/session`,
    post({ operation: "clear", sessionId: firstSession.id, anchor })
  );
  assert.equal(clearedResponse.status, 200);
  const cleared = await clearedResponse.json() as { turns: readonly unknown[] };
  assert.equal(cleared.turns.length, 0);
});

function doneEvent(text: string): Record<string, unknown> {
  for (const block of text.split("\n\n")) {
    const line = block.split("\n").find((entry) => entry.startsWith("data:"));
    if (line === undefined) continue;
    const event = JSON.parse(line.slice("data:".length).trim()) as Record<string, unknown>;
    if (event.type === "done") return event;
  }
  throw new Error("HTTP Aside stream did not return a done event");
}

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { ...API_PROTOCOL_HEADERS, "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

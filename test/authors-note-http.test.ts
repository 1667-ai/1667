import assert from "node:assert/strict";
import test from "node:test";
import type { StoryPayload } from "../shared/types.js";
import { API_PROTOCOL_HEADERS, fetchWithApiProtocol } from "./http-test-client.js";
import { json, testApp } from "./story-server-fixture.js";

const linuxTest = process.platform === "linux" ? test : test.skip;

linuxTest("Author's Note PUT persists, is idempotent, and enforces its bound", async (t) => {
  const base = await testApp(t, "1667-authors-note-http-");
  const created = await json<StoryPayload>(`${base}/api/stories`, post({ title: "Note" }));

  const first = await json<StoryPayload>(
    `${base}/api/stories/${created.id}/authors-note`,
    put({ note: "Guide the next passage." })
  );
  assert.equal(first.authorsNote, "Guide the next passage.");

  const repeated = await json<StoryPayload>(
    `${base}/api/stories/${created.id}/authors-note`,
    put({ note: "Guide the next passage." })
  );
  assert.equal(repeated.authorsNote, first.authorsNote);
  assert.deepEqual(repeated.aggregateVersion, first.aggregateVersion);

  const replaced = await json<StoryPayload>(
    `${base}/api/stories/${created.id}/authors-note`,
    put({ note: "Replace the prior note." })
  );
  assert.equal(replaced.authorsNote, "Replace the prior note.");

  const cleared = await json<StoryPayload>(
    `${base}/api/stories/${created.id}/authors-note`,
    put({ note: " \n\t" })
  );
  assert.equal("authorsNote" in cleared, false);
  const loaded = await json<StoryPayload>(`${base}/api/stories/${created.id}`);
  assert.equal("authorsNote" in loaded, false);

  const oversized = await fetchWithApiProtocol(
    `${base}/api/stories/${created.id}/authors-note`,
    put({ note: "x".repeat(4_001) })
  );
  assert.equal(oversized.status, 400);

  const invalidUnicode = await fetchWithApiProtocol(
    `${base}/api/stories/${created.id}/authors-note`,
    put({ note: "broken \ud800" })
  );
  assert.equal(invalidUnicode.status, 400);
});

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { ...API_PROTOCOL_HEADERS, "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

function put(body: unknown): RequestInit {
  return {
    method: "PUT",
    headers: { ...API_PROTOCOL_HEADERS, "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

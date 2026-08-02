import assert from "node:assert/strict";
import test from "node:test";
import type { StoryPayload } from "../shared/types.js";
import { API_PROTOCOL_HEADERS, fetchWithApiProtocol } from "./http-test-client.js";
import { json, testApp } from "./story-server-fixture.js";

const linuxTest = process.platform === "linux" ? test : test.skip;

linuxTest("Author Brief PUT persists, is idempotent, and enforces its bound", async (t) => {
  const base = await testApp(t, "1667-author-brief-http-");
  const created = await json<StoryPayload>(`${base}/api/stories`, post({ title: "Brief" }));

  const first = await json<StoryPayload>(
    `${base}/api/stories/${created.id}/author-brief`,
    put({ brief: "Write in short, clipped sentences." })
  );
  assert.equal(first.authorBrief, "Write in short, clipped sentences.");

  const repeated = await json<StoryPayload>(
    `${base}/api/stories/${created.id}/author-brief`,
    put({ brief: "Write in short, clipped sentences." })
  );
  assert.equal(repeated.authorBrief, first.authorBrief);
  assert.deepEqual(repeated.aggregateVersion, first.aggregateVersion);

  const replaced = await json<StoryPayload>(
    `${base}/api/stories/${created.id}/author-brief`,
    put({ brief: "Replace the prior brief." })
  );
  assert.equal(replaced.authorBrief, "Replace the prior brief.");

  const cleared = await json<StoryPayload>(
    `${base}/api/stories/${created.id}/author-brief`,
    put({ brief: " \n\t" })
  );
  assert.equal("authorBrief" in cleared, false);
  const loaded = await json<StoryPayload>(`${base}/api/stories/${created.id}`);
  assert.equal("authorBrief" in loaded, false);

  const oversized = await fetchWithApiProtocol(
    `${base}/api/stories/${created.id}/author-brief`,
    put({ brief: "x".repeat(65_537) })
  );
  assert.equal(oversized.status, 400);

  const invalidUnicode = await fetchWithApiProtocol(
    `${base}/api/stories/${created.id}/author-brief`,
    put({ brief: "broken \ud800" })
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

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

  const deepened = await json<StoryPayload>(
    `${base}/api/stories/${created.id}/authors-note`,
    put({ note: "Replace the prior note.", depth: 3 })
  );
  assert.equal(deepened.authorsNoteDepth, 3);

  // An absent depth leaves the stored depth unchanged.
  const unchangedDepth = await json<StoryPayload>(
    `${base}/api/stories/${created.id}/authors-note`,
    put({ note: "Replace the prior note." })
  );
  assert.equal(unchangedDepth.authorsNoteDepth, 3);

  // The default depth is never stored.
  const backToDefault = await json<StoryPayload>(
    `${base}/api/stories/${created.id}/authors-note`,
    put({ note: "Replace the prior note.", depth: 1 })
  );
  assert.equal("authorsNoteDepth" in backToDefault, false);

  for (const depth of [0, 11, 1.5, "3"]) {
    const rejected = await fetchWithApiProtocol(
      `${base}/api/stories/${created.id}/authors-note`,
      put({ note: "Replace the prior note.", depth })
    );
    assert.equal(rejected.status, 400, `depth ${JSON.stringify(depth)}`);
  }

  // Clearing the Author's Note clears the depth with it — a depth with no
  // note means nothing.
  const withDepth = await json<StoryPayload>(
    `${base}/api/stories/${created.id}/authors-note`,
    put({ note: "One more note.", depth: 4 })
  );
  assert.equal(withDepth.authorsNoteDepth, 4);
  const cleared = await json<StoryPayload>(
    `${base}/api/stories/${created.id}/authors-note`,
    put({ note: " \n\t" })
  );
  assert.equal("authorsNote" in cleared, false);
  assert.equal("authorsNoteDepth" in cleared, false);
  const loaded = await json<StoryPayload>(`${base}/api/stories/${created.id}`);
  assert.equal("authorsNote" in loaded, false);
  assert.equal("authorsNoteDepth" in loaded, false);
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

import assert from "node:assert/strict";
import test from "node:test";
import type { StoryPayload } from "../shared/types.js";
import { API_PROTOCOL_HEADERS, fetchWithApiProtocol } from "./http-test-client.js";
import { json, testApp } from "./story-server-fixture.js";

const linuxTest = process.platform === "linux" ? test : test.skip;

// Issue #341: a story's own phraseBias and bannedStrings are independent
// mutations — the same shape as setAuthorBrief and setFactsBudget (see
// author-brief-http.test.ts) — so editing one never requires knowing the
// other's current value.
linuxTest("phrase-bias PUT persists, is idempotent, and enforces its bound", async (t) => {
  const base = await testApp(t, "1667-phrase-bias-http-");
  const created = await json<StoryPayload>(`${base}/api/stories`, post({ title: "Phrase bias" }));

  const first = await json<StoryPayload>(
    `${base}/api/stories/${created.id}/phrase-bias`,
    put({ phraseBias: [{ phrase: "delve", weight: -8 }] })
  );
  assert.deepEqual(first.phraseBias, [{ phrase: "delve", weight: -8 }]);

  const repeated = await json<StoryPayload>(
    `${base}/api/stories/${created.id}/phrase-bias`,
    put({ phraseBias: [{ phrase: "delve", weight: -8 }] })
  );
  assert.deepEqual(repeated.phraseBias, first.phraseBias);
  assert.deepEqual(repeated.aggregateVersion, first.aggregateVersion);

  const replaced = await json<StoryPayload>(
    `${base}/api/stories/${created.id}/phrase-bias`,
    put({ phraseBias: [{ phrase: "tapestry", weight: -12 }] })
  );
  assert.deepEqual(replaced.phraseBias, [{ phrase: "tapestry", weight: -12 }]);

  const cleared = await json<StoryPayload>(
    `${base}/api/stories/${created.id}/phrase-bias`,
    put({ phraseBias: [] })
  );
  assert.equal("phraseBias" in cleared, false);
  const loaded = await json<StoryPayload>(`${base}/api/stories/${created.id}`);
  assert.equal("phraseBias" in loaded, false);

  const outOfRange = await fetchWithApiProtocol(
    `${base}/api/stories/${created.id}/phrase-bias`,
    put({ phraseBias: [{ phrase: "delve", weight: 101 }] })
  );
  assert.equal(outOfRange.status, 400);

  const duplicatePhrase = await fetchWithApiProtocol(
    `${base}/api/stories/${created.id}/phrase-bias`,
    put({ phraseBias: [{ phrase: "delve", weight: 1 }, { phrase: "delve", weight: 2 }] })
  );
  assert.equal(duplicatePhrase.status, 400);
});

linuxTest("banned-strings PUT persists, is idempotent, and enforces its bound", async (t) => {
  const base = await testApp(t, "1667-banned-strings-http-");
  const created = await json<StoryPayload>(`${base}/api/stories`, post({ title: "Banned strings" }));

  const first = await json<StoryPayload>(
    `${base}/api/stories/${created.id}/banned-strings`,
    put({ bannedStrings: ["moreover"] })
  );
  assert.deepEqual(first.bannedStrings, ["moreover"]);

  const repeated = await json<StoryPayload>(
    `${base}/api/stories/${created.id}/banned-strings`,
    put({ bannedStrings: ["moreover"] })
  );
  assert.deepEqual(repeated.bannedStrings, first.bannedStrings);
  assert.deepEqual(repeated.aggregateVersion, first.aggregateVersion);

  const replaced = await json<StoryPayload>(
    `${base}/api/stories/${created.id}/banned-strings`,
    put({ bannedStrings: ["in conclusion"] })
  );
  assert.deepEqual(replaced.bannedStrings, ["in conclusion"]);

  const cleared = await json<StoryPayload>(
    `${base}/api/stories/${created.id}/banned-strings`,
    put({ bannedStrings: [] })
  );
  assert.equal("bannedStrings" in cleared, false);
  const loaded = await json<StoryPayload>(`${base}/api/stories/${created.id}`);
  assert.equal("bannedStrings" in loaded, false);

  const oversized = await fetchWithApiProtocol(
    `${base}/api/stories/${created.id}/banned-strings`,
    put({ bannedStrings: ["x".repeat(65)] })
  );
  assert.equal(oversized.status, 400);

  // Setting phraseBias does not require, or disturb, bannedStrings, and
  // vice versa — the two mutations are independent (issue #341).
  await json<StoryPayload>(
    `${base}/api/stories/${created.id}/banned-strings`,
    put({ bannedStrings: ["moreover"] })
  );
  const withPhraseBias = await json<StoryPayload>(
    `${base}/api/stories/${created.id}/phrase-bias`,
    put({ phraseBias: [{ phrase: "delve", weight: -8 }] })
  );
  assert.deepEqual(withPhraseBias.bannedStrings, ["moreover"]);
  assert.deepEqual(withPhraseBias.phraseBias, [{ phrase: "delve", weight: -8 }]);
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

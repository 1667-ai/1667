import assert from "node:assert/strict";
import test from "node:test";
import type { SearchResponse } from "../shared/story-search.js";
import { httpOperationPolicy } from "../shared/http-operation-policy.js";
import type { StoryPayload } from "../shared/types.js";
import { API_PROTOCOL_HEADERS, fetchWithApiProtocol } from "./http-test-client.js";
import { json, testApp } from "./story-server-fixture.js";

// Starting the product server is the point of these tests, and the packaged
// Linux job is where that is cheap enough to do per case.
const linuxTest = process.platform === "linux" ? test : test.skip;

test("the search route carries a policy, so the client can reserve it", () => {
  // The path is written in three places — the router, this policy table and
  // the HTTP client. A route with no policy entry throws before it is sent.
  assert.deepEqual(httpOperationPolicy("POST", "/api/stories/search"), {
    method: "searchStories",
    lifetime: "local"
  });
});

linuxTest("the search route answers over HTTP at both scopes", async (t) => {
  const base = await testApp(t, "1667-search-http-");
  const open = await seedStory(base, "The lantern keeper", [
    "Maren lit the last lamp before the storm found Sorrow Cliff.",
    "The brass compass on the bar pointed at her, not north."
  ]);
  await seedStory(base, "The salt year", [
    "A compass is a promise you can hold."
  ]);

  const tree = await search(base, { scope: "tree", storyId: open.id });
  assert.ok(tree.hits.length > 0);
  assert.equal(tree.scope, "tree");
  assert.equal(tree.storiesSearched, 1);
  assert.ok(tree.hits.every((hit) => hit.storyId === open.id));

  const vault = await search(base, { scope: "vault", storyId: open.id });
  assert.ok(vault.storiesSearched > 1);
  assert.ok(new Set(vault.hits.map((hit) => hit.storyId)).size > 1);
  // The open story is scanned first, so its hits survive the cap.
  assert.equal(vault.hits[0]?.storyId, open.id);
  assert.ok(vault.hits.some((hit) => hit.storyTitle === "The salt year"));
});

linuxTest("every search hit arrives with offsets that index its own strings", async (t) => {
  const base = await testApp(t, "1667-search-http-");
  const story = await seedStory(base, "The lantern keeper", [
    "The brass compass on the bar pointed at her, not north."
  ]);

  const response = await search(base, { scope: "tree", storyId: story.id });
  assert.ok(response.hits.length > 0);
  for (const hit of response.hits) {
    assert.equal(
      hit.snippet.slice(hit.snippetMatch, hit.snippetMatch + hit.matchLength).toLowerCase(),
      "compass"
    );
    assert.equal(
      hit.context.slice(hit.contextMatch, hit.contextMatch + hit.matchLength).toLowerCase(),
      "compass"
    );
  }
});

linuxTest("the search route refuses a request it cannot answer", async (t) => {
  const base = await testApp(t, "1667-search-http-");
  const story = await seedStory(base, "The lantern keeper", ["Maren lit the last lamp."]);
  const invalid = [
    {},
    { query: "compass", scope: "line", storyId: story.id },
    { query: "compass", scope: "tree" },
    { query: 7, scope: "tree", storyId: story.id },
    { query: "compass", scope: "tree", storyId: story.id, caseSensitive: "yes" }
  ];
  for (const body of invalid) {
    const response = await fetchWithApiProtocol(`${base}/api/stories/search`, post(body));
    assert.equal(response.status, 400, JSON.stringify(body));
  }
});

async function search(
  base: string,
  options: { scope: "tree" | "vault"; storyId: string; query?: string }
): Promise<SearchResponse> {
  return await json<SearchResponse>(`${base}/api/stories/search`, post({
    query: options.query ?? "compass",
    scope: options.scope,
    storyId: options.storyId,
    caseSensitive: false
  }));
}

async function seedStory(
  base: string,
  title: string,
  parts: readonly string[]
): Promise<StoryPayload> {
  let payload = await json<StoryPayload>(`${base}/api/stories`, post({ title }));
  for (const text of parts) {
    payload = await json<StoryPayload>(`${base}/api/stories/${payload.id}/nodes`, post({
      parentId: payload.path.at(-1)?.id ?? null,
      text
    }));
  }
  return payload;
}

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { ...API_PROTOCOL_HEADERS, "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

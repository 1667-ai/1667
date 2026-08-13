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

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { ...API_PROTOCOL_HEADERS, "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

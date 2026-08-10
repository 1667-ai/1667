import assert from "node:assert/strict";
import test from "node:test";
import type { GenerationRecordSummary } from "../shared/generation-record.js";
import type { StoryPayload } from "../shared/types.js";
import { API_PROTOCOL_HEADERS } from "./http-test-client.js";
import {
  fakeModel,
  getStory,
  json,
  modelSettings,
  post,
  providerTest,
  seededStory,
  testApp as providerTestApp
} from "./provider-http-fixture.js";

/**
 * A trailing path segment must not let a route classify on a shared prefix
 * (e.g. "rewrite" inside ".../rewrite/junk") while ignoring the segment that
 * follows it. See shared/http-operation-policy.ts and
 * server/http-router.ts for the two independent boundaries this exercises:
 * worker-method classification and direct HTTP routing.
 */

providerTest(
  "a trailing segment on a provider-backed node action or a chapter-break action is rejected before any provider call or story mutation",
  async (t) => {
    const model = await fakeModel(t, (_body, response) => {
      assert.fail("the malformed routes below must never reach the provider");
    });
    const base = await providerTestApp(t, modelSettings(model.baseUrl), "1667-http-route-exactness-");
    const story = await seededStory(base, "The red door opened.");
    const root = story.path[0]!;
    const start = root.text.indexOf("red");

    const rewriteJunk = await fetch(`${base}/api/stories/${story.id}/nodes/${root.id}/rewrite/junk`, {
      method: "POST",
      headers: { ...API_PROTOCOL_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ start, end: start + 3, instruction: "Change the color.", expected: "red" })
    });
    assert.equal(rewriteJunk.status, 404);

    const created = await json<{ payload: StoryPayload; breakId: string }>(
      `${base}/api/stories/${story.id}/chapter-breaks`,
      post({ parentPartId: root.id })
    );

    const summarizeJunk = await fetch(
      `${base}/api/stories/${story.id}/chapter-breaks/${created.breakId}/summarize/junk`,
      {
        method: "POST",
        headers: { ...API_PROTOCOL_HEADERS, "content-type": "application/json" },
        body: "{}"
      }
    );
    assert.equal(summarizeJunk.status, 404);

    assert.equal(model.requests.length, 0);
    const saved = await getStory(base, story.id);
    assert.equal(saved.path[0]!.text, "The red door opened.");
    assert.equal(saved.path[0]!.rewrittenSpans, undefined);
    assert.equal(saved.nodes.some((node) => node.chapterBreakId === created.breakId), false);
  }
);

providerTest(
  "Generation Record list and detail canonical paths still resolve once trailing segments are rejected",
  async (t) => {
    const model = await fakeModel(t, (_body, response) => {
      assert.fail("this test issues no generation request");
    });
    const base = await providerTestApp(t, modelSettings(model.baseUrl), "1667-http-route-exactness-gr-");
    const story = await seededStory(base, "A story with no takes yet.");
    const root = story.path[0]!;

    const list = await json<GenerationRecordSummary[]>(
      `${base}/api/stories/${story.id}/nodes/${root.id}/generation-records`
    );
    assert.deepEqual(list, []);

    const listWithJunk = await fetch(
      `${base}/api/stories/${story.id}/nodes/${root.id}/generation-records/${"0".repeat(64)}/junk`,
      { headers: API_PROTOCOL_HEADERS }
    );
    assert.equal(listWithJunk.status, 404);
    // Rejected by the route-shape boundary itself, before dispatch.
    assert.match(await listWithJunk.text(), /No route/);

    const detailNotFound = await fetch(
      `${base}/api/stories/${story.id}/nodes/${root.id}/generation-records/${"0".repeat(64)}`,
      { headers: API_PROTOCOL_HEADERS }
    );
    assert.equal(detailNotFound.status, 404);
    // The canonical detail shape (one trailing record-id segment, no more)
    // still reaches the service, which 404s for its own, distinguishable
    // reason — proving the boundary did not swallow the legitimate route.
    assert.match(await detailNotFound.text(), /no such Generation Record/);
    assert.equal(model.requests.length, 0);
  }
);

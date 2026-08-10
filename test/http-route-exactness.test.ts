import assert from "node:assert/strict";
import test from "node:test";
import type { GenerationRecordSummary } from "../shared/generation-record.js";
import type { StoryPayload } from "../shared/types.js";
import { API_PROTOCOL_HEADERS, fetchWithApiProtocol } from "./http-test-client.js";
import {
  doneStory,
  fakeModel,
  getStory,
  json,
  modelSettings,
  post,
  providerTest,
  seededStory,
  stream,
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
    const model = await fakeModel(t, (_body, response) => stream(response, ["A take."]));
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
    assert.equal(listWithJunk.status, 400);
    // One segment past the record id overflows the canonical path's own
    // segment-count limit. parseCanonicalApiPath rejects it before any
    // route — this one included — ever sees it, so this is not the
    // "No route" rejection a shared-prefix mismatch produces below.
    assert.match(await listWithJunk.text(), /API path must use canonical nonempty segments/);

    const detailNotFound = await fetchWithApiProtocol(
      `${base}/api/stories/${story.id}/nodes/${root.id}/generation-records/${"0".repeat(64)}`
    );
    assert.equal(detailNotFound.status, 404);
    // The canonical detail shape (one trailing record-id segment, no more)
    // still reaches the service, which 404s for its own, distinguishable
    // reason — proving the boundary did not swallow the legitimate route.
    assert.match(await detailNotFound.text(), /no such Generation Record/);

    // A real record, fetched through the same canonical detail shape,
    // resolves all the way to the service. That proves the rejections
    // above are about path shape, not about the route being gone.
    const response = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/continue`, post({
      parentId: root.id, instruction: "Continue.", genId: "route-exactness-gr"
    }));
    const returned = doneStory(await response.text());
    const generatedNode = returned.path.at(-1);
    if (generatedNode === undefined) throw new Error("continuation did not commit a take");

    const summaries = await json<GenerationRecordSummary[]>(
      `${base}/api/stories/${story.id}/nodes/${generatedNode.id}/generation-records`
    );
    assert.equal(summaries.length, 1);

    const record = await json<{ format: string; kind: string }>(
      `${base}/api/stories/${story.id}/nodes/${generatedNode.id}/generation-records/${summaries[0]!.id}`
    );
    assert.equal(record.format, "1667-generation-record");
    assert.equal(record.kind, "continue");
    assert.equal(model.requests.length, 1);
  }
);

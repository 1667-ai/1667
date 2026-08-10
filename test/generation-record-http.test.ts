import assert from "node:assert/strict";
import type { GenerationRecordSummary, ResolvedGenerationRecord } from "../shared/generation-record.js";
import { API_PROTOCOL_HEADERS, fetchWithApiProtocol } from "./http-test-client.js";
import {
  doneStory,
  fakeModel,
  json,
  modelSettings,
  post,
  providerTest,
  stream,
  testApp
} from "./provider-http-fixture.js";

/**
 * Generation Records: every model request that creates or changes a take
 * gets a durable, content-addressed record beside it (mirrors issue #291's
 * token-probability storage — see test/token-probability-storage.test.ts).
 *
 * This file covers the HTTP routes that list and read a take's records. See
 * test/generation-record-lifecycle.test.ts and
 * test/generation-record-pipeline.test.ts for the storage-layer coverage.
 */

providerTest("the HTTP routes list and read a take's Generation Records", async (t) => {
  const model = await fakeModel(t, (_body, response) => stream(response, ["Written by a model."]));
  const base = await testApp(t, modelSettings(model.baseUrl), "1667-generation-record-http-");

  const created = await json<{ id: string }>(`${base}/api/stories`, post({ title: "Story" }));
  const story = await json<{ id: string; path: { id: string }[] }>(
    `${base}/api/stories/${created.id}/nodes`,
    post({ parentId: null, instruction: "Continue.", text: "Written by a human, not a model." })
  );
  const humanNodeId = story.path.at(-1)!.id;

  const empty = await json<GenerationRecordSummary[]>(
    `${base}/api/stories/${created.id}/nodes/${humanNodeId}/generation-records`
  );
  assert.deepEqual(empty, []);

  // POST /continue always answers over SSE, success or failure alike, so the
  // take it commits has to come from the streamed "done" event, never from
  // parsing the response body as a single JSON document.
  const response = await fetchWithApiProtocol(`${base}/api/stories/${created.id}/continue`, post({
    parentId: humanNodeId, instruction: "Continue.", genId: "gen-http"
  }));
  const returned = doneStory(await response.text());
  const generatedNode = returned.path.at(-1);
  if (generatedNode === undefined) throw new Error("continuation did not commit a take");

  const summaries = await json<GenerationRecordSummary[]>(
    `${base}/api/stories/${created.id}/nodes/${generatedNode.id}/generation-records`
  );
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]!.kind, "continue");

  const record = await json<ResolvedGenerationRecord>(
    `${base}/api/stories/${created.id}/nodes/${generatedNode.id}/generation-records/${summaries[0]!.id}`
  );
  assert.equal(record.format, "1667-generation-record");
  assert.equal(record.kind, "continue");
  // The ordered pipeline: the human-written part the continuation grew from
  // arrives as a resolved source entry, in the same position the Next
  // Request preview shows it, ahead of the volatile request block — never
  // collapsed into an unordered bucket keyed only by block kind.
  const kindsInOrder = record.prompt.entries.map((entry) => entry.kind);
  const sourceIndex = kindsInOrder.indexOf("source");
  const requestIndex = kindsInOrder.indexOf("request");
  assert.ok(sourceIndex !== -1 && requestIndex !== -1 && sourceIndex < requestIndex);
  const sourceEntry = record.prompt.entries[sourceIndex];
  if (sourceEntry === undefined || sourceEntry.source !== "revisions") {
    throw new Error("expected a resolved source entry");
  }
  assert.equal(sourceEntry.parts[0]?.nodeId, humanNodeId);
  assert.equal(sourceEntry.parts[0]?.text, "Written by a human, not a model.");

  const notFound = await fetch(
    `${base}/api/stories/${created.id}/nodes/${generatedNode.id}/generation-records/${"0".repeat(64)}`,
    { headers: API_PROTOCOL_HEADERS }
  );
  assert.equal(notFound.status, 404);
});

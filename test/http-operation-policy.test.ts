import assert from "node:assert/strict";
import test from "node:test";
import { httpOperationPolicy } from "../shared/http-operation-policy.js";

test("HTTP operation policy is exact and assigns frozen lifetime classes", () => {
  assert.deepEqual(httpOperationPolicy("GET", "/api/stories"), {
    method: "listStories",
    lifetime: "local"
  });
  assert.deepEqual(
    httpOperationPolicy("POST", "/api/stories/story/continue"),
    {
      method: "continueStory",
      lifetime: "generation"
    }
  );
  assert.deepEqual(
    httpOperationPolicy("POST", "/api/settings/check-server"),
    {
      method: "checkModelServer",
      lifetime: "provider-check"
    }
  );
  assert.deepEqual(
    httpOperationPolicy("POST", "/api/settings/discover-models"),
    {
      method: "discoverModels",
      lifetime: "provider-check"
    }
  );
  assert.deepEqual(
    httpOperationPolicy("POST", "/api/settings/resolve-sampling-bias"),
    {
      // A llama-cpp route resolves against a live tokenize probe on that
      // server, so this can be a real provider round trip.
      method: "resolveSamplingBias",
      lifetime: "provider-check"
    }
  );
  assert.deepEqual(
    httpOperationPolicy("GET", "/api/stories/story/export"),
    {
      method: "exportMarkdown",
      lifetime: "transfer"
    }
  );
  assert.deepEqual(
    httpOperationPolicy("GET", "/api/stories/story/nodes/node/generation-records"),
    { method: "getGenerationRecords", lifetime: "transfer" }
  );
  assert.deepEqual(
    httpOperationPolicy("GET", `/api/stories/story/nodes/node/generation-records/${"a".repeat(64)}`),
    { method: "getGenerationRecord", lifetime: "transfer" }
  );
  assert.deepEqual(
    httpOperationPolicy("PUT", "/api/stories/story/authors-note"),
    { method: "setAuthorsNote", lifetime: "local" }
  );
  assert.deepEqual(
    httpOperationPolicy("GET", "/api/stories/story/aside"),
    { method: "getAside", lifetime: "transfer" }
  );
  assert.deepEqual(
    httpOperationPolicy("POST", "/api/stories/story/aside/ask"),
    { method: "askAside", lifetime: "generation" }
  );
  assert.deepEqual(
    httpOperationPolicy("DELETE", "/api/stories/story/aside"),
    { method: "clearAside", lifetime: "local" }
  );
  for (const [method, path] of [
    ["PUT", "/api/stories/story/tags/node/extra"],
    ["PATCH", "/api/stories/story/facts/fact/extra"],
    ["GET", "/api/stories/story/export/extra"],
    ["POST", "/api/operations/reservations"]
  ]) {
    assert.throws(
      () => httpOperationPolicy(method!, path!),
      /No HTTP operation policy/
    );
  }
});

test("HTTP operation policy rejects a trailing segment on every route except the Generation Record detail route", () => {
  // Only the Generation Record detail route consumes a segment past its
  // action, as a record id. A trailing segment on any other node or
  // chapter-break route must not classify — a prefix match on the action
  // name (e.g. "rewrite") must not paper over an ignored extra segment.
  for (const [method, path] of [
    ["POST", "/api/stories/story/nodes/node/rewrite/junk"],
    ["POST", "/api/stories/story/nodes/node/rewrite-partial/junk"],
    ["POST", "/api/stories/story/nodes/node/take-from-cut/junk"],
    ["POST", "/api/stories/story/nodes/node/paste-line/junk"],
    ["GET", "/api/stories/story/nodes/node/token-probabilities/junk"],
    ["GET", "/api/stories/story/nodes/node/reasoning/junk"],
    ["POST", "/api/stories/story/chapter-breaks/break/restore/junk"],
    ["POST", "/api/stories/story/chapter-breaks/break/summarize/junk"],
    ["GET", "/api/stories/story/chapter-breaks/break/preview/junk"],
    ["POST", "/api/stories/story/unknown-outcomes/id/ack/junk"],
    [
      "GET",
      `/api/stories/story/nodes/node/generation-records/${"a".repeat(64)}/junk`
    ]
  ]) {
    assert.throws(
      () => httpOperationPolicy(method!, path!),
      /No HTTP operation policy/,
      `${method} ${path} must not classify`
    );
  }
  // The fix must not touch the canonical shapes that do belong to these
  // routes.
  assert.deepEqual(
    httpOperationPolicy("POST", "/api/stories/story/nodes/node/rewrite"),
    { method: "rewriteNode", lifetime: "generation" }
  );
  assert.deepEqual(
    httpOperationPolicy(
      "POST",
      "/api/stories/story/chapter-breaks/break/summarize"
    ),
    { method: "summarizeChapter", lifetime: "generation" }
  );
});

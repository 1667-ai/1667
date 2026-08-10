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

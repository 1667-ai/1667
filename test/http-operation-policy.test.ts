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
    httpOperationPolicy("POST", "/api/settings/tokenize-phrase"),
    {
      // A pure local tokenization, not a provider probe (no network call),
      // so it does not need the longer provider-check budget.
      method: "tokenizeSamplingPhrase",
      lifetime: "local"
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

import assert from "node:assert/strict";
import test from "node:test";
import { MAX_FACT_TAG_CHARS, MAX_FACT_TEXT_CHARS, type StoryPayload } from "../shared/types.js";
import { API_PROTOCOL_HEADERS, fetchWithApiProtocol } from "./http-test-client.js";
import { json, testApp } from "./story-server-fixture.js";

const linuxTest = process.platform === "linux" ? test : test.skip;

// One Unicode scalar that needs two UTF-16 code units, so a scalar count and
// a code-unit count disagree on every boundary this test crosses.
const ASTRAL = "\u{1D54F}";

linuxTest("Fact text and Fact tag admission counts Unicode scalars at the HTTP boundary", async (t) => {
  const base = await testApp(t, "1667-fact-scalars-");
  const created = await json<StoryPayload>(`${base}/api/stories`, post({ title: "Scalar limits" }));

  // MAX_FACT_TEXT_CHARS astral scalars are twice as many UTF-16 code units.
  // The old code-unit measure refused this text; the scalar contract admits
  // it whole.
  const fullText = ASTRAL.repeat(MAX_FACT_TEXT_CHARS);
  const admitted = await json<StoryPayload>(
    `${base}/api/stories/${created.id}/facts`,
    post({ tag: "astral", text: fullText })
  );
  assert.equal(admitted.facts.length, 1);
  assert.equal(admitted.facts[0]!.text, fullText);

  const overText = await fetchWithApiProtocol(
    `${base}/api/stories/${created.id}/facts`,
    post({ text: ASTRAL.repeat(MAX_FACT_TEXT_CHARS + 1) })
  );
  assert.equal(overText.status, 400);

  const fullTag = ASTRAL.repeat(MAX_FACT_TAG_CHARS);
  const tagged = await json<StoryPayload>(
    `${base}/api/stories/${created.id}/facts`,
    post({ tag: fullTag, text: "the keeper trims the wick" })
  );
  assert.equal(tagged.facts.at(-1)!.tag, fullTag);

  const overTag = await fetchWithApiProtocol(
    `${base}/api/stories/${created.id}/facts`,
    post({ tag: ASTRAL.repeat(MAX_FACT_TAG_CHARS + 1), text: "the keeper trims the wick" })
  );
  assert.equal(overTag.status, 400);

  // A patch admits by the same contract as a create.
  const factId = admitted.facts[0]!.id;
  const patchedText = `${ASTRAL.repeat(MAX_FACT_TEXT_CHARS - 1)}!`;
  const patched = await json<StoryPayload>(
    `${base}/api/stories/${created.id}/facts/${factId}`,
    patchRequest({ text: patchedText })
  );
  assert.equal(patched.facts[0]!.text, patchedText);

  const overPatch = await fetchWithApiProtocol(
    `${base}/api/stories/${created.id}/facts/${factId}`,
    patchRequest({ text: ASTRAL.repeat(MAX_FACT_TEXT_CHARS + 1) })
  );
  assert.equal(overPatch.status, 400);
});

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { ...API_PROTOCOL_HEADERS, "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

function patchRequest(body: unknown): RequestInit {
  return {
    method: "PATCH",
    headers: { ...API_PROTOCOL_HEADERS, "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

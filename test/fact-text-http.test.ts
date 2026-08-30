import assert from "node:assert/strict";
import test from "node:test";
import { MAX_FACT_TAG_CHARS, MAX_FACT_TEXT_CHARS, type StoryPayload } from "../shared/types.js";
import { firstFactText } from "../shared/fact-state.js";
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
  assert.equal(firstFactText(admitted.facts[0]!), fullText);

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
  assert.equal(firstFactText(patched.facts[0]!), patchedText);

  const overPatch = await fetchWithApiProtocol(
    `${base}/api/stories/${created.id}/facts/${factId}`,
    patchRequest({ text: ASTRAL.repeat(MAX_FACT_TEXT_CHARS + 1) })
  );
  assert.equal(overPatch.status, 400);
});

linuxTest("Fact State HTTP routes preserve lifecycle and reject invalid anchors", async (t) => {
  const base = await testApp(t, "1667-fact-states-http-");
  let story = await json<StoryPayload>(`${base}/api/stories`, post({ title: "Fact States" }));
  story = await json<StoryPayload>(`${base}/api/stories/${story.id}/nodes`, post({
    parentId: null,
    text: "Root prose"
  }));
  const root = story.path.at(-1)!;

  story = await json<StoryPayload>(`${base}/api/stories/${story.id}/facts`, post({ text: "Base text" }));
  const fact = story.facts[0]!;
  const baseState = fact.states[0]!;

  story = await json<StoryPayload>(
    `${base}/api/stories/${story.id}/facts/${fact.id}/states`,
    post({ text: "Root text", anchorPartId: root.id })
  );
  const branched = story.facts.find((candidate) => candidate.id === fact.id)!;
  assert.equal(branched.states.length, 2);
  const branchState = branched.states.find((state) => state.anchorPartId === root.id)!;
  assert.equal("text" in branchState ? branchState.text : undefined, "Root text");

  const metadataOnly = await fetchWithApiProtocol(
    `${base}/api/stories/${story.id}/facts/${fact.id}/states/${baseState.id}`,
    patchRequest({ metadata: { name: "Must use Fact PATCH" } })
  );
  assert.equal(metadataOnly.status, 400);

  const duplicateAnchor = await fetchWithApiProtocol(
    `${base}/api/stories/${story.id}/facts/${fact.id}/states`,
    post({ text: "Duplicate", anchorPartId: root.id })
  );
  assert.equal(duplicateAnchor.status, 409);

  const partialSave = await fetchWithApiProtocol(
    `${base}/api/stories/${story.id}/facts/${fact.id}/states/${baseState.id}`,
    patchRequest({ anchorPartId: root.id, metadata: { name: "Must not persist" } })
  );
  assert.equal(partialSave.status, 409);
  const afterPartialSave = await json<StoryPayload>(`${base}/api/stories/${story.id}`, {
    headers: API_PROTOCOL_HEADERS
  });
  assert.equal(afterPartialSave.facts.find((candidate) => candidate.id === fact.id)!.name, undefined);

  const unknownAnchor = await fetchWithApiProtocol(
    `${base}/api/stories/${story.id}/facts/${fact.id}/states`,
    post({ text: "Unknown", anchorPartId: "missing-part" })
  );
  assert.equal(unknownAnchor.status, 400);

  story = await json<StoryPayload>(
    `${base}/api/stories/${story.id}/facts/${fact.id}/states/${branchState.id}`,
    patchRequest({ text: "Edited root text" })
  );
  let current = story.facts.find((candidate) => candidate.id === fact.id)!;
  assert.equal(firstFactText(current), "Base text");
  const editedState = current.states.find((state) => state.id === branchState.id);
  assert.equal(editedState !== undefined && "text" in editedState ? editedState.text : undefined, "Edited root text");

  story = await json<StoryPayload>(
    `${base}/api/stories/${story.id}/facts/${fact.id}/states/${branchState.id}`,
    patchRequest({ ends: true })
  );
  current = story.facts.find((candidate) => candidate.id === fact.id)!;
  const endedState = current.states.find((state) => state.id === branchState.id);
  assert.equal(endedState !== undefined && "ends" in endedState ? endedState.ends : undefined, true);

  story = await json<StoryPayload>(
    `${base}/api/stories/${story.id}/facts/${fact.id}/states/${branchState.id}`,
    patchRequest({ text: "Reopened root text" })
  );
  current = story.facts.find((candidate) => candidate.id === fact.id)!;
  const reopenedState = current.states.find((state) => state.id === branchState.id);
  assert.equal(reopenedState !== undefined && "text" in reopenedState ? reopenedState.text : undefined, "Reopened root text");

  story = await json<StoryPayload>(
    `${base}/api/stories/${story.id}/facts/${fact.id}/states/${branchState.id}`,
    { method: "DELETE", headers: API_PROTOCOL_HEADERS }
  );
  current = story.facts.find((candidate) => candidate.id === fact.id)!;
  assert.deepEqual(current.states, [baseState]);

  story = await json<StoryPayload>(
    `${base}/api/stories/${story.id}/facts/${fact.id}/states/${baseState.id}`,
    { method: "DELETE", headers: API_PROTOCOL_HEADERS }
  );
  assert.equal(story.facts.some((candidate) => candidate.id === fact.id), false);
});

linuxTest("Fact State HTTP rejects a chapter summary anchor", async (t) => {
  const base = await testApp(t, "1667-fact-summary-anchor-http-");
  let story = await json<StoryPayload>(`${base}/api/stories`, post({ title: "Summary anchor" }));
  story = await json<StoryPayload>(`${base}/api/stories/${story.id}/nodes`, post({
    parentId: null,
    text: "First prose"
  }));
  story = await json<StoryPayload>(`${base}/api/stories/${story.id}/nodes`, post({
    parentId: story.path.at(-1)!.id,
    text: "Second prose"
  }));
  const closingPart = story.path.at(-1)!;
  const chapter = await json<{ payload: StoryPayload; breakId: string }>(
    `${base}/api/stories/${story.id}/chapter-breaks`,
    post({ parentPartId: closingPart.id, title: "Closed" })
  );
  story = await json<StoryPayload>(
    `${base}/api/stories/${story.id}/chapter-breaks/${chapter.breakId}/summarize`,
    post({})
  );
  const summary = story.nodes.find((node) => node.chapterBreakId === chapter.breakId)!;
  const withFact = await json<StoryPayload>(`${base}/api/stories/${story.id}/facts`, post({ text: "Fact" }));
  const sourceFact = await json<StoryPayload>(
    `${base}/api/stories/${story.id}/facts`,
    post({ text: "Source summary fact", sourcePartId: summary.id })
  );
  assert.equal(sourceFact.facts.at(-1)!.sourcePartId, summary.id);
  const response = await fetchWithApiProtocol(
    `${base}/api/stories/${withFact.id}/facts/${withFact.facts[0]!.id}/states`,
    post({ text: "Invalid summary scope", anchorPartId: summary.id })
  );
  assert.equal(response.status, 400);
  const patchResponse = await fetchWithApiProtocol(
    `${base}/api/stories/${withFact.id}/facts/${withFact.facts[0]!.id}/states/${withFact.facts[0]!.states[0]!.id}`,
    patchRequest({ text: "Still invalid", anchorPartId: summary.id })
  );
  assert.equal(patchResponse.status, 400);
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

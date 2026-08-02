import assert from "node:assert/strict";
import test from "node:test";
import type { StoryPayload } from "../shared/types.js";
import {
  API_PROTOCOL_HEADERS,
  fetchWithApiProtocol
} from "./http-test-client.js";
import {
  doneStory,
  fakeModel,
  json,
  modelSettings,
  post,
  providerTest,
  seededStory,
  stream,
  currentDataFormatTestApp
} from "./provider-http-fixture.js";

const NOTE = "Keep the danger quiet.";

providerTest("Author's Note moves with the final story part on provider requests", async (t) => {
  let completion = 0;
  const model = await fakeModel(t, (_body, response) => {
    completion += 1;
    stream(response, [completion === 1 ? "Generated one." : "Generated two."]);
  });
  const base = await currentDataFormatTestApp(t, modelSettings(model.baseUrl), "1667-authors-note-e2e-");
  let story = await seededStory(base, "Opening passage.");
  story = await json(`${base}/api/stories/${story.id}/nodes`, post({
    parentId: story.path.at(-1)!.id,
    instruction: "Move inward.",
    text: "Second passage."
  }));
  story = await json(`${base}/api/stories/${story.id}/nodes`, post({
    parentId: story.path.at(-1)!.id,
    instruction: "Open the door.",
    text: "Third passage."
  }));
  story = await putNote(base, story.id, NOTE);

  story = await continueStory(base, story, "note-first");
  assertFoldedBetween(model.requests[0]!, "Second passage.", "Third passage.");

  story = await continueStory(base, story, "note-second");
  assertFoldedBetween(model.requests[1]!, "Third passage.", "Generated one.");
});

providerTest("Author's Note depth moves the note earlier than the final part", async (t) => {
  const model = await fakeModel(t, (_body, response) => stream(response, ["Generated one."]));
  const base = await currentDataFormatTestApp(t, modelSettings(model.baseUrl), "1667-authors-note-depth-e2e-");
  let story = await seededStory(base, "Opening passage.");
  story = await json(`${base}/api/stories/${story.id}/nodes`, post({
    parentId: story.path.at(-1)!.id,
    instruction: "Move inward.",
    text: "Second passage."
  }));
  story = await json(`${base}/api/stories/${story.id}/nodes`, post({
    parentId: story.path.at(-1)!.id,
    instruction: "Open the door.",
    text: "Third passage."
  }));
  // Depth 2 with 3 parts lands the note before the second part, not the last.
  story = await putNote(base, story.id, NOTE, 2);

  await continueStory(base, story, "note-depth");
  assertFoldedBetween(model.requests[0]!, "Opening passage.", "Second passage.");
});

providerTest("Author's Note precedes the request when a story has no parts", async (t) => {
  const model = await fakeModel(t, (_body, response) => stream(response, ["Opening passage."]));
  const base = await currentDataFormatTestApp(t, modelSettings(model.baseUrl), "1667-authors-note-empty-e2e-");
  let story = await json<StoryPayload>(`${base}/api/stories`, post({ title: "Empty" }));
  story = await putNote(base, story.id, NOTE);

  await continueStory(base, story, "note-empty");
  const messages = providerMessages(model.requests[0]!);
  assert.equal(messages.filter(({ content }) => content.includes(NOTE)).length, 1);
  assert.equal(messages.at(-1)?.role, "user");
  assert.ok(messages.at(-1)?.content.startsWith(`${NOTE}\n\n`));
});

async function putNote(base: string, storyId: string, note: string, depth?: number): Promise<StoryPayload> {
  return await json(`${base}/api/stories/${storyId}/authors-note`, {
    method: "PUT",
    headers: { ...API_PROTOCOL_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ note, ...(depth === undefined ? {} : { depth }) })
  });
}

async function continueStory(base: string, story: StoryPayload, genId: string): Promise<StoryPayload> {
  const response = await fetchWithApiProtocol(
    `${base}/api/stories/${story.id}/continue`,
    post({ parentId: story.path.at(-1)?.id ?? null, instruction: "", genId })
  );
  return doneStory(await response.text());
}

function assertFoldedBetween(
  request: Record<string, unknown>,
  previousAssistant: string,
  finalAssistant: string
): void {
  const messages = providerMessages(request);
  const noteIndexes = messages.flatMap(({ content }, index) => content.includes(NOTE) ? [index] : []);
  assert.equal(noteIndexes.length, 1);
  const noteIndex = noteIndexes[0]!;
  assert.deepEqual(messages[noteIndex - 1], { role: "assistant", content: previousAssistant });
  assert.ok(messages[noteIndex]!.content.startsWith(`${NOTE}\n\n`));
  assert.deepEqual(messages[noteIndex + 1], { role: "assistant", content: finalAssistant });
  assert.equal(messages.some(({ role, content }) => role === "system" && content.includes(NOTE)), false);
}

function providerMessages(request: Record<string, unknown>): Array<{ role: string; content: string }> {
  return request.messages as Array<{ role: string; content: string }>;
}

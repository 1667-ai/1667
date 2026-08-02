import assert from "node:assert/strict";
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

const BRIEF = "Write in short, clipped sentences. Never explain a character's feelings.";

providerTest("a story Author Brief overrides the machine-wide brief on provider requests", async (t) => {
  const model = await fakeModel(t, (_body, response) => stream(response, ["Generated prose."]));
  const base = await currentDataFormatTestApp(t, modelSettings(model.baseUrl), "1667-author-brief-e2e-");
  let story = await seededStory(base, "Opening passage.");
  story = await putBrief(base, story.id, BRIEF);

  await continueStory(base, story, "brief-first");
  const messages = providerMessages(model.requests[0]!);

  assert.equal(messages.some(({ role, content }) => role === "system" && content === BRIEF), true);
  assert.equal(
    messages.some(({ role, content }) => role === "system" && content.includes("Write coherent prose.")),
    false
  );
});

providerTest("the machine-wide author brief applies when no story brief is set", async (t) => {
  const model = await fakeModel(t, (_body, response) => stream(response, ["Generated prose."]));
  const base = await currentDataFormatTestApp(t, modelSettings(model.baseUrl), "1667-author-brief-default-e2e-");
  const story = await seededStory(base, "Opening passage.");

  await continueStory(base, story, "brief-default");
  const messages = providerMessages(model.requests[0]!);

  assert.equal(
    messages.some(({ role, content }) => role === "system" && content === "Write coherent prose."),
    true
  );
});

async function putBrief(base: string, storyId: string, brief: string): Promise<StoryPayload> {
  return await json(`${base}/api/stories/${storyId}/author-brief`, {
    method: "PUT",
    headers: { ...API_PROTOCOL_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ brief })
  });
}

async function continueStory(base: string, story: StoryPayload, genId: string): Promise<StoryPayload> {
  const response = await fetchWithApiProtocol(
    `${base}/api/stories/${story.id}/continue`,
    post({ parentId: story.path.at(-1)?.id ?? null, instruction: "", genId })
  );
  return doneStory(await response.text());
}

function providerMessages(request: Record<string, unknown>): Array<{ role: string; content: string }> {
  return request.messages as Array<{ role: string; content: string }>;
}

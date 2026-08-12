import assert from "node:assert/strict";
import test from "node:test";
import { SUMMARY_TARGET_TOKENS } from "../shared/chapters.js";
import { sha256 } from "../server/story-format.js";
import { summaryTakePrompt } from "../server/summary-take.js";
import { renderPromptPlan } from "../shared/prompt-plan.js";
import { estimateTokens } from "../shared/tokens.js";
import type { GenerationSettings, StoryNode, StoryPayload } from "../shared/types.js";
import {
  API_PROTOCOL_HEADERS,
  fetchWithApiProtocol
} from "./http-test-client.js";
import {
  fakeModel,
  providerTest,
  stream,
  testApp as providerTestApp
} from "./provider-http-fixture.js";

const testApp = (
  t: test.TestContext,
  settings: GenerationSettings
) => providerTestApp(t, settings, "1667-summary-take-");

providerTest("summary take: offset source lands beneath a cut sibling, preserves the old continuation, and blocks append", async (t) => {
  const model = await fakeModel(t, (body, response) => {
    const prompt = promptFrom(body);
    assert.match(prompt, /Keep this\./);
    assert.doesNotMatch(prompt, /Drop that\./);
    const marker = markerFrom(prompt);
    stream(response, [`Detailed continuity recap.\n${marker}`]);
  });
  const base = await testApp(t, summarySettings(model.baseUrl, 4096, 512));
  let story = await seededStory(base, "Keep this. Drop that.");
  const root = story.path[0]!;
  story = await json(`${base}/api/stories/${story.id}/nodes`, post({ parentId: root.id, text: "Old continuation." }));
  const oldChild = story.path[1]!;
  const offset = "Keep this.".length;
  const response = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/summary-take`, post({
    nodeId: root.id, offset, expected: "Keep this."
  }));
  const events = await response.text();
  assert.match(events, /"type":"done","nodeId":/);
  const summaryId = doneNodeId(events);
  let saved = await getStory(base, story.id);
  assert.equal(saved.nodes.some((node) => node.id === oldChild.id), true);
  assert.equal(saved.nodes.filter((node) => node.parentId === root.id).length, 1);
  const summaryStub = saved.nodes.find((node) => node.id === summaryId)!;
  const cut = saved.nodes.find((node) => node.id === summaryStub.parentId)!;
  assert.equal(cut.parentId, null);
  assert.equal(cut.preview, "Keep this.");
  assert.equal(saved.nodes.filter((node) => node.parentId === null).length, 2);
  assert.equal(saved.path[1]!.id, oldChild.id, "the server publishes the summary without stealing the active line");
  saved = await json(`${base}/api/stories/${story.id}/switch`, post({ nodeId: summaryId }));
  assert.equal(saved.path[0]!.text, "Keep this.");
  assert.doesNotMatch(saved.path.map((node) => node.text).join(" "), /Drop that/);
  const summary = saved.path[1]!;
  assert.equal(summary.role, "summary");
  assert.equal(summary.text, "Detailed continuity recap.");
  const append = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/continue`, post({
    appendTo: summary.id, expectedTextHash: sha256(summary.text), instruction: "", genId: "bad-summary-append"
  }));
  assert.equal(append.status, 400);
});

providerTest("summary take: completion does not steal a line extended while streaming", async (t) => {
  let base = "";
  let storyId = "";
  let rootId = "";
  let continuationId = "";
  const model = await fakeModel(t, async (body, response) => {
    const continued = await json<StoryPayload>(`${base}/api/stories/${storyId}/nodes`, post({
      parentId: rootId,
      text: "Written while the recap streamed."
    }));
    continuationId = continued.path.at(-1)!.id;
    stream(response, [`Concurrent recap.\n${markerFrom(promptFrom(body))}`]);
  });
  base = await testApp(t, summarySettings(model.baseUrl, 4096, 512));
  const story = await seededStory(base, "Source before the concurrent continuation.");
  storyId = story.id;
  rootId = story.path[0]!.id;

  const response = await fetchWithApiProtocol(`${base}/api/stories/${storyId}/summary-take`, post({ nodeId: rootId }));
  const summaryId = doneNodeId(await response.text());
  const saved = await getStory(base, storyId);
  assert.equal(saved.path.at(-1)!.id, continuationId);
  assert.equal(saved.nodes.find((node) => node.id === summaryId)?.role, "summary");
  assert.equal(saved.nodes.find((node) => node.id === summaryId)?.parentId, rootId);
});

providerTest("summary take: a later recap starts at the latest summary context reset", async (t) => {
  const prompts: string[] = [];
  const model = await fakeModel(t, (body, response) => {
    const prompt = promptFrom(body);
    prompts.push(prompt);
    stream(response, [`${prompts.length === 1 ? "First recap." : "Second recap."}\n${markerFrom(prompt)}`]);
  });
  const base = await testApp(t, summarySettings(model.baseUrl, 4096, 512));
  const story = await seededStory(base, "Ancient source that the first recap replaces.");

  const firstResponse = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/summary-take`, post({ nodeId: story.path[0]!.id }));
  const firstSummaryId = doneNodeId(await firstResponse.text());
  let current = await json<StoryPayload>(`${base}/api/stories/${story.id}/switch`, post({ nodeId: firstSummaryId }));
  current = await json(`${base}/api/stories/${story.id}/nodes`, post({
    parentId: current.path.at(-1)!.id,
    text: "Events after the first recap."
  }));

  const secondResponse = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/summary-take`, post({
    nodeId: current.path.at(-1)!.id
  }));
  assert.match(await secondResponse.text(), /"type":"done"/);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /First recap\./);
  assert.match(prompts[1]!, /Events after the first recap\./);
  assert.doesNotMatch(prompts[1]!, /Ancient source/);
});

providerTest("summary take: store-side fingerprint rejects source drift under the lock", async (t) => {
  let base = "";
  let storyId = "";
  let nodeId = "";
  let originalText = "";
  const model = await fakeModel(t, async (body, response) => {
    await json(`${base}/api/stories/${storyId}/nodes/${nodeId}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Changed during summary.", expectedTextHash: sha256(originalText) })
    });
    stream(response, [`Recap.\n${markerFrom(promptFrom(body))}`]);
  });
  base = await testApp(t, summarySettings(model.baseUrl, 4096, 512));
  const story = await seededStory(base, "Original source.");
  storyId = story.id;
  nodeId = story.path[0]!.id;
  originalText = story.path[0]!.text;
  const response = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/summary-take`, post({ nodeId }));
  assert.match(await response.text(), /"type":"error"[\s\S]*story changed/i);
  const saved = await getStory(base, story.id);
  assert.equal(saved.nodes.some((node) => node.role === "summary"), false);
});

providerTest("summary take: missing completion marker saves nothing", async (t) => {
  const model = await fakeModel(t, (_body, response) => stream(response, ["Unconfirmed recap."]));
  const base = await testApp(t, summarySettings(model.baseUrl, 4096, 512));
  const story = await seededStory(base, "Source.");
  const response = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/summary-take`, post({ nodeId: story.path[0]!.id }));
  assert.match(await response.text(), /"type":"error"/);
  assert.equal((await getStory(base, story.id)).nodes.length, 1);
});

providerTest("summary take: output budget shrinks to window room", async (t) => {
  const model = await fakeModel(t, (body, response) => stream(response, [`Recap.\n${markerFrom(promptFrom(body))}`]));
  const base = await testApp(t, summarySettings(model.baseUrl, 1600, 1024));
  const story = await seededStory(base, "source words ".repeat(120));
  const response = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/summary-take`, post({ nodeId: story.path[0]!.id }));
  assert.match(await response.text(), /"type":"done"/);
  assert.ok((model.requests[0]!.max_tokens as number) < 1024);
});

// The compact chapter target sizes what the prompt asks for. It is not the
// ceiling. Holding the two at one number cut every chapter summary off at
// exactly its target, so the completion marker never arrived and the result
// was refused: the writer saw "increase Max output tokens" for a cap that no
// setting could move.
providerTest("chapter summary asks for the compact target but caps at the profile", async (t) => {
  const model = await fakeModel(t, (body, response) =>
    stream(response, [`Compact recap.\n${markerFrom(promptFrom(body))}`]));
  const base = await testApp(t, summarySettings(model.baseUrl, 4096, 1024));
  const story = await seededStory(base, "A closed chapter ready for its compact recap.");
  const created = await json<{ payload: StoryPayload; breakId: string }>(
    `${base}/api/stories/${story.id}/chapter-breaks`,
    post({ parentPartId: story.path[0]!.id })
  );

  await json(`${base}/api/stories/${story.id}/chapter-breaks/${created.breakId}/summarize`, post({}));

  const request = model.requests[0]!;
  // Room above the target, so the last sentence and the marker both fit.
  assert.equal(request.max_tokens, 1024);
  assert.ok((request.max_tokens as number) > SUMMARY_TARGET_TOKENS);
  // The prompt still asks for a compact recap, which is what the context
  // projection assumes a chapter summary occupies.
  const asked = Math.floor(SUMMARY_TARGET_TOKENS * 0.68).toLocaleString("en-US");
  assert.match(promptFrom(request), new RegExp(`aim for up to ${asked} words`));
});

providerTest("chapter summary rejects an instruction-only source edit", async (t) => {
  let base = "";
  let storyId = "";
  let sourceId = "";
  let sourceText = "";
  const model = await fakeModel(t, async (body, response) => {
    await json(`${base}/api/stories/${storyId}/nodes/${sourceId}`, {
      method: "PATCH",
      headers: {
        ...API_PROTOCOL_HEADERS,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        instruction: "Writer changed the chapter source.",
        expectedTextHash: sha256(sourceText)
      })
    });
    stream(response, [`Stale recap.\n${markerFrom(promptFrom(body))}`]);
  });
  base = await testApp(t, summarySettings(model.baseUrl, 4096, 512));
  const story = await seededStory(base, "Chapter source.");
  storyId = story.id;
  sourceId = story.path[0]!.id;
  sourceText = story.path[0]!.text;
  const created = await json<{ payload: StoryPayload; breakId: string }>(
    `${base}/api/stories/${story.id}/chapter-breaks`,
    post({ parentPartId: sourceId })
  );

  const response = await fetchWithApiProtocol(
    `${base}/api/stories/${story.id}/chapter-breaks/${created.breakId}/summarize`,
    post({})
  );
  assert.equal(response.status, 409);
  assert.match(await response.text(), /chapter changed while its summary/i);
  const saved = await getStory(base, story.id);
  assert.equal(
    saved.path[0]?.instruction,
    "Writer changed the chapter source."
  );
  assert.equal(
    saved.nodes.some((node) => node.chapterBreakId === created.breakId),
    false
  );
});

providerTest("summary take: an unset creative temperature still uses the continuity-safe cap", async (t) => {
  const model = await fakeModel(t, (body, response) => stream(response, [`Recap.\n${markerFrom(promptFrom(body))}`]));
  const base = await testApp(t, summarySettings(model.baseUrl, 4096, 512, null));
  const story = await seededStory(base, "Source.");
  const response = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/summary-take`, post({ nodeId: story.path[0]!.id }));
  assert.match(await response.text(), /"type":"done"/);
  assert.equal(model.requests[0]!.temperature, 0.2);
});

providerTest("summary take: when even the earliest single part does not fit, the refusal names an action and nothing is committed", async (t) => {
  const model = await fakeModel(t, (_body, response) => stream(response, ["unused"]));
  const base = await testApp(t, summarySettings(model.baseUrl, 100, 64));
  const story = await seededStory(base, "A long enough source prefix to consume the tiny window.".repeat(20));
  const response = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/summary-take`, post({ nodeId: story.path[0]!.id }));
  assert.equal(response.status, 422);
  const message = await response.text();
  assert.match(message, /No point in this story leaves room for a summary/);
  assert.match(message, /Settings/);
  assert.equal(model.requests.length, 0);
  assert.equal((await getStory(base, story.id)).nodes.length, 1);
});

providerTest("summary take: a prefix that already fits is summarized at the requested point and reports no narrowing", async (t) => {
  const model = await fakeModel(t, (body, response) => stream(response, [`Recap.\n${markerFrom(promptFrom(body))}`]));
  const base = await testApp(t, summarySettings(model.baseUrl, 4096, 512));
  const story = await seededStory(base, "A short source that fits easily inside the window.");
  const response = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/summary-take`, post({ nodeId: story.path[0]!.id }));
  const events = await response.text();
  assert.match(events, /"type":"done"/);
  assert.match(events, /"narrowedTo":null/);
  const summaryId = doneNodeId(events);
  const saved = await getStory(base, story.id);
  assert.equal(saved.nodes.find((node) => node.id === summaryId)?.parentId, story.path[0]!.id);
});

providerTest("summary take: a prefix too big for the window is summarized at the latest point that fits, and reports it", async (t) => {
  // Four parts, each big enough that the token gap between including three
  // and including four dwarfs the fixed prompt overhead (system prompt,
  // instructions, completion marker). Computed from the real prompt
  // builder, not estimated, so this fixture cannot drift from what the
  // server itself measures (issue #139).
  const title = "Summary";
  const texts = ["PART-ONE", "PART-TWO", "PART-THREE", "PART-FOUR"]
    .map((label) => `${label} ${"word ".repeat(500)}`.trim());
  const inputTokensFor = (count: number): number => {
    const parts = texts.slice(0, count).map((text) => ({ text })) as unknown as readonly StoryNode[];
    const prompt = summaryTakePrompt(title, parts, 50, "00000000");
    return renderPromptPlan(prompt).reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0);
  };
  const input3 = inputTokensFor(3);
  const input4 = inputTokensFor(4);
  assert.ok(input4 - input3 > 100, "fixture needs a clear per-part token gap");
  const maxTokens = 50;
  const contextWindow = Math.ceil((input3 + maxTokens + 20) / 0.9);
  assert.ok(
    Math.floor(contextWindow * 0.9) - input4 < maxTokens,
    "fixture must not also leave room for all four parts"
  );

  const model = await fakeModel(t, (body, response) => stream(response, [`Recap.\n${markerFrom(promptFrom(body))}`]));
  const base = await testApp(t, summarySettings(model.baseUrl, contextWindow, maxTokens));
  const created = await json<StoryPayload>(`${base}/api/stories`, post({ title }));
  let story = await json<StoryPayload>(`${base}/api/stories/${created.id}/nodes`, post({ parentId: null, text: texts[0]! }));
  for (const text of texts.slice(1)) {
    story = await json(`${base}/api/stories/${story.id}/nodes`, post({ parentId: story.path.at(-1)!.id, text }));
  }
  const part3Id = story.path[2]!.id;

  const response = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/summary-take`, post({ nodeId: story.path.at(-1)!.id }));
  const events = await response.text();
  assert.match(events, /"type":"done"/);
  // The latest point that fits is part three's — parts one and two also fit
  // on their own (they are strictly smaller), so this pins down "latest",
  // not merely "an earlier point that works".
  assert.match(events, new RegExp(`"narrowedTo":\\{"nodeId":"${part3Id}","offset":null\\}`));
  assert.match(promptFrom(model.requests[0]!), /PART-THREE/);
  assert.doesNotMatch(promptFrom(model.requests[0]!), /PART-FOUR/);

  const summaryId = doneNodeId(events);
  const saved = await getStory(base, story.id);
  const summaryNode = saved.nodes.find((node) => node.id === summaryId)!;
  assert.equal(summaryNode.role, "summary");
  // The committed take's own point matches what was actually summarized,
  // not the point the request named.
  assert.equal(summaryNode.parentId, part3Id);
});

function promptFrom(body: Record<string, unknown>): string {
  return (body.messages as Array<{ role: string; content: string }>).findLast((message) => message.role === "user")!.content;
}

function markerFrom(prompt: string): string {
  const marker = /\[\[summary-complete-[a-f0-9]+\]\]/.exec(prompt)?.[0];
  assert.ok(marker);
  return marker;
}

function doneNodeId(events: string): string {
  const nodeId = /"type":"done","nodeId":"([^"]+)"/.exec(events)?.[1];
  assert.ok(nodeId, `missing summary node id in ${events}`);
  return nodeId;
}

async function seededStory(base: string, text: string): Promise<StoryPayload> {
  const created = await json<StoryPayload>(`${base}/api/stories`, post({ title: "Summary" }));
  return await json(`${base}/api/stories/${created.id}/nodes`, post({ parentId: null, instruction: "Begin.", text }));
}

function summarySettings(
  modelBaseUrl: string,
  contextWindow: number,
  maxTokens: number,
  temperature: number | null = 0.5
): GenerationSettings {
  return {
    provider: "openai-compatible", baseUrl: modelBaseUrl, model: "summary-model", apiKeyEnv: null,
    temperature, maxTokens, systemPrompt: "Write.", contextWindow
  };
}

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { ...API_PROTOCOL_HEADERS, "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}


async function getStory(base: string, id: string): Promise<StoryPayload> {
  return await json(`${base}/api/stories/${id}`);
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithApiProtocol(url, init);
  if (!response.ok) assert.fail(`${response.status} ${await response.text()}`);
  return await response.json() as T;
}

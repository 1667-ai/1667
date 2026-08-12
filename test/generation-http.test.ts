import assert from "node:assert/strict";
import test from "node:test";
import {
  ABSENT_SETTINGS_V1,
} from "../server/settings-v1-codec.js";
import { rewriteNode } from "../server/generation-http.js";
import { GenerationResultError } from "../server/errors.js";
import { PromptCacheRuntime, LEGACY_PROMPT_CACHE_CONTEXT } from "../server/provider-cache-policy.js";
import { attachProviderRuntime } from "../server/provider-runtime.js";
import type { ProviderStoryRuntime } from "../server/story-mutation-runtime.js";
import type { SettingsStore } from "../server/settings.js";
import { sha256 } from "../server/story-format.js";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
import type { GenerationSettings, Story, StoryPayload } from "../shared/types.js";
import {
  API_PROTOCOL_HEADERS,
  fetchWithApiProtocol
} from "./http-test-client.js";
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

const testApp = (
  t: test.TestContext,
  settings: GenerationSettings
) => providerTestApp(t, settings, "1667-generation-http-");

const linuxTest = process.platform === "linux" ? test : test.skip;

linuxTest("HTTP API binds mutations to the preflighted server instance before dispatch", async (t) => {
  const base = await testApp(t, ABSENT_SETTINGS_V1);
  assert.equal((await fetch(`${base}/api/stories`)).status, 400);
  assert.equal((await fetch(`${base}/api/stories`, {
    headers: { ...API_PROTOCOL_HEADERS, "x-1667-client-protocol": "999" }
  })).status, 409);
  assert.equal((await fetch(`${base}/api/stories`, {
    method: "POST",
    headers: { "x-1667-client-protocol": API_PROTOCOL_HEADERS["x-1667-client-protocol"]! }
  })).status, 409);
  assert.equal((await fetch(`${base}/api/stories`, {
    method: "POST",
    headers: { ...API_PROTOCOL_HEADERS, "x-1667-server-instance": "replacement" }
  })).status, 409);
  assert.deepEqual(await json(`${base}/api/stories`), []);
});

providerTest("generation HTTP: append keeps provider wire context and commits in place", async (t) => {
  const model = await fakeModel(t, (_body, response) => stream(response, ["cked."]));
  const base = await testApp(t, modelSettings(model.baseUrl));
  const story = await seededStory(base, "The latch was unlo");
  const root = story.path[0]!;
  const response = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/continue`, post({
    appendTo: root.id, expectedTextHash: sha256(root.text), instruction: "", genId: "append-wire"
  }));
  const events = await response.text();
  const returned = doneStory(events);
  const messages = model.requests[0]!.messages as Array<{ role: string; content: string }>;
  assert.deepEqual(messages.at(-1), { role: "assistant", content: "The latch was unlo" });
  assert.equal(model.requests[0]!.model, "test-model");
  const saved = await getStory(base, story.id);
  assert.deepEqual(returned, saved);
  assert.equal(saved.path[0]!.id, root.id);
  assert.equal(saved.path[0]!.text, "The latch was unlocked.");
  assert.equal(saved.nodes.length, 1);
});

providerTest("generation HTTP: continuation selects keyed Facts from the exact context and instruction", async (t) => {
  const model = await fakeModel(t, (_body, response) => stream(response, [" The green door opened."]));
  const base = await testApp(t, modelSettings(model.baseUrl));
  let story = await seededStory(base, "A narrow hall waited.");
  story = await json(`${base}/api/stories/${story.id}/facts`, post({
    text: "The green-door fact.", activation: "keyed", keys: ["green door"]
  }));
  await json(`${base}/api/stories/${story.id}/facts`, post({
    text: "The moon fact.", activation: "keyed", keys: ["moon"]
  }));

  const response = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/continue`, post({
    parentId: story.path[0]!.id,
    instruction: "Mention the green door.",
    genId: "fact-selection-continuation"
  }));
  assert.match(await response.text(), /"type":"done"/);
  const facts = factMessage(model.requests[0]!);
  assert.match(facts, /The green-door fact\./);
  assert.doesNotMatch(facts, /The moon fact\./);
});

providerTest("generation HTTP: append at a summarized chapter break creates a child from summary context", async (t) => {
  const model = await fakeModel(t, (body, response) => {
    const prompt = JSON.stringify(body.messages);
    const marker = /\[\[summary-complete-[a-f0-9]+\]\]/.exec(prompt)?.[0];
    stream(response, [marker === undefined ? "A new chapter opened." : `Closed chapter summary.\n${marker}`]);
  });
  const base = await testApp(t, modelSettings(model.baseUrl));
  let story = await seededStory(base, "The first chapter ended.");
  const leaf = story.path[0]!;
  const created = await json<{ payload: StoryPayload; breakId: string }>(
    `${base}/api/stories/${story.id}/chapter-breaks`,
    post({ parentPartId: leaf.id })
  );
  story = await json(
    `${base}/api/stories/${story.id}/chapter-breaks/${created.breakId}/summarize`,
    post({})
  );
  const summary = story.nodes.find((node) => node.chapterBreakId === created.breakId)!;

  const response = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/continue`, post({
    appendTo: leaf.id, instruction: "", genId: "chapter-child"
  }));
  assert.match(await response.text(), /"type":"done"/);

  const saved = await getStory(base, story.id);
  assert.equal(saved.path[0]!.text, leaf.text, "the closed chapter leaf stays unchanged");
  assert.equal(saved.path[1]!.parentId, leaf.id);
  assert.equal(saved.path[1]!.text, "A new chapter opened.");
  const messages = model.requests[1]!.messages as Array<{ role: string; content: string }>;
  assert.deepEqual(messages.at(-2), { role: "assistant", content: summary.text });
  assert.deepEqual(messages.at(-1), { role: "user", content: "Continue the story." });
});

providerTest("generation HTTP: a take under a parent preserves the old child as a sibling", async (t) => {
  const model = await fakeModel(t, (_body, response) => stream(response, ["A different turn."]));
  const base = await testApp(t, modelSettings(model.baseUrl));
  let story = await seededStory(base, "Opening.");
  const root = story.path[0]!;
  story = await json(`${base}/api/stories/${story.id}/nodes`, post({ parentId: root.id, text: "Old continuation." }));
  const oldChild = story.path[1]!;
  const response = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/continue`, post({
    parentId: root.id, instruction: "Turn elsewhere.", genId: "new-take"
  }));
  assert.match(await response.text(), /"type":"done"/);
  const saved = await getStory(base, story.id);
  assert.equal(saved.nodes.filter((node) => node.parentId === root.id).length, 2);
  assert.equal(saved.nodes.some((node) => node.id === oldChild.id), true);
  assert.equal(saved.path[1]!.genId, "new-take");
  assert.equal(saved.path[1]!.text, "A different turn.");
  const messages = model.requests[0]!.messages as Array<{ role: string; content: string }>;
  assert.deepEqual(messages.slice(-2), [
    { role: "assistant", content: "Opening." },
    { role: "user", content: "Turn elsewhere." }
  ]);
});

providerTest("generation HTTP: a committed genId returns before target validation or provider work", async (t) => {
  const model = await fakeModel(t, (_body, response) => stream(response, ["First result."]));
  const base = await testApp(t, modelSettings(model.baseUrl));
  const story = await seededStory(base, "Opening.");
  const genId = "committed-before-provider";
  const first = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/continue`, post({
    parentId: story.path[0]!.id,
    instruction: "Continue.",
    genId
  }));
  assert.match(await first.text(), /"type":"done"/);
  assert.equal(model.requests.length, 1);

  const duplicate = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/continue`, post({
    parentId: "a-target-that-does-not-exist",
    instruction: "Changed retry input.",
    genId
  }));
  assert.equal(duplicate.status, 200);
  assert.match(await duplicate.text(), /"type":"done"/);
  assert.equal(model.requests.length, 1);
});

providerTest("generation HTTP: an in-flight story/gen duplicate is rejected before a second provider call", async (t) => {
  let release!: () => void;
  let markRequested!: () => void;
  const requested = new Promise<void>((resolve) => { markRequested = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  const model = await fakeModel(t, async (_body, response) => {
    markRequested();
    await gate;
    stream(response, ["Only once."]);
  });
  const base = await testApp(t, modelSettings(model.baseUrl));
  const story = await seededStory(base, "Opening.");
  const request = {
    parentId: story.path[0]!.id,
    instruction: "Continue.",
    genId: "one-in-flight-provider"
  };
  const firstPending = fetchWithApiProtocol(
    `${base}/api/stories/${story.id}/continue`,
    post(request)
  );
  await requested;

  const duplicate = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/continue`, post(request));
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), {
    error: "This generation is already in progress; retry after it settles.",
    code: "resource_busy"
  });
  assert.equal(model.requests.length, 1);

  release();
  const first = await firstPending;
  assert.match(await first.text(), /"type":"done"/);
  assert.equal(model.requests.length, 1);
});

providerTest("generation HTTP: provider failure permits a reviewed retry", async (t) => {
  let attempt = 0;
  const model = await fakeModel(t, (_body, response) => {
    attempt += 1;
    if (attempt === 1) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end('{"error":"temporary"}');
      return;
    }
    stream(response, ["Recovered."]);
  });
  const base = await testApp(t, modelSettings(model.baseUrl));
  const story = await seededStory(base, "Opening.");
  const request = {
    parentId: story.path[0]!.id,
    instruction: "Continue.",
    genId: "retry-after-provider-failure"
  };

  const failed = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/continue`, post(request));
  assert.equal(failed.status, 502);
  const failedBody = await failed.json() as { error: string; code: string };
  assert.equal(failedBody.code, "provider_failure");

  const retried = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/continue`, post(request));
  assert.equal(retried.status, 200);
  assert.match(await retried.text(), /"type":"done"/);
  assert.equal(model.requests.length, 2);
  assert.equal((await getStory(base, story.id)).nodes.length, 2);
});

providerTest("generation HTTP: a dropped model stream permits a reviewed retry", async (t) => {
  let attempt = 0;
  const model = await fakeModel(t, (_body, response) => {
    attempt += 1;
    if (attempt === 1) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "Partial" }, finish_reason: null }]
        })}\n\n`
      );
      response.socket?.destroy();
      return;
    }
    stream(response, ["Recovered."]);
  });
  const base = await testApp(t, modelSettings(model.baseUrl));
  const story = await seededStory(base, "Opening.");
  const request = {
    parentId: story.path[0]!.id,
    instruction: "Continue.",
    genId: "retry-after-dropped-stream"
  };

  const failed = await fetchWithApiProtocol(
    `${base}/api/stories/${story.id}/continue`,
    post(request)
  );
  assert.equal(failed.status, 502);
  assert.equal(
    (await failed.json() as { code: string }).code,
    "provider_failure"
  );
  assert.equal((await getStory(base, story.id)).nodes.length, 1);

  const retried = await fetchWithApiProtocol(
    `${base}/api/stories/${story.id}/continue`,
    post(request)
  );
  assert.equal(retried.status, 200);
  assert.match(await retried.text(), /"type":"done"/);
  assert.equal(model.requests.length, 2);
  assert.equal((await getStory(base, story.id)).nodes.length, 2);
});

providerTest("generation HTTP: deleting the requested parent during streaming yields an error event", async (t) => {
  let release!: () => void;
  let requested!: () => void;
  const seen = new Promise<void>((resolve) => { requested = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  const model = await fakeModel(t, async (_body, response) => {
    requested();
    await gate;
    stream(response, ["Too late."]);
  });
  const base = await testApp(t, modelSettings(model.baseUrl));
  const story = await seededStory(base, "Opening.");
  const root = story.path[0]!;
  const pending = fetchWithApiProtocol(`${base}/api/stories/${story.id}/continue`, post({
    parentId: root.id, instruction: "Continue.", genId: "deleted-parent"
  }));
  await seen;
  await json(`${base}/api/stories/${story.id}/nodes/${root.id}`, {
    method: "DELETE",
    headers: { ...API_PROTOCOL_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ expectedSubtreeCount: 1 })
  });
  release();
  const response = await pending;
  assert.match(await response.text(), /"type":"error"[\s\S]*parent node was deleted/i);
  assert.deepEqual((await getStory(base, story.id)).nodes, []);
});

providerTest("generation HTTP: aborting a continuation does not commit a full take", async (t) => {
  let release!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const model = await fakeModel(t, async (_body, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Partial" }, finish_reason: null }] })}\n\n`);
    markStarted();
    await gate;
    if (!response.destroyed) response.end("data: [DONE]\n\n");
  });
  const base = await testApp(t, modelSettings(model.baseUrl));
  const story = await seededStory(base, "Opening.");
  const controller = new AbortController();
  const pending = fetchWithApiProtocol(`${base}/api/stories/${story.id}/continue`, {
    ...post({ parentId: story.path[0]!.id, instruction: "Continue.", genId: "abort-mid-stream" }),
    signal: controller.signal
  }).then((response) => response.text());
  await started;
  controller.abort();
  await pending.catch(() => undefined);
  release();

  const saved = await getStory(base, story.id);
  assert.equal(saved.nodes.length, 1);
  assert.equal(saved.path.some((node) => node.genId === "abort-mid-stream"), false);
});

providerTest("generation HTTP: rewrite replaces in place by default, adds no node, and records a rewritten span", async (t) => {
  const model = await fakeModel(t, (body, response) => {
    const messages = body.messages as Array<{ content: string }>;
    assert.match(messages.at(-1)!.content, /<rw-[a-f0-9]+-excerpt>/);
    stream(response, ["blue"]);
  });
  const base = await testApp(t, modelSettings(model.baseUrl));
  let story = await seededStory(base, "The red door opened.");
  const root = story.path[0]!;
  story = await json(`${base}/api/stories/${story.id}/nodes`, post({ parentId: root.id, text: "Dawn followed." }));
  const start = root.text.indexOf("red");
  const response = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/nodes/${root.id}/rewrite`, post({
    start, end: start + 3, instruction: "Change the color.", expected: "red"
    // destination absent: in-place is the default.
  }));
  const events = await response.text();
  assert.match(events, /"type":"done"/);
  const nodeId = /"type":"done","nodeId":"([^"]+)"/.exec(events)?.[1];
  // The operation answers the target's own id, not a new take's.
  assert.equal(nodeId, root.id);

  const saved = await getStory(base, story.id);
  // No sibling take: the story keeps exactly the two nodes it started with,
  // and the child written under the source stays on the active line — the
  // whole point of replacing in place instead of forking.
  assert.equal(saved.nodes.length, 2);
  assert.equal(saved.path.length, 2);
  assert.equal(saved.path[0]!.id, root.id);
  assert.equal(saved.path[0]!.text, "The blue door opened.");
  assert.equal(saved.path[1]!.text, "Dawn followed.");
  // An in-place splice touches updatedAt — unlike a freshly created take.
  assert.ok(saved.path[0]!.updatedAt);
  // The replacement itself is recorded as a rewritten span.
  const replacedAt = saved.path[0]!.text.indexOf("blue");
  assert.deepEqual(saved.path[0]!.rewrittenSpans, [{ start: replacedAt, end: replacedAt + "blue".length }]);
});

providerTest("generation HTTP: rewrite opts into a new take and keeps the source reachable as a sibling", async (t) => {
  const model = await fakeModel(t, (body, response) => {
    const messages = body.messages as Array<{ content: string }>;
    assert.match(messages.at(-1)!.content, /<rw-[a-f0-9]+-excerpt>/);
    stream(response, ["blue"]);
  });
  const base = await testApp(t, modelSettings(model.baseUrl));
  let story = await seededStory(base, "The red door opened.");
  const root = story.path[0]!;
  story = await json(`${base}/api/stories/${story.id}/nodes`, post({ parentId: root.id, text: "Dawn followed." }));
  const start = root.text.indexOf("red");
  const response = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/nodes/${root.id}/rewrite`, post({
    start, end: start + 3, instruction: "Change the color.", expected: "red", destination: "take"
  }));
  const events = await response.text();
  assert.match(events, /"type":"done"/);
  const takeId = /"type":"done","nodeId":"([^"]+)"/.exec(events)?.[1];
  assert.ok(takeId);
  assert.notEqual(takeId, root.id);

  const saved = await getStory(base, story.id);
  // The rewrite, the source it rewrote, and the child written under the
  // source before the rewrite all survive as three nodes.
  assert.equal(saved.nodes.length, 3);
  assert.equal(saved.path.length, 1);
  assert.equal(saved.path[0]!.id, takeId);
  assert.equal(saved.path[0]!.text, "The blue door opened.");
  // A freshly created take, never touched since — unlike the in-place splice
  // this replaces, it carries no updatedAt.
  assert.equal(saved.path[0]!.updatedAt, undefined);
  const source = saved.nodes.find((node) => node.id === root.id);
  assert.equal(source?.preview, "The red door opened.");
});

providerTest("generation HTTP: a later human edit moves a rewritten span, and writing over it reclaims that prose as human", async (t) => {
  const model = await fakeModel(t, (_body, response) => stream(response, ["crimson"]));
  const base = await testApp(t, modelSettings(model.baseUrl));
  const story = await seededStory(base, "The red door opened. Quiet followed.");
  const root = story.path[0]!;
  const start = root.text.indexOf("red");
  const rewrite = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/nodes/${root.id}/rewrite`, post({
    start, end: start + "red".length, instruction: "Pick a richer color.", expected: "red"
  }));
  assert.match(await rewrite.text(), /"type":"done"/);
  let saved = await getStory(base, story.id);
  const rewrittenWord = "crimson";
  let spanStart = saved.path[0]!.text.indexOf(rewrittenWord);
  assert.deepEqual(saved.path[0]!.rewrittenSpans, [{ start: spanStart, end: spanStart + rewrittenWord.length }]);

  // An edit earlier in the text shifts the span exactly as it shifts a
  // human span, without touching the model's word.
  const prefixed = `Well, ${saved.path[0]!.text}`;
  saved = await json(`${base}/api/stories/${story.id}/nodes/${root.id}`, {
    method: "PATCH",
    headers: { ...API_PROTOCOL_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ text: prefixed, expectedTextHash: sha256(saved.path[0]!.text) })
  });
  spanStart = saved.path[0]!.text.indexOf(rewrittenWord);
  assert.deepEqual(saved.path[0]!.rewrittenSpans, [{ start: spanStart, end: spanStart + rewrittenWord.length }]);

  // Writing over the rewritten word reclaims it as human and clears the span.
  const reclaimed = saved.path[0]!.text.replace(rewrittenWord, "green");
  saved = await json(`${base}/api/stories/${story.id}/nodes/${root.id}`, {
    method: "PATCH",
    headers: { ...API_PROTOCOL_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ text: reclaimed, expectedTextHash: sha256(saved.path[0]!.text) })
  });
  assert.equal(saved.path[0]!.rewrittenSpans, undefined);
  assert.equal(saved.path[0]!.attribution?.source, "human");
  assert.ok(saved.path[0]!.attribution!.ranges.some(
    (range) => saved.path[0]!.text.slice(range.start, range.end) === "green"
  ));
});

providerTest("generation HTTP: rewrite Fact selection scans through the target, not the active-line tail", async (t) => {
  const model = await fakeModel(t, (_body, response) => stream(response, ["blue"]));
  const base = await testApp(t, modelSettings(model.baseUrl));
  let story = await seededStory(base, "The red door opened.");
  const root = story.path[0]!;
  story = await json(`${base}/api/stories/${story.id}/nodes`, post({
    parentId: root.id,
    text: "Moonlight waited beyond the threshold."
  }));
  story = await json(`${base}/api/stories/${story.id}/facts`, post({
    text: "The red-door fact.", activation: "keyed", keys: ["red door"]
  }));
  await json(`${base}/api/stories/${story.id}/facts`, post({
    text: "The moonlight fact.", activation: "keyed", keys: ["moonlight"]
  }));

  const start = root.text.indexOf("red");
  const response = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/nodes/${root.id}/rewrite`, post({
    start, end: start + "red".length, instruction: "Change the color.", expected: "red"
  }));
  assert.match(await response.text(), /"type":"done"/);
  const facts = factMessage(model.requests[0]!);
  assert.match(facts, /The red-door fact\./);
  assert.doesNotMatch(facts, /The moonlight fact\./);
});

providerTest("generation HTTP: instructed passage rewrite preserves both semantic seams", async (t) => {
  const model = await fakeModel(t, (body, response) => {
    const messages = body.messages as Array<{ role: string; content: string }>;
    const prompt = messages.map((message) => message.content).join("\n");
    const tag = /<(rw-[a-f0-9]+)>/.exec(prompt)?.[1];
    assert.ok(tag);
    const rightAnchor = new RegExp(`<${tag}-right>([\\s\\S]*?)</${tag}-right>`).exec(prompt)?.[1];
    assert.ok(rightAnchor);
    assert.equal(messages.at(-1)?.role, "assistant");
    stream(response, [`storm-dark rain crossed the stones${rightAnchor}[[end-${tag}]]`]);
  });
  const base = await testApp(t, modelSettings(model.baseUrl));
  const source = "Before, the rain crossed the courtyard in silver sheets. Dawn followed.";
  const story = await seededStory(base, source);
  const root = story.path[0]!;
  const expected = "the rain crossed the courtyard in silver sheets";
  const start = root.text.indexOf(expected);
  const response = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/nodes/${root.id}/rewrite`, post({
    start,
    end: start + expected.length,
    instruction: "Make the weather ominous.",
    expected
  }));

  assert.match(await response.text(), /"type":"done"/);
  const saved = await getStory(base, story.id);
  assert.equal(saved.path[0]!.text, "Before, storm-dark rain crossed the stones. Dawn followed.");
});

providerTest("generation HTTP: an opt-in rewrite of a summary node commits as a new summary take", async (t) => {
  const base = await testApp(t, ABSENT_SETTINGS_V1);
  const story = await seededStory(base, "Opening.");
  const summaryResponse = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/summary-take`, post({ nodeId: story.path[0]!.id }));
  const events = await summaryResponse.text();
  const summaryId = /"type":"done","nodeId":"([^"]+)"/.exec(events)?.[1];
  assert.ok(summaryId);
  const summarized = await json<StoryPayload>(`${base}/api/stories/${story.id}/switch`, post({ nodeId: summaryId }));
  const summary = summarized.path.at(-1)!;
  assert.equal(summary.role, "summary");

  const expected = summary.text.slice(0, 5);
  // A plain inline summary is not a chapter summary, so it still needs the
  // opt-in to see the take path at all — the default is in-place like
  // everything else.
  const rewrite = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/nodes/${summary.id}/rewrite`, post({
    start: 0, end: expected.length, expected, instruction: "Reword the heading.", destination: "take"
  }));
  const rewriteEvents = await rewrite.text();
  assert.match(rewriteEvents, /"type":"done"/);
  const takeId = /"type":"done","nodeId":"([^"]+)"/.exec(rewriteEvents)?.[1];
  assert.ok(takeId);
  assert.notEqual(takeId, summaryId);

  const saved = await getStory(base, story.id);
  // A plain inline summary is not a chapter summary — it takes the ordinary
  // sibling-take path, not the in-place splice a chapter summary keeps.
  const rewritten = saved.path.find((node) => node.id === takeId)!;
  assert.match(rewritten.text, /^placeholder/);
  assert.equal(rewritten.role, "summary");
  assert.equal(saved.path.some((node) => node.id === summaryId), false);
  assert.equal(saved.nodes.some((node) => node.id === summaryId), true);
});

// Issue #277 stage 1: a provider without assistant-prefill support must echo
// the exact seam text back — precisely the step small models fail. These two
// tests call `rewriteNode` directly (skipping the settings file a spawned
// `testApp` reads from disk) because the no-prefill path is only reachable
// through a runtime-attached capability that cannot survive that round trip.
function noPrefillRewriteSettings(baseUrl: string): GenerationSettings {
  return attachProviderRuntime(modelSettings(baseUrl), {
    preset: "custom",
    auth: { type: "none" },
    headers: [],
    timeouts: { responseHeaderMs: 5_000, firstTokenMs: 5_000, idleMs: 5_000, totalMs: 20_000 },
    allowInsecureHttp: true,
    effort: "default",
    tokenProbabilities: null,
    sampling: EMPTY_SAMPLING_V2,
    capabilities: {
      temperature: "supported",
      assistantPrefill: "unsupported",
      reasoningEffort: "unknown",
      promptCaching: "unknown"
    }
  }, true);
}

function seamRewriteStory(): { story: Story; nodeId: string; start: number; end: number; expected: string } {
  const text = "The tavern keeper wiped the counter with a grey rag, then set it down slowly.";
  const expected = "then set it down slowly.";
  const start = text.indexOf(expected);
  const nodeId = "seam-root";
  return {
    story: {
      id: "seam-story",
      title: "Seam",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nodes: [{
        id: nodeId,
        parentId: null,
        instruction: "Open.",
        text,
        model: "m",
        createdAt: "2026-01-01T00:00:00.000Z",
        activeChildId: null
      }],
      activeRootId: nodeId,
      tags: [],
      recentNodeIds: [],
      facts: [],
      chapterBreaks: []
    },
    nodeId,
    start,
    end: start + expected.length,
    expected
  };
}

function stubRewriteStories(story: Story): ProviderStoryRuntime<"rewriteNode"> {
  return {
    loadForMutation: async () => story,
    hydratePath: async () => {},
    commitProviderEffect: async () => {
      throw new Error("commitProviderEffect must not run once the seam contract fails");
    }
  } as unknown as ProviderStoryRuntime<"rewriteNode">;
}

function stubSettingsStore(settings: GenerationSettings): SettingsStore {
  return {
    loadGeneration: async () => ({ settings, promptCache: LEGACY_PROMPT_CACHE_CONTEXT, imageInputCapability: null })
  } as unknown as SettingsStore;
}

providerTest("generation HTTP: a rewrite that fails the left seam points a struggling small model at plain regenerate", async (t) => {
  const model = await fakeModel(t, (body, response) => {
    const messages = body.messages as Array<{ content: string }>;
    const prompt = messages.map((message) => message.content).join("\n");
    assert.match(prompt, /-left>/, "expected the no-prefill contract to ask for an echoed left boundary");
    // Never copies the left boundary — the failure mode small models show live.
    stream(response, ["Something else entirely, not the boundary text."]);
  });
  const { story, nodeId, start, end, expected } = seamRewriteStory();

  await assert.rejects(
    rewriteNode(
      story.id, nodeId, { start, end, expected, instruction: "Make it grimmer." },
      stubRewriteStories(story), stubSettingsStore(noPrefillRewriteSettings(model.baseUrl)),
      new PromptCacheRuntime(), () => {}, new AbortController().signal
    ),
    (error: unknown) => {
      assert.ok(error instanceof GenerationResultError);
      assert.equal(error.status, 502);
      assert.match(error.message, /did not reconnect the replacement to the exact text before it/);
      assert.match(error.message, /Smaller models often cannot complete this exact-boundary step/);
      assert.match(error.message, /a plain regenerate \(a rewrite with no instruction\) is the reliable alternative/);
      return true;
    }
  );
});

providerTest("generation HTTP: a rewrite that fails to sign off points a struggling small model at plain regenerate", async (t) => {
  const model = await fakeModel(t, (body, response) => {
    const messages = body.messages as Array<{ content: string }>;
    const prompt = messages.map((message) => message.content).join("\n");
    const left = /<(rw-[a-f0-9]+)-left>([\s\S]*?)<\/\1-left>/.exec(prompt);
    assert.ok(left, "expected the no-prefill contract to ask for an echoed left boundary");
    // Copies the left boundary correctly, but never signs off with the end
    // marker — the selection reaches the end of the story, so there is no
    // right boundary to echo either.
    stream(response, [`${left![2]} new prose that never signs off`]);
  });
  const { story, nodeId, start, end, expected } = seamRewriteStory();

  await assert.rejects(
    rewriteNode(
      story.id, nodeId, { start, end, expected, instruction: "Make it grimmer." },
      stubRewriteStories(story), stubSettingsStore(noPrefillRewriteSettings(model.baseUrl)),
      new PromptCacheRuntime(), () => {}, new AbortController().signal
    ),
    (error: unknown) => {
      assert.ok(error instanceof GenerationResultError);
      assert.equal(error.status, 502);
      assert.match(error.message, /did not finish its replacement cleanly/);
      assert.match(error.message, /Smaller models often cannot complete this exact-boundary step/);
      assert.match(error.message, /a plain regenerate \(a rewrite with no instruction\) is the reliable alternative/);
      return true;
    }
  );
});

providerTest("generation HTTP: autoname selects only always Facts when no scan context exists", async (t) => {
  const model = await fakeModel(t, (_body, response) => stream(response, ["The Green Door"]));
  const base = await testApp(t, modelSettings(model.baseUrl));
  let story = await seededStory(base, "A quiet hall waited.");
  story = await json(`${base}/api/stories/${story.id}/facts`, post({
    text: "The always fact.", activation: "always", keys: []
  }));
  await json(`${base}/api/stories/${story.id}/facts`, post({
    text: "The keyed fact.", activation: "keyed", keys: ["hall"]
  }));

  const response = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/autoname`, post({
    expectedTitle: story.title
  }));
  assert.equal(response.status, 200);
  const facts = factMessage(model.requests[0]!);
  assert.match(facts, /The always fact\./);
  assert.doesNotMatch(facts, /The keyed fact\./);
});

providerTest("generation HTTP: an empty provider response remains an actionable provider error", async (t) => {
  const model = await fakeModel(t, (_body, response) => stream(response, []));
  const base = await testApp(t, modelSettings(model.baseUrl));
  const story = await seededStory(base, "Opening.");
  const response = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/continue`, post({
    parentId: story.path[0]!.id, instruction: "Continue.", genId: "empty-provider"
  }));
  assert.equal(response.status, 502);
  assert.match(await response.text(), /model returned no text/i);
  assert.equal((await getStory(base, story.id)).nodes.length, 1);
});

function factMessage(request: Record<string, unknown>): string {
  const messages = request.messages as Array<{ content: string }>;
  return messages.find((message) => message.content.startsWith("CANONICAL STORY FACTS"))?.content ?? "";
}

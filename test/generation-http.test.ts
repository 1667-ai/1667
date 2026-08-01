import assert from "node:assert/strict";
import test from "node:test";
import {
  ABSENT_SETTINGS_V1,
} from "../server/settings-v1-codec.js";
import { sha256 } from "../server/story-format.js";
import type { GenerationSettings, StoryPayload } from "../shared/types.js";
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

providerTest("generation HTTP: rewrite splices into the same node and keeps descendants", async (t) => {
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
  }));
  assert.match(await response.text(), /"type":"done"/);
  const saved = await getStory(base, story.id);
  assert.equal(saved.nodes.length, 2);
  assert.equal(saved.path[0]!.id, root.id);
  assert.equal(saved.path[0]!.text, "The blue door opened.");
  assert.equal(saved.path[1]!.text, "Dawn followed.");
  assert.ok(saved.path[0]!.updatedAt);
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

providerTest("generation HTTP: rewrite succeeds in place on a summary node", async (t) => {
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
  const rewrite = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/nodes/${summary.id}/rewrite`, post({
    start: 0, end: expected.length, expected, instruction: "Reword the heading."
  }));
  assert.match(await rewrite.text(), /"type":"done"/);
  const saved = await getStory(base, story.id);
  const rewritten = saved.path.find((node) => node.id === summary.id)!;
  assert.match(rewritten.text, /^placeholder/);
  assert.equal(rewritten.role, "summary");
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

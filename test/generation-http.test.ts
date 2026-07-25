import assert from "node:assert/strict";
import test from "node:test";
import {
  ABSENT_SETTINGS_V1,
} from "../server/settings-v1-codec.js";
import { sha256 } from "../server/story-format.js";
import type { GenerationSettings, StoryPayload } from "../shared/types.js";
import {
  API_PROTOCOL_HEADERS,
  fetchWithApiProtocol,
  fetchWithApiProtocolAtVersion,
  lastTestMutationId
} from "./http-test-client.js";
import {
  doneStory,
  fakeModel,
  modelSettings,
  providerTest,
  stream,
  testApp as providerTestApp
} from "./provider-http-fixture.js";

const testApp = (
  t: test.TestContext,
  settings: GenerationSettings
) => providerTestApp(t, settings, "1667-generation-http-");

test("HTTP API binds mutations to the preflighted server instance before dispatch", async (t) => {
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

providerTest("generation HTTP: append survives a concurrent line switch", async (t) => {
  let base = "";
  let storyId = "";
  const model = await fakeModel(t, async (_body, response) => {
    await json(`${base}/api/stories/${storyId}/nodes`, post({
      parentId: null,
      instruction: "Start elsewhere.",
      text: "The writer changed lines."
    }));
    stream(response, ["cked."]);
  });
  base = await testApp(t, modelSettings(model.baseUrl));
  const story = await seededStory(base, "The latch was unlo");
  storyId = story.id;
  const source = story.path[0]!;
  const response = await fetchWithApiProtocol(
    `${base}/api/stories/${story.id}/continue`,
    post({
      appendTo: source.id,
      expectedTextHash: sha256(source.text),
      instruction: "",
      genId: "append-after-switch"
    })
  );
  const returned = doneStory(await response.text());
  const saved = await getStory(base, story.id);
  assert.deepEqual(returned, saved);
  assert.equal(
    saved.nodes.find(({ id }) => id === source.id)?.preview,
    "The latch was unlocked."
  );
  assert.equal(saved.path.at(-1)?.text, "The writer changed lines.");
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

providerTest("generation HTTP: ambiguous transport stays blocked until explicit acknowledgement", async (t) => {
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
  assert.equal(failed.status, 409);
  const failedBody = await failed.json() as { error: string; code: string };
  assert.equal(failedBody.code, "generation_outcome_unknown");
  const originalMutationId = lastTestMutationId();
  assert.ok(originalMutationId);

  const retried = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/continue`, post(request));
  assert.equal(retried.status, 409);
  assert.match(await retried.text(), /generation_outcome_unknown/);
  assert.equal(model.requests.length, 1);

  await json(
    `${base}/api/stories/${story.id}/unknown-outcomes/${originalMutationId}/ack`,
    post({})
  );
  const afterAcknowledgement = await fetchWithApiProtocol(
    `${base}/api/stories/${story.id}/continue`,
    post(request)
  );
  assert.equal(afterAcknowledgement.status, 200);
  assert.match(await afterAcknowledgement.text(), /"type":"done"/);
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

providerTest("generation HTTP: a racing Stop save wins by generation ID", async (t) => {
  let base = "";
  let storyId = "";
  let rootId = "";
  let cachedVersion!: NonNullable<StoryPayload["aggregateVersion"]>;
  const genId = "stop-wins";
  const model = await fakeModel(t, async (_body, response) => {
    const stopped = await fetchWithApiProtocolAtVersion(
      `${base}/api/stories/${storyId}/nodes`,
      post({
        parentId: rootId,
        instruction: "Continue.",
        text: "Partial saved by Stop.",
        genId
      }),
      cachedVersion
    );
    if (!stopped.ok) {
      assert.fail(`${stopped.status} ${await stopped.text()}`);
    }
    stream(response, ["Completed provider text."]);
  });
  base = await testApp(t, modelSettings(model.baseUrl));
  const story = await seededStory(base, "Opening.");
  storyId = story.id;
  rootId = story.path[0]!.id;
  assert.ok(story.aggregateVersion);
  cachedVersion = story.aggregateVersion;

  const response = await fetchWithApiProtocol(
    `${base}/api/stories/${story.id}/continue`,
    post({ parentId: rootId, instruction: "Continue.", genId })
  );
  const returned = doneStory(await response.text());
  const saved = await getStory(base, story.id);
  assert.deepEqual(returned, saved);
  assert.equal(
    saved.path.filter((node) => node.genId === genId).length,
    1
  );
  assert.equal(saved.path.at(-1)?.text, "Partial saved by Stop.");
});

providerTest("generation HTTP: aborting a continuation mid-stream discards the generated take", async (t) => {
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
  await assert.rejects(pending);
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

providerTest("generation HTTP: rewrite rejects an instruction-only concurrent edit", async (t) => {
  let base = "";
  let storyId = "";
  let rootId = "";
  let sourceText = "";
  const model = await fakeModel(t, async (_body, response) => {
    await json(`${base}/api/stories/${storyId}/nodes/${rootId}`, {
      method: "PATCH",
      headers: {
        ...API_PROTOCOL_HEADERS,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        instruction: "Writer changed the instruction.",
        expectedTextHash: sha256(sourceText)
      })
    });
    stream(response, ["blue"]);
  });
  base = await testApp(t, modelSettings(model.baseUrl));
  const story = await seededStory(base, "The red door opened.");
  storyId = story.id;
  rootId = story.path[0]!.id;
  sourceText = story.path[0]!.text;
  const start = sourceText.indexOf("red");

  const response = await fetchWithApiProtocol(
    `${base}/api/stories/${story.id}/nodes/${rootId}/rewrite`,
    post({
      start,
      end: start + 3,
      instruction: "Change the color.",
      expected: "red"
    })
  );
  assert.match(
    await response.text(),
    /"type":"error"[\s\S]*node changed while rewriting/i
  );
  const saved = await getStory(base, story.id);
  assert.equal(saved.path[0]?.text, sourceText);
  assert.equal(
    saved.path[0]?.instruction,
    "Writer changed the instruction."
  );
});

providerTest("generation HTTP: autoname preserves a concurrent manual title", async (t) => {
  let base = "";
  let storyId = "";
  const model = await fakeModel(t, async (_body, response) => {
    await json(`${base}/api/stories/${storyId}`, {
      method: "PATCH",
      headers: {
        ...API_PROTOCOL_HEADERS,
        "content-type": "application/json"
      },
      body: JSON.stringify({ title: "Writer title" })
    });
    stream(response, ["Model title"]);
  });
  base = await testApp(t, modelSettings(model.baseUrl));
  const story = await seededStory(base, "Opening.");
  storyId = story.id;

  const response = await fetchWithApiProtocol(
    `${base}/api/stories/${story.id}/autoname`,
    post({ expectedTitle: story.title })
  );
  assert.equal(response.status, 409);
  assert.match(await response.text(), /title changed while the model/i);
  assert.equal((await getStory(base, story.id)).title, "Writer title");
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

async function seededStory(base: string, text: string): Promise<StoryPayload> {
  const created = await json<StoryPayload>(`${base}/api/stories`, post({ title: "Test" }));
  return await json(`${base}/api/stories/${created.id}/nodes`, post({ parentId: null, instruction: "Write.", text }));
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

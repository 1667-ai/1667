import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { readHttpAuthRecord } from "../server/http-auth-record.js";
import { sha256 } from "../server/story-format.js";
import type { GenerationSettings, StoryPayload } from "../shared/types.js";
import {
  HttpListenerAuthority
} from "../shared/http-listener-authority.js";
import { createApi } from "../tui/src/api.js";
import {
  API_PROTOCOL_HEADERS,
  fetchWithApiProtocol,
  fetchWithApiProtocolAtVersion,
  lastTestMutationId
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
) => providerTestApp(t, settings, "1667-generation-http-concurrency-");

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

providerTest("generation HTTP: a deep writer extension keeps the current line", async (t) => {
  let base = "";
  let storyId = "";
  let oldChildId = "";
  const model = await fakeModel(t, async (_body, response) => {
    await json(`${base}/api/stories/${storyId}/nodes`, post({
      parentId: oldChildId,
      instruction: "Keep writing.",
      text: "The writer extended the current line."
    }));
    stream(response, ["A generated alternative."]);
  });
  base = await testApp(t, modelSettings(model.baseUrl));
  let story = await seededStory(base, "Opening.");
  const root = story.path[0]!;
  story = await json(`${base}/api/stories/${story.id}/nodes`, post({
    parentId: root.id,
    text: "Original continuation."
  }));
  storyId = story.id;
  oldChildId = story.path[1]!.id;

  const response = await fetchWithApiProtocol(
    `${base}/api/stories/${story.id}/continue`,
    post({
      parentId: root.id,
      instruction: "Try another turn.",
      genId: "retake-after-deep-extension"
    })
  );
  const returned = doneStory(await response.text());
  const saved = await getStory(base, story.id);
  assert.deepEqual(returned, saved);
  assert.equal(saved.path[1]?.id, oldChildId);
  assert.equal(saved.path[2]?.text, "The writer extended the current line.");
  const generated = saved.nodes.find(
    (node) => node.parentId === root.id && node.id !== oldChildId
  );
  assert.equal(generated?.parentId, root.id);
  assert.equal(generated?.preview, "A generated alternative.");
});

providerTest("generation HTTP: acknowledgement wins against active provider terminalization", async (t) => {
  let release!: () => void;
  let markRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const model = await fakeModel(t, async (_body, response) => {
    markRequested();
    await gate;
    stream(response, ["Must not commit."]);
  });
  const base = await testApp(t, modelSettings(model.baseUrl));
  const story = await seededStory(base, "Opening.");
  const pending = fetchWithApiProtocol(
    `${base}/api/stories/${story.id}/continue`,
    post({
      parentId: story.path[0]!.id,
      instruction: "Continue.",
      genId: "acknowledged-active-provider"
    })
  );
  await requested;
  const originalMutationId = lastTestMutationId();
  assert.ok(originalMutationId);

  await json(
    `${base}/api/stories/${story.id}/unknown-outcomes/${originalMutationId}/ack`,
    post({})
  );
  release();
  const events = await (await pending).text();

  assert.match(
    events,
    /"code":"generation_outcome_unknown_acknowledged"/
  );
  assert.equal(model.requests.length, 1);
  assert.equal((await getStory(base, story.id)).nodes.length, 1);
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
  assert.equal(saved.path.filter((node) => node.genId === genId).length, 1);
  assert.equal(saved.path.at(-1)?.text, "Partial saved by Stop.");
});

providerTest("generation HTTP: Stop keeps text that already arrived", async (t) => {
  const model = await fakeModel(t, async (_body, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({
        choices: [{
          delta: { content: "Partial text from the model." },
          finish_reason: null
        }]
      })}\n\n`
    );
    await once(response, "close");
  });
  const base = await testApp(t, modelSettings(model.baseUrl));
  const { record } = await readHttpAuthRecord(base);
  const api = createApi(base, undefined, {
    authority: new HttpListenerAuthority({
      root: base,
      binding: { authRecord: record, fetch }
    })
  });
  let story = await api.createStory("Stop");
  story = await api.createNode(story.id, {
    parentId: null,
    instruction: "Begin.",
    text: "Opening."
  });
  const parentId = story.path.at(-1)!.id;
  const genId = "stop-keeps-arrived-text";
  const cancel = new AbortController();
  const arrived: string[] = [];

  const stopped = await api.continueStory(
    story.id,
    "Continue.",
    genId,
    { parentId },
    (text) => {
      arrived.push(text);
      cancel.abort();
    },
    cancel.signal
  );
  assert.equal(stopped, null);
  assert.equal(arrived.join(""), "Partial text from the model.");

  story = await api.createNode(story.id, {
    parentId,
    instruction: "Continue.",
    text: arrived.join(""),
    genId
  });
  assert.equal(story.path.at(-1)?.genId, genId);
  assert.equal(story.path.at(-1)?.text, "Partial text from the model.");
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

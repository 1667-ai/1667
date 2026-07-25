import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LEGACY_PREVIEW_DATA_MARKER,
  LEGACY_PREVIEW_DATA_MARKER_TEXT
} from "../server/data-directory-format.js";
import {
  ABSENT_SETTINGS_V1,
  formatGenerationSettingsV1
} from "../server/settings-v1-codec.js";
import { ownedLoopbackHttpSupported } from "../server/provider-fetch.js";
import { sha256 } from "../server/story-format.js";
import type { GenerationSettings, StoryPayload } from "../shared/types.js";
import {
  API_PROTOCOL_HEADERS,
  fetchWithApiProtocol,
  rememberServerInstance
} from "./http-test-client.js";

const providerTest = ownedLoopbackHttpSupported() ? test : test.skip;

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
  assert.match(await response.text(), /"type":"done"/);
  const messages = model.requests[0]!.messages as Array<{ role: string; content: string }>;
  assert.deepEqual(messages.at(-1), { role: "assistant", content: "The latch was unlo" });
  assert.equal(model.requests[0]!.model, "test-model");
  const saved = await getStory(base, story.id);
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

providerTest("generation HTTP: ambiguous transport receipt requires a new explicit request", async (t) => {
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
  assert.match(await failed.text(), /generation_outcome_unknown/);
  const retried = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/continue`, post(request));
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

function modelSettings(modelBaseUrl: string): GenerationSettings {
  return {
    provider: "openai-compatible", baseUrl: modelBaseUrl, model: "test-model", apiKeyEnv: null,
    temperature: 0, maxTokens: 128, systemPrompt: "Write coherent prose.", contextWindow: 4096
  };
}

async function fakeModel(
  t: test.TestContext,
  reply: (body: Record<string, unknown>, response: ServerResponse) => void | Promise<void>
): Promise<{ baseUrl: string; requests: Record<string, unknown>[] }> {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const body = JSON.parse(await requestText(request)) as Record<string, unknown>;
    requests.push(body);
    await reply(body, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

function stream(response: ServerResponse, chunks: readonly string[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const content of chunks) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function testApp(t: test.TestContext, settings: GenerationSettings): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-generation-http-"));
  await writeFile(
    path.join(dataDir, ".1667.lock"),
    "1667-lock-aware-legacy-exclusion-v1\n",
    { mode: 0o600 }
  );
  await writeFile(
    path.join(dataDir, LEGACY_PREVIEW_DATA_MARKER),
    LEGACY_PREVIEW_DATA_MARKER_TEXT,
    { mode: 0o600 }
  );
  await writeFile(
    path.join(dataDir, "settings.json"),
    formatGenerationSettingsV1(settings),
    { encoding: "utf8", mode: 0o600, flag: "wx" }
  );
  const port = await availablePort();
  const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, AI_1667_DATA: dataDir, AI_1667_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  server.stdout?.on("data", (chunk) => { output += String(chunk); });
  server.stderr?.on("data", (chunk) => { output += String(chunk); });
  t.after(async () => { await stopApp(server); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`server exited: ${output}`);
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) {
        await rememberServerInstance(await response.json(), base);
        return base;
      }
    } catch { /* startup */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`server did not start: ${output}`);
}

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function stopApp(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return;
  server.kill("SIGTERM");
  await Promise.race([new Promise<void>((resolve) => server.once("exit", () => resolve())), new Promise((resolve) => setTimeout(resolve, 1_000))]);
  if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
}

async function requestText(request: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return text;
}

async function getStory(base: string, id: string): Promise<StoryPayload> {
  return await json(`${base}/api/stories/${id}`);
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithApiProtocol(url, init);
  if (!response.ok) assert.fail(`${response.status} ${await response.text()}`);
  return await response.json() as T;
}

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import test from "node:test";
import { applyBasicSettingsDraft } from "../shared/settings-basic-draft.js";
import {
  continuationPlan,
  supportsAssistantPrefill
} from "../shared/continuation-plan.js";
import type { PromptPlan } from "../shared/prompt-plan.js";
import { discoverProviderModels } from "../server/model-discovery.js";
import { ownedLoopbackHttpSupported } from "../server/provider-fetch.js";
import { attachProviderRuntime } from "../server/provider-runtime.js";
import { streamCompletion } from "../server/providers.js";
import { SettingsStore } from "../server/settings.js";
import { INITIAL_SETTINGS_DOCUMENT_V2 } from "../server/settings-v2-default.js";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
import type { StoryNode } from "../shared/types.js";
import {
  FIXED_TIME,
  MUTATION_A,
  initializedFormat2Directory,
  saveCommand
} from "./settings-store-fixtures.js";

const PROMPT: PromptPlan = {
  operation: "continue",
  turns: [{
    role: "user",
    blocks: [{
      stability: "volatile",
      kind: "request",
      text: "Continue.",
      boundaryAfter: "none"
    }]
  }]
};

test("saved KoboldCpp localhost HTTP discovers, streams, and survives restart", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  let generations = 0;
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "local-model" }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      generations += 1;
      response.setHeader("content-type", "text/event-stream");
      response.end([
        'data: {"choices":[{"delta":{"content":" local prose"}}]}',
        "",
        "data: [DONE]",
        "",
        ""
      ].join("\n"));
      return;
    }
    response.writeHead(404).end();
  });
  const origin = await listen(server);
  t.after(() => server.close());

  const dataDir = await initializedFormat2Directory(
    t,
    "1667-local-model-e2e-"
  );
  const first = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await first.init(2);
  const document = applyBasicSettingsDraft(INITIAL_SETTINGS_DOCUMENT_V2, {
    provider: "openai-compatible",
    baseUrl: `${origin}/v1`,
    model: "local-model",
    apiKeyEnv: null,
    temperature: 0.7,
    maxTokens: 128,
    systemPrompt: "Continue the story.",
    contextWindow: 8_192
  });
  await first.save(saveCommand(MUTATION_A, 1, document));

  const activated = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await activated.init(2);
  const firstRuntime = await activated.loadGeneration();
  assert.deepEqual(
    (await discoverProviderModels(firstRuntime.settings)).models.map(
      (model) => model.remoteId
    ),
    ["local-model"]
  );
  assert.equal(await collect(streamCompletion(
    firstRuntime.settings,
    PROMPT,
    new AbortController().signal
  )), " local prose");

  const restarted = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await restarted.init(2);
  const restartedRuntime = await restarted.loadGeneration();
  assert.equal(restartedRuntime.settings.baseUrl, `${origin}/v1`);
  assert.equal(await collect(streamCompletion(
    restartedRuntime.settings,
    PROMPT,
    new AbortController().signal
  )), " local prose");
  assert.equal(generations, 2);
});

test("llama.cpp Chat Completions continues the final assistant message on the wire", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    requests.push(JSON.parse(await requestText(request)) as Record<string, unknown>);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      'data: {"choices":[{"delta":{"content":" into the hall"},"finish_reason":null}]}',
      "",
      "data: [DONE]",
      "",
      ""
    ].join("\n"));
  });
  const origin = await listen(server);
  t.after(() => server.close());

  const settings = attachProviderRuntime({
    provider: "openai-compatible" as const,
    baseUrl: `${origin}/v1`,
    model: "gemma-31b",
    apiKeyEnv: null,
    temperature: 0.7,
    maxTokens: 128,
    systemPrompt: "Write coherent prose.",
    contextWindow: 8_192
  }, {
    preset: "llama-cpp",
    protocol: "openai-chat-completions",
    auth: { type: "none" },
    headers: [],
    timeouts: {
      responseHeaderMs: 5_000,
      firstTokenMs: 5_000,
      idleMs: 5_000,
      totalMs: 20_000
    },
    allowInsecureHttp: true,
    effort: "default",
    tokenProbabilities: null,
    sampling: EMPTY_SAMPLING_V2,
    capabilities: {
      temperature: "supported",
      assistantPrefill: "unknown",
      reasoningEffort: "unknown",
      promptCaching: "unknown"
    }
  });
  const parts: StoryNode[] = [{
    id: "part-1",
    parentId: null,
    instruction: "The door opened.",
    text: "Cold air spilled",
    model: "gemma-31b",
    createdAt: "2026-01-01T00:00:00.000Z",
    activeChildId: null
  }];
  const prompt = continuationPlan(
    "Write coherent prose.",
    "The lantern is blue.",
    null,
    parts,
    "Continue the story.",
    true,
    supportsAssistantPrefill(settings),
    "ct-gemma",
    [],
    parts
  ).prompt;

  assert.equal(
    await collect(streamCompletion(settings, prompt, new AbortController().signal)),
    " into the hall"
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.add_generation_prompt, false);
  assert.equal(requests[0]!.continue_final_message, true);
  assert.deepEqual(
    (requests[0]!.messages as Array<{ role: string; content: string }>).at(-1),
    { role: "assistant", content: "Cold air spilled" }
  );
  const messages = requests[0]!.messages as Array<{ role: string; content: string }>;
  const facts = messages.find((message) => message.role === "system" && message.content.includes("lantern"));
  assert.equal(facts?.content, "The lantern is blue.");
  assert.equal(
    messages.some((message) => /exact final character/.test(message.content)),
    true
  );
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture server did not expose a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let result = "";
  for await (const chunk of stream) result += chunk;
  return result;
}

async function requestText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test from "node:test";
import { applyBasicSettingsDraft } from "../shared/settings-basic-draft.js";
import { applySamplingSettings } from "../shared/sampling-capabilities.js";
import type {
  SamplingSettingsV2,
  SettingsDocumentV2,
  SettingsPresetV2
} from "../shared/settings-v2-types.js";
import { streamCompletion } from "../server/providers.js";
import { ownedLoopbackHttpSupported } from "../server/provider-fetch.js";
import { providerRuntimeFor } from "../server/provider-runtime.js";
import { SettingsStore } from "../server/settings.js";
import { INITIAL_SETTINGS_DOCUMENT_V2 } from "../server/settings-v2-default.js";
import {
  FIXED_TIME,
  MUTATION_A,
  MUTATION_B,
  MUTATION_C,
  initializedFormat2Directory,
  saveCommand
} from "./settings-store-fixtures.js";

const PROMPT = {
  operation: "continue" as const,
  turns: [{
    role: "user" as const,
    blocks: [{
      stability: "volatile" as const,
      kind: "request" as const,
      text: "Continue.",
      boundaryAfter: "none" as const
    }]
  }]
};

test("saved llama.cpp sampling survives activation and restart and reaches the wire", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  const fixture = await startProviderFixture(t);
  const dataDir = await initializedFormat2Directory(t, "1667-sampling-llama-e2e-");
  const first = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await first.init(2);
  const sampling: SamplingSettingsV2 = {
    topP: 0.9,
    topK: 40,
    minP: 0.05,
    frequencyPenalty: 0.2,
    presencePenalty: -0.1,
    repeatPenalty: 1.1,
    seed: 42,
    stop: ["END", "DONE"],
    logitBias: { "15043": 1 }
  };
  await first.save(saveCommand(
    MUTATION_A,
    1,
    documentFor(fixture.origin, "llama-cpp", "e2e-model", sampling)
  ));

  const restarted = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await restarted.init(2);
  const runtime = await restarted.loadGeneration();
  assert.deepEqual(providerRuntimeFor(runtime.settings).sampling, sampling);
  await collect(streamCompletion(runtime.settings, PROMPT, new AbortController().signal));
  const body = fixture.bodies.at(-1)!;
  assert.deepEqual({
    top_p: body.top_p,
    top_k: body.top_k,
    min_p: body.min_p,
    frequency_penalty: body.frequency_penalty,
    presence_penalty: body.presence_penalty,
    repeat_penalty: body.repeat_penalty,
    seed: body.seed,
    stop: body.stop,
    logit_bias: body.logit_bias
  }, {
    top_p: 0.9,
    top_k: 40,
    min_p: 0.05,
    frequency_penalty: 0.2,
    presence_penalty: -0.1,
    repeat_penalty: 1.1,
    seed: 42,
    stop: ["END", "DONE"],
    logit_bias: { "15043": 1 }
  });
});

test("unset sampling knobs stay absent from an activated OpenAI request", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  const fixture = await startProviderFixture(t);
  const dataDir = await initializedFormat2Directory(t, "1667-sampling-omit-e2e-");
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await store.init(2);
  await store.save(saveCommand(
    MUTATION_B,
    1,
    documentFor(fixture.origin, "custom", "e2e-model", {
      topP: 0.9,
      topK: null,
      minP: null,
      frequencyPenalty: null,
      presencePenalty: null,
      repeatPenalty: null,
      seed: null,
      stop: [],
      logitBias: {}
    })
  ));
  const runtime = await store.loadGeneration();
  await collect(streamCompletion(runtime.settings, PROMPT, new AbortController().signal));
  assert.deepEqual(Object.keys(fixture.bodies.at(-1)!).sort(), [
    "max_tokens",
    "messages",
    "model",
    "stream",
    "temperature",
    "top_p"
  ]);
});

test("Ollama rejects logit bias at save time without changing the active document", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-sampling-ollama-save-");
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await store.init(2);
  const before = (await store.loadView()).document;
  const candidate = documentFor("http://127.0.0.1:11434/v1", "ollama", "ollama-model", {
    topP: null,
    topK: null,
    minP: null,
    frequencyPenalty: null,
    presencePenalty: null,
    repeatPenalty: null,
    seed: null,
    stop: [],
    logitBias: { "1": 1 }
  });
  await assert.rejects(
    () => store.save(saveCommand(MUTATION_C, 1, candidate)),
    /logit bias.*preset/u
  );
  assert.deepEqual((await store.loadView()).document, before);
});

test("Anthropic lowering uses stop_sequences and does not emit OpenAI stop", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  const fixture = await startProviderFixture(t);
  const dataDir = await initializedFormat2Directory(t, "1667-sampling-anthropic-e2e-");
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await store.init(2);
  await store.save(saveCommand(
    `m1.1767225600003.${"e".repeat(32)}`,
    1,
    documentFor(fixture.origin, "custom", "claude-opus-4-5", {
      topP: 0.9,
      topK: 32,
      minP: null,
      frequencyPenalty: null,
      presencePenalty: null,
      repeatPenalty: null,
      seed: null,
      stop: ["END"],
      logitBias: {}
    }, "anthropic")
  ));
  const runtime = await store.loadGeneration();
  await collect(streamCompletion(runtime.settings, PROMPT, new AbortController().signal));
  const body = fixture.bodies.at(-1)!;
  assert.deepEqual(body.stop_sequences, ["END"]);
  assert.equal("stop" in body, false);
});

test("Anthropic Messages rejects seed at save time without changing the active document", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-sampling-anthropic-seed-save-");
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await store.init(2);
  const before = (await store.loadView()).document;
  const candidate = documentFor("https://api.anthropic.com", "anthropic", "claude-opus-4-5", {
    topP: null,
    topK: null,
    minP: null,
    frequencyPenalty: null,
    presencePenalty: null,
    repeatPenalty: null,
    seed: 42,
    stop: [],
    logitBias: {}
  }, "anthropic");
  await assert.rejects(
    () => store.save(saveCommand(MUTATION_C, 1, candidate)),
    /seed.*protocol/u
  );
  assert.deepEqual((await store.loadView()).document, before);
});

function documentFor(
  origin: string,
  preset: SettingsPresetV2,
  model: string,
  sampling: SamplingSettingsV2,
  provider: "openai-compatible" | "anthropic" = "openai-compatible"
): SettingsDocumentV2 {
  const base = applyBasicSettingsDraft(INITIAL_SETTINGS_DOCUMENT_V2, {
    provider,
    baseUrl: `${origin}/v1`,
    model,
    apiKeyEnv: null,
    temperature: 0.7,
    maxTokens: 128,
    systemPrompt: "Continue the story.",
    contextWindow: 8_192
  });
  const connectionId = base.models[base.profiles.default!.modelId]!.connectionId;
  return applySamplingSettings({
    ...base,
    connections: {
      ...base.connections,
      [connectionId]: { ...base.connections[connectionId]!, preset }
    }
  }, sampling);
}

async function startProviderFixture(t: { after(callback: () => void | Promise<void>): void }) {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    void handleRequest(request, response, bodies);
  });
  await listen(server);
  t.after(() => { server.close(); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture has no address");
  return { origin: `http://127.0.0.1:${address.port}`, bodies };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  bodies: Record<string, unknown>[]
): Promise<void> {
  if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "e2e-model" }] }));
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  const body = JSON.parse(await requestText(request)) as Record<string, unknown>;
  bodies.push(body);
  if (request.url === "/v1/messages") {
    response.setHeader("content-type", "text/event-stream");
    response.end([
      "event: content_block_delta",
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
      ""
    ].join("\n"));
    return;
  }
  response.setHeader("content-type", "text/event-stream");
  response.end([
    'data: {"choices":[{"delta":{"content":"ok"}}]}',
    "",
    "data: [DONE]",
    "",
    ""
  ].join("\n"));
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function requestText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let result = "";
  for await (const chunk of stream) result += chunk;
  return result;
}

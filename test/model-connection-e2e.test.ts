import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { applyBasicSettingsDraft } from "../shared/settings-basic-draft.js";
import type { PromptPlan } from "../shared/prompt-plan.js";
import { discoverProviderModels } from "../server/model-discovery.js";
import { ownedLoopbackHttpSupported } from "../server/provider-fetch.js";
import { streamCompletion } from "../server/providers.js";
import { SettingsStore } from "../server/settings.js";
import { INITIAL_SETTINGS_DOCUMENT_V2 } from "../server/settings-v2-default.js";
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

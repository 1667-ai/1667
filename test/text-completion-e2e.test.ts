import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import test from "node:test";
import { effectiveGenerationSettings } from "../server/settings-v2-conversion.js";
import { INITIAL_SETTINGS_DOCUMENT_V2 } from "../server/settings-v2-default.js";
import { streamCompletion, type StreamOutcome } from "../server/providers.js";
import { applyBasicSettingsDraft } from "../shared/settings-basic-draft.js";
import {
  applySamplingSettings,
  resolveSamplingKnob
} from "../shared/sampling-capabilities.js";
import {
  EMPTY_SAMPLING_V2,
  type SettingsDocumentV2,
  type SettingsPresetV2,
  type TextPromptFormatV2
} from "../shared/settings-v2-types.js";
import type { PromptPlan } from "../shared/prompt-plan.js";

const PROMPT: PromptPlan = {
  operation: "continue",
  turns: [
    {
      role: "system",
      blocks: [{
        stability: "stable",
        kind: "author-brief",
        text: "Write plain prose.",
        boundaryAfter: "none"
      }]
    },
    {
      role: "user",
      blocks: [{
        stability: "stable",
        kind: "operation-contract",
        text: "Continue the passage.",
        boundaryAfter: "candidate"
      }]
    },
    {
      role: "assistant",
      blocks: [{
        stability: "volatile",
        kind: "boundary",
        text: "The lantern dimmed",
        boundaryAfter: "none"
      }]
    }
  ]
};

test("OpenAI-compatible text completions stream ChatML without changing the final boundary", async (t) => {
  const requests: ProviderRequest[] = [];
  const server = createServer(async (request, response) => {
    requests.push(await providerRequest(request));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      'data: {"choices":[{"text":" softly","finish_reason":null}]}',
      "",
      'data: {"choices":[{"text":"","finish_reason":"stop"}]}',
      "",
      "data: [DONE]",
      "",
      ""
    ].join("\n"));
  });
  const origin = await listen(t, server);
  const settings = effectiveGenerationSettings(
    textDocument(origin, "custom", "chatml")
  );
  const outcome: StreamOutcome = { finishReason: null };

  assert.equal(await collect(streamCompletion(
    settings,
    PROMPT,
    new AbortController().signal,
    { outcome }
  )), " softly");
  assert.equal(requests[0]?.path, "/v1/completions");
  assert.equal(
    requests[0]?.body.prompt,
    [
      "<|im_start|>system\nWrite plain prose.<|im_end|>\n",
      "<|im_start|>user\nContinue the passage.<|im_end|>\n",
      "<|im_start|>assistant\nThe lantern dimmed"
    ].join("")
  );
  assert.equal(requests[0]?.body.max_tokens, 96);
  assert.equal(outcome.finishReason, "stop");
});

test("llama.cpp text completions derive the prompt from the server template", async (t) => {
  const requests: ProviderRequest[] = [];
  const server = createServer(async (request, response) => {
    const captured = await providerRequest(request);
    requests.push(captured);
    if (captured.path === "/apply-template") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ prompt: "server template :: The lantern dimmed" }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      'data: {"content":" softly","stop":false}',
      "",
      'data: {"content":"","stop":true,"stop_type":"eos"}',
      "",
      ""
    ].join("\n"));
  });
  const origin = await listen(t, server);
  const settings = effectiveGenerationSettings(
    textDocument(origin, "llama-cpp", "server-template")
  );

  assert.equal(await collect(streamCompletion(
    settings,
    PROMPT,
    new AbortController().signal
  )), " softly");
  assert.equal(requests[0]?.path, "/apply-template");
  assert.equal(requests[0]?.body.add_generation_prompt, false);
  assert.equal(requests[0]?.body.continue_final_message, true);
  assert.deepEqual(
    (requests[0]?.body.messages as { role: string; content: string }[])
      .map(({ role }) => role),
    ["system", "user", "assistant"]
  );
  assert.equal(requests[1]?.path, "/completion");
  assert.equal(requests[1]?.body.prompt, "server template :: The lantern dimmed");
  assert.equal(requests[1]?.body.model, "test-model");
  assert.equal(requests[1]?.body.n_predict, 96);
});

test("KoboldCpp text completions use its native stream and sampler names", async (t) => {
  const requests: ProviderRequest[] = [];
  const server = createServer(async (request, response) => {
    requests.push(await providerRequest(request));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      'data: {"token":" softly","finish_reason":null}',
      "",
      'data: {"token":"","finish_reason":"length"}',
      "",
      ""
    ].join("\n"));
  });
  const origin = await listen(t, server);
  const document = applySamplingSettings(
    textDocument(origin, "koboldcpp", "raw"),
    {
      ...EMPTY_SAMPLING_V2,
      topP: 0.91,
      presencePenalty: 0.2,
      repeatPenalty: 1.12,
      seed: 42,
      stop: ["END"]
    }
  );
  const settings = effectiveGenerationSettings(document);
  const outcome: StreamOutcome = { finishReason: null };

  assert.equal(await collect(streamCompletion(
    settings,
    PROMPT,
    new AbortController().signal,
    { outcome }
  )), " softly");
  assert.equal(requests[0]?.path, "/api/extra/generate/stream");
  assert.equal(
    requests[0]?.body.prompt,
    "Write plain prose.\n\nContinue the passage.\n\nThe lantern dimmed"
  );
  assert.equal(requests[0]?.body.max_length, 96);
  assert.equal(requests[0]?.body.model, "test-model");
  assert.equal(requests[0]?.body.top_p, 0.91);
  assert.equal(requests[0]?.body.presence_penalty, 0.2);
  assert.equal(requests[0]?.body.rep_pen, 1.12);
  assert.equal(requests[0]?.body.sampler_seed, 42);
  assert.deepEqual(requests[0]?.body.stop_sequence, ["END"]);
  assert.equal(outcome.finishReason, "length");
});

test("KoboldCpp text distinguishes its presence penalty from its frequency alias", () => {
  const context = {
    protocol: "text-completions" as const,
    preset: "koboldcpp" as const,
    remoteModelId: "test-model",
    temperatureSupport: "supported" as const
  };

  assert.deepEqual(resolveSamplingKnob(context, EMPTY_SAMPLING_V2, "presencePenalty"), {
    kind: "available",
    wireField: "presence_penalty"
  });
  assert.deepEqual(resolveSamplingKnob(context, EMPTY_SAMPLING_V2, "frequencyPenalty"), {
    kind: "unavailable",
    reason: "preset-unsupported"
  });
});

test("KoboldCpp text rejects a provider error after partial output", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      'data: {"token":" partial","finish_reason":null}',
      "",
      'data: {"token":"","finish_reason":"error"}',
      "",
      ""
    ].join("\n"));
  });
  const origin = await listen(t, server);
  const settings = effectiveGenerationSettings(
    textDocument(origin, "koboldcpp", "raw")
  );
  const received: string[] = [];

  await assert.rejects(async () => {
    for await (const chunk of streamCompletion(
      settings,
      PROMPT,
      new AbortController().signal
    )) {
      received.push(chunk);
    }
  }, /KoboldCpp generation failed/);
  assert.equal(received.join(""), " partial");
});

test("OpenAI-compatible text rejects content filtering after partial output", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      'data: {"choices":[{"text":" partial","finish_reason":null}]}',
      "",
      'data: {"choices":[{"text":"","finish_reason":"content_filter"}]}',
      "",
      "data: [DONE]",
      "",
      ""
    ].join("\n"));
  });
  const origin = await listen(t, server);
  const settings = effectiveGenerationSettings(
    textDocument(origin, "custom", "raw")
  );
  const received: string[] = [];

  await assert.rejects(async () => {
    for await (const chunk of streamCompletion(
      settings,
      PROMPT,
      new AbortController().signal
    )) {
      received.push(chunk);
    }
  }, /OpenAI-compatible generation failed/);
  assert.equal(received.join(""), " partial");
});

test("OpenAI-compatible text rejects DONE without a successful finish reason", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      'data: {"choices":[{"text":" partial","finish_reason":null}]}',
      "",
      "data: [DONE]",
      "",
      ""
    ].join("\n"));
  });
  const origin = await listen(t, server);
  const settings = effectiveGenerationSettings(
    textDocument(origin, "custom", "raw")
  );
  const received: string[] = [];

  await assert.rejects(async () => {
    for await (const chunk of streamCompletion(
      settings,
      PROMPT,
      new AbortController().signal
    )) {
      received.push(chunk);
    }
  }, /without a successful finish reason/);
  assert.equal(received.join(""), " partial");
});

function textDocument(
  origin: string,
  preset: SettingsPresetV2,
  textPromptFormat: TextPromptFormatV2
): SettingsDocumentV2 {
  const base = applyBasicSettingsDraft(INITIAL_SETTINGS_DOCUMENT_V2, {
    provider: "text-completion",
    baseUrl: `${origin}/v1`,
    model: "test-model",
    apiKeyEnv: null,
    temperature: 0.7,
    maxTokens: 96,
    systemPrompt: "Write plain prose.",
    contextWindow: 8_192
  });
  const model = base.models[base.profiles.default!.modelId]!;
  return {
    ...base,
    connections: {
      ...base.connections,
      [model.connectionId]: {
        ...base.connections[model.connectionId]!,
        preset,
        protocol: "text-completions",
        textPromptFormat,
        allowInsecureHttp: true
      }
    }
  };
}

interface ProviderRequest {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

async function providerRequest(request: IncomingMessage): Promise<ProviderRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return {
    path: request.url ?? "",
    body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
  };
}

async function listen(t: test.TestContext, server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture server did not expose a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text;
}

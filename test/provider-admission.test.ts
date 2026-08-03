import assert from "node:assert/strict";
import test from "node:test";
import type { PromptOperation, PromptPlan } from "../shared/prompt-plan.js";
import type { GenerationSettings } from "../shared/types.js";
import { GenerationResultError } from "../server/errors.js";
import { streamModel } from "../server/generation-stream.js";
import { ProviderError, streamCompletion } from "../server/providers.js";
import {
  createPromptCacheRequest,
  PromptCacheRuntime,
  type PromptCacheContext
} from "../server/provider-cache-policy.js";

test("provider admission is recorded only immediately before a real fetch", async () => {
  let admissions = 0;
  await drain(streamCompletion(settings("dry-run"), prompt("continue"), new AbortController().signal,
    { providerStarted: () => { admissions += 1; } }));
  assert.equal(admissions, 0);

  await assert.rejects(drain(streamCompletion(
    settings("openai-compatible", { baseUrl: "" }), prompt("continue"), new AbortController().signal,
    { providerStarted: () => { admissions += 1; } }
  )), ProviderError);
  assert.equal(admissions, 0);

  await assert.rejects(drain(streamCompletion(
    settings("openai-compatible", { baseUrl: "not a url" }), prompt("continue"),
    new AbortController().signal, { providerStarted: () => { admissions += 1; } }
  )), ProviderError);
  assert.equal(admissions, 0);

  await assert.rejects(drain(streamCompletion(
    settings("anthropic", { baseUrl: "https://api.anthropic.com", apiKeyEnv: "AI_1667_TEST_MISSING_KEY" }),
    prompt("continue"), new AbortController().signal, { providerStarted: () => { admissions += 1; } }
  )), ProviderError);
  assert.equal(admissions, 0);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("fixture fetch failure"); };
  try {
    await assert.rejects(drain(streamCompletion(
      settings("openai-compatible", { baseUrl: "https://fixture.invalid/v1" }),
      prompt("continue"), new AbortController().signal, { providerStarted: () => { admissions += 1; } }
    )), ProviderError);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(admissions, 1);
});

test("cache rolling state advances only with provider admission", async () => {
  const runtime = new PromptCacheRuntime({ countOpenAiTokens: () => 1_024 });
  const cacheContext: PromptCacheContext = {
    source: "settings-v2",
    policy: "auto",
    support: "supported",
    protocol: "openai-chat-completions",
    preset: "openai",
    remoteModelId: "gpt-5.6",
    adapter: "openai-official"
  };
  const stablePrompt: PromptPlan = {
    operation: "continue",
    turns: [{
      role: "user",
      blocks: [
        {
          stability: "stable",
          kind: "source",
          text: "stable story",
          boundaryAfter: "candidate"
        },
        {
          stability: "volatile",
          kind: "request",
          text: "continue",
          boundaryAfter: "none"
        }
      ]
    }]
  };
  const cache = createPromptCacheRequest(runtime, cacheContext, "story", "continue");
  await assert.rejects(
    drain(streamCompletion(
      settings("openai-compatible", { baseUrl: "" }),
      stablePrompt,
      new AbortController().signal,
      { promptCache: cache }
    )),
    ProviderError
  );
  assert.equal(runtime.registrySize, 0);

  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    requestBody = await input.clone().json() as Record<string, unknown>;
    return new Response("data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" }
    });
  }) as typeof fetch;
  try {
    await drain(streamCompletion(
      settings("openai-compatible", {
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.6"
      }),
      stablePrompt,
      new AbortController().signal,
      { promptCache: cache }
    ));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(runtime.registrySize, 1);
  assert.equal(requestBody?.prompt_cache_key, cache.scope);
  assert.deepEqual(requestBody?.prompt_cache_options, { mode: "explicit" });
  assert.match(JSON.stringify(requestBody), /"prompt_cache_breakpoint":\{"mode":"explicit"\}/);

  const unavailableTokenizer = new PromptCacheRuntime({
    countOpenAiTokens: () => null
  });
  const conservativeCache = createPromptCacheRequest(
    unavailableTokenizer,
    cacheContext,
    "short-story",
    "continue"
  );
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    requestBody = await input.clone().json() as Record<string, unknown>;
    return new Response("data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" }
    });
  }) as typeof fetch;
  try {
    await drain(streamCompletion(
      settings("openai-compatible", {
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.6"
      }),
      stablePrompt,
      new AbortController().signal,
      { promptCache: conservativeCache }
    ));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(unavailableTokenizer.registrySize, 0);
  assert.equal(requestBody.prompt_cache_key, conservativeCache.scope);
  assert.deepEqual(requestBody.prompt_cache_options, { mode: "explicit" });
  assert.equal(JSON.stringify(requestBody).includes("prompt_cache_breakpoint"), false);
});

test("provider cancellation after admission returns a terminal null result", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let admissions = 0;
  globalThis.fetch = (async (input, init) => {
    const signal = input instanceof Request ? input.signal : init?.signal;
    if (signal?.aborted) throw signal.reason;
    return await new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;
  try {
    const result = await streamModel(
      settings("openai-compatible", { baseUrl: "https://fixture.invalid/v1" }),
      prompt("continue"), controller.signal, () => {},
      { providerStarted: () => { admissions += 1; controller.abort(); } }
    );
    assert.equal(result, null);
    assert.equal(admissions, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cancellation during the final filtered delta returns no result", async () => {
  const controller = new AbortController();
  const output = {
    push: () => "",
    finish: () => "filtered tail"
  };

  const result = await streamModel(
    settings("dry-run"),
    prompt("title"),
    controller.signal,
    () => {
      controller.abort();
      throw new Error("The response transport closed.");
    },
    { output }
  );
  assert.equal(result, null);
});

test("an empty completed provider stream is a terminal generation result", async () => {
  const originalFetch = globalThis.fetch;
  let admissions = 0;
  globalThis.fetch = (async () => new Response("data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" }
  })) as typeof fetch;
  try {
    await assert.rejects(
      streamModel(
        settings("openai-compatible", { baseUrl: "https://fixture.invalid/v1" }),
        prompt("continue"),
        new AbortController().signal,
        () => {},
        { providerStarted: () => { admissions += 1; } }
      ),
      GenerationResultError
    );
    assert.equal(admissions, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function drain(stream: AsyncGenerator<string>): Promise<void> {
  for await (const _delta of stream) { /* drain */ }
}

function settings(
  provider: GenerationSettings["provider"],
  overrides: Partial<GenerationSettings> = {}
): GenerationSettings {
  return {
    provider,
    baseUrl: "",
    model: "fixture",
    apiKeyEnv: null,
    temperature: null,
    maxTokens: 16,
    systemPrompt: "fixture",
    contextWindow: null,
    ...overrides
  };
}

function prompt(operation: PromptOperation): PromptPlan {
  return {
    operation,
    turns: [{
      role: "user",
      blocks: [{
        stability: "volatile",
        kind: "request",
        text: operation,
        boundaryAfter: "none"
      }]
    }]
  };
}

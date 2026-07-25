import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { discoverProviderModels } from "../server/model-discovery.js";
import { decodeModelDiscoveryResult } from "../shared/settings-response-decoder.js";
import {
  attachProviderRuntime,
  providerRuntimeFor,
  type ProviderRuntime
} from "../server/provider-runtime.js";
import type { SettingsPresetV2 } from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";

test("LM Studio discovery uses its native model metadata", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    assert.equal(input.url, "https://models.example/api/v0/models");
    return Response.json({
      data: [{
        id: "loaded-model",
        name: "Loaded Model",
        loaded_context_length: 8_192,
        max_context_length: 131_072
      }]
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await discoverProviderModels(
    settings("lm-studio"),
    () => new Date("2026-07-24T00:00:00.000Z")
  );

  assert.deepEqual(result, {
    observedAt: "2026-07-24T00:00:00.000Z",
    models: [{
      remoteId: "loaded-model",
      name: "Loaded Model",
      contextWindow: 8_192,
      maxOutputTokens: null,
      source: "lm-studio-models"
    }]
  });
});

test("LM Studio discovery does not treat an unloaded model maximum as allocated context", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    data: [{
      id: "unloaded-model",
      name: "Unloaded Model",
      max_context_length: 131_072
    }]
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await discoverProviderModels(settings("lm-studio"));

  assert.equal(result.models[0]?.contextWindow, null);
});

test("Ollama discovery deduplicates and bounds native tags", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    assert.equal(input.url, "https://models.example/api/tags");
    return Response.json({
      models: [
        { model: "qwen3:latest", name: "Qwen 3" },
        { model: "qwen3:latest", name: "Duplicate" },
        { name: "gemma3:latest" }
      ]
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await discoverProviderModels(settings("ollama"));

  assert.deepEqual(
    result.models.map(({ remoteId, name, source }) => ({ remoteId, name, source })),
    [
      { remoteId: "qwen3:latest", name: "Qwen 3", source: "ollama-tags" },
      { remoteId: "gemma3:latest", name: "gemma3:latest", source: "ollama-tags" }
    ]
  );
});

test("generic discovery accepts a bounded unpaginated provider catalog", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    data: [{ id: "catalog-model", name: "Catalog Model" }],
    padding: "x".repeat(1_100_000)
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await discoverProviderModels(settings("openrouter"));

  assert.equal(result.models[0]?.remoteId, "catalog-model");
});

test("discovery rejects malformed provider catalog envelopes", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    models: []
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    discoverProviderModels(settings("custom")),
    /invalid openai-models catalog/
  );
});

test("discovery rejects malformed UTF-8 instead of rewriting model IDs", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(Buffer.concat([
    Buffer.from('{"data":[{"id":"'),
    Buffer.from([0xff]),
    Buffer.from('"}]}')
  ]))) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    discoverProviderModels(settings("custom")),
    /malformed UTF-8 provider JSON/
  );
});

test("discovery skips overlong model IDs without rewriting identity", async (t) => {
  const overlong = "x".repeat(513);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    data: [
      { id: overlong },
      { id: "exact-model-id" }
    ]
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await discoverProviderModels(settings("custom"));

  assert.deepEqual(result.models.map((model) => model.remoteId), ["exact-model-id"]);
});

test("discovery skips model IDs that cannot round-trip through settings", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    data: [
      { id: "\ud800" },
      { id: "e\u0301" },
      { id: " model-with-spaces " },
      { id: "é" }
    ]
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  assert.deepEqual(
    (await discoverProviderModels(settings("custom"))).models
      .map((model) => model.remoteId),
    ["é"]
  );
});

test("discovery falls back from display names that cannot round-trip", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    data: [
      { id: "empty-name", name: "" },
      { id: "non-nfc-name", name: "e\u0301" },
      { id: "surrogate-name", display_name: "\ud800" },
      { id: "valid-name", display_name: "Valid Name" }
    ]
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  assert.deepEqual(
    (await discoverProviderModels(settings("custom"))).models
      .map(({ remoteId, name }) => ({ remoteId, name })),
    [
      { remoteId: "empty-name", name: "empty-name" },
      { remoteId: "non-nfc-name", name: "non-nfc-name" },
      { remoteId: "surrogate-name", name: "surrogate-name" },
      { remoteId: "valid-name", name: "Valid Name" }
    ]
  );
});

test("discovery metadata stays within the durable settings scalar limit", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    data: [
      {
        id: "bounded",
        context_length: 1_000_000_000,
        max_output_tokens: 1_000_000_000
      },
      {
        id: "over-limit",
        context_length: 1_000_000_001,
        max_output_tokens: Number.MAX_SAFE_INTEGER
      }
    ]
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await discoverProviderModels(settings("custom"));

  assert.deepEqual(
    result.models.map(({ contextWindow, maxOutputTokens }) => ({
      contextWindow,
      maxOutputTokens
    })),
    [
      {
        contextWindow: 1_000_000_000,
        maxOutputTokens: 1_000_000_000
      },
      { contextWindow: null, maxOutputTokens: null }
    ]
  );
});

test("discovery bounds extracted models after filtering invalid catalog entries", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    data: [
      ...Array.from({ length: 256 }, () => ({ id: "x".repeat(513) })),
      ...Array.from({ length: 300 }, (_, index) => ({ id: `valid-${index}` }))
    ]
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await discoverProviderModels(settings("custom"));

  assert.equal(result.models.length, 256);
  assert.equal(result.models[0]?.remoteId, "valid-0");
  assert.equal(result.models.at(-1)?.remoteId, "valid-255");
});

test("discovery translates a body-phase total deadline", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    return new Response(new ReadableStream({
      start(controller) {
        input.signal.addEventListener("abort", () => controller.error(input.signal.reason), {
          once: true
        });
      }
    }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const base = settings("custom");
  const configured = attachProviderRuntime(base, {
    ...providerRuntimeFor(base),
    timeouts: {
      responseHeaderMs: 20,
      firstTokenMs: 20,
      idleMs: 20,
      totalMs: 30
    }
  }, true);

  await assert.rejects(
    discoverProviderModels(configured),
    /exceeded its configured deadline/
  );
});

test("discovery propagates caller cancellation", async (t) => {
  const originalFetch = globalThis.fetch;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    markStarted();
    return await new Promise<Response>((_resolve, reject) => {
      if (input.signal.aborted) {
        reject(input.signal.reason);
        return;
      }
      input.signal.addEventListener("abort", () => reject(input.signal.reason), {
        once: true
      });
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const controller = new AbortController();

  const pending = discoverProviderModels(settings("custom"), undefined, controller.signal);
  await started;
  controller.abort(new Error("caller canceled discovery"));

  await assert.rejects(pending, /caller canceled discovery/);
});

test("discovery reports authentication failure without exposing resolved secrets", async (t) => {
  process.env.AI_1667_DISCOVERY_SECRET = "discovery-canary";
  t.after(() => { delete process.env.AI_1667_DISCOVERY_SECRET; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    assert.equal(input.headers.get("authorization"), "Bearer discovery-canary");
    return new Response("discovery-canary was rejected", { status: 401 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const configured = settings("custom");
  const runtime = {
    ...providerRuntimeFor(configured),
    auth: {
      type: "bearer-env" as const,
      env: "AI_1667_DISCOVERY_SECRET"
    }
  };
  await assert.rejects(
    discoverProviderModels(attachProviderRuntime(configured, runtime, true)),
    (error) => error instanceof Error
      && error.message.includes("401")
      && error.message.includes("[REDACTED]")
      && !error.message.includes("discovery-canary")
  );
});

test("successful discovery redacts credentials reflected in model metadata", async (t) => {
  process.env.AI_1667_DISCOVERY_REFLECTION = "reflected-discovery-secret";
  t.after(() => { delete process.env.AI_1667_DISCOVERY_REFLECTION; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    data: [{
      id: "model-reflected-discovery-secret",
      name: "reflected-discovery-secret"
    }]
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const configured = settings("custom");
  const runtime = {
    ...providerRuntimeFor(configured),
    auth: {
      type: "bearer-env" as const,
      env: "AI_1667_DISCOVERY_REFLECTION"
    }
  };
  const result = await discoverProviderModels(
    attachProviderRuntime(configured, runtime, true)
  );

  assert.equal(result.models[0]?.remoteId, "model-[REDACTED]");
  assert.equal(result.models[0]?.name, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(result), /reflected-discovery-secret/);
});

test("successful discovery redacts credentials reflected as numeric metadata", async (t) => {
  process.env.AI_1667_DISCOVERY_NUMERIC_REFLECTION = "8192";
  t.after(() => { delete process.env.AI_1667_DISCOVERY_NUMERIC_REFLECTION; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    data: [{
      id: "numeric-reflection",
      context_length: 8192,
      max_output_tokens: 8192
    }]
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const configured = settings("custom");
  const runtime = {
    ...providerRuntimeFor(configured),
    auth: {
      type: "bearer-env" as const,
      env: "AI_1667_DISCOVERY_NUMERIC_REFLECTION"
    }
  };
  const model = (await discoverProviderModels(
    attachProviderRuntime(configured, runtime, true)
  )).models[0];

  assert.equal(model?.contextWindow, null);
  assert.equal(model?.maxOutputTokens, null);
});

test("Anthropic discovery retains its source-specific input and output limits", async (t) => {
  process.env.AI_1667_ANTHROPIC_DISCOVERY = "anthropic-secret";
  t.after(() => { delete process.env.AI_1667_ANTHROPIC_DISCOVERY; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    assert.equal(input.url, "https://api.anthropic.com/v1/models?limit=256");
    assert.equal(input.headers.get("x-api-key"), "anthropic-secret");
    return Response.json({
      data: [{
        id: "claude-fixture",
        display_name: "Claude Fixture",
        max_input_tokens: 200_000,
        max_tokens: 64_000
      }]
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const base: GenerationSettings = {
    ...settings("anthropic"),
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: "AI_1667_ANTHROPIC_DISCOVERY"
  };
  const configured = attachProviderRuntime(base, {
    ...providerRuntimeFor(base),
    auth: {
      type: "header-env",
      name: "x-api-key",
      env: "AI_1667_ANTHROPIC_DISCOVERY"
    }
  }, true);
  assert.deepEqual((await discoverProviderModels(configured)).models, [{
    remoteId: "claude-fixture",
    name: "Claude Fixture",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    source: "anthropic-models"
  }]);
});

test("keyless plaintext Anthropic discovery omits the transport-forbidden query", async (t) => {
  if (process.platform !== "linux" || typeof process.getuid !== "function") {
    t.skip("owned loopback HTTP is unavailable on this target");
    return;
  }
  const server = createServer((request, response) => {
    assert.equal(request.url, "/v1/models");
    assert.equal(request.headers["anthropic-version"], "2023-06-01");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      data: [{ id: "local-claude", display_name: "Local Claude" }]
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.close(); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test server address");
  const base = settings("anthropic");
  const configured = attachProviderRuntime({
    ...base,
    provider: "anthropic",
    baseUrl: `http://127.0.0.1:${address.port}`
  }, {
    ...providerRuntimeFor(base),
    preset: "custom",
    auth: { type: "none" }
  }, true);

  assert.equal(
    (await discoverProviderModels(configured)).models[0]?.remoteId,
    "local-claude"
  );
});

test("model discovery wire decoder is closed and bounded", () => {
  assert.deepEqual(decodeModelDiscoveryResult({
    observedAt: "2026-07-24T00:00:00.000Z",
    models: [{
      remoteId: "fixture",
      name: "Fixture",
      contextWindow: 8_192,
      maxOutputTokens: null,
      source: "openai-models"
    }]
  }).models[0]?.remoteId, "fixture");
  assert.throws(
    () => decodeModelDiscoveryResult({
      observedAt: "not-a-date",
      models: []
    }),
    /invalid model discovery result/
  );
  assert.throws(
    () => decodeModelDiscoveryResult({
      observedAt: "2026-07-24T00:00:00.000Z",
      models: Array.from({ length: 257 }, () => ({
        remoteId: "fixture",
        name: "Fixture",
        contextWindow: null,
        maxOutputTokens: null,
        source: "openai-models"
      }))
    }),
    /invalid model discovery result/
  );
});

function settings(preset: SettingsPresetV2): GenerationSettings {
  const value: GenerationSettings = {
    provider: "openai-compatible",
    baseUrl: "https://models.example/v1",
    model: "",
    apiKeyEnv: null,
    temperature: 0,
    maxTokens: 128,
    systemPrompt: "Test.",
    contextWindow: null
  };
  return attachProviderRuntime(value, runtimeForPreset(preset), true);
}

function runtimeForPreset(preset: SettingsPresetV2): ProviderRuntime {
  return {
    preset,
    auth: { type: "none" },
    headers: [],
    timeouts: {
      responseHeaderMs: 1_000,
      firstTokenMs: 1_000,
      idleMs: 1_000,
      totalMs: 5_000
    },
    allowInsecureHttp: false,
    effort: "default",
    capabilities: {
      temperature: "supported",
      assistantPrefill: "unknown",
      reasoningEffort: "unknown",
      promptCaching: "unknown"
    }
  };
}

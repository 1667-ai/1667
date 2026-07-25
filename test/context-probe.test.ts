import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { probeContextWindow } from "../server/context-probe.js";
import { ownedLoopbackHttpSupported } from "../server/provider-fetch.js";
import {
  attachProviderRuntime,
  type ProviderRuntime
} from "../server/provider-runtime.js";
import type { SettingsPresetV2 } from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";

test("LM Studio context probe uses only loaded native context", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    assert.equal(input.url, "https://models.example/api/v0/models");
    return Response.json({
      data: [{
        id: "fixture",
        loaded_context_length: 4_096,
        max_context_length: 131_072
      }]
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  assert.equal(await probeContextWindow(settings("lm-studio")), 4_096);
});

test("custom context probe stays on the standard models route", async (t) => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async (input) => {
    requests += 1;
    assert.ok(input instanceof Request);
    assert.equal(input.url, "https://models.example/v1/models");
    return Response.json({
      data: [{ id: "fixture", context_length: 16_384 }]
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  assert.equal(await probeContextWindow(settings("custom")), 16_384);
  assert.equal(requests, 1);
});

test("llama.cpp router context probes select the exact HTTPS model", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    if (input.url === "https://models.example/v1/models") {
      return Response.json({
        data: [{
          id: "router/model?variant=1",
          owned_by: "llamacpp"
        }]
      });
    }
    if (input.url === "https://models.example/props") {
      return Response.json(
        { error: { message: "model is required" } },
        { status: 400 }
      );
    }
    assert.equal(
      input.url,
      "https://models.example/props?model=router%2Fmodel%3Fvariant%3D1&autoload=false"
    );
    return Response.json({
      default_generation_settings: { n_ctx: 32_768 }
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  assert.equal(await probeContextWindow({
    ...settings("llama-cpp"),
    model: "router/model?variant=1"
  }), 32_768);
});

test("plaintext llama.cpp context probing uses its modeled query selector", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({
        data: [
          { id: "other", owned_by: "llamacpp" },
          { id: "fixture", owned_by: "llamacpp" }
        ]
      }));
      return;
    }
    assert.equal(request.url, "/props?model=fixture&autoload=false");
    response.end(JSON.stringify({
      default_generation_settings: { n_ctx: 16_384 }
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.close(); });
  const address = server.address() as AddressInfo;

  assert.equal(await probeContextWindow({
    ...settings("llama-cpp"),
    baseUrl: `http://127.0.0.1:${address.port}/v1`
  }), 16_384);
});

test("legacy loopback settings probe backend metadata on a custom port", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    if (request.url === "/api/extra/true_max_context_length") {
      response.end(JSON.stringify({ value: 12_288 }));
      return;
    }
    response.writeHead(404).end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.close(); });
  const address = server.address() as AddressInfo;
  const legacy: GenerationSettings = {
    provider: "openai-compatible",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "fixture",
    apiKeyEnv: null,
    temperature: 0,
    maxTokens: 128,
    systemPrompt: "Test.",
    contextWindow: null
  };

  assert.equal(await probeContextWindow(legacy), 12_288);
});

test("legacy HTTPS settings retain backend-specific probes", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    if (input.url === "https://models.example/v1/models") {
      return Response.json({ data: [] });
    }
    if (input.url === "https://models.example/api/extra/true_max_context_length") {
      return Response.json({ value: 24_576 });
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const legacy: GenerationSettings = {
    provider: "openai-compatible",
    baseUrl: "https://models.example/v1",
    model: "fixture",
    apiKeyEnv: null,
    temperature: 0,
    maxTokens: 128,
    systemPrompt: "Test.",
    contextWindow: null
  };

  assert.equal(await probeContextWindow(legacy), 24_576);
});

test("legacy settings try every native probe despite conventional port guesses", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    if (input.url === "https://models.example:1234/v1/models") {
      return Response.json({
        data: [{ id: "fixture", owned_by: "llamacpp" }]
      });
    }
    if (input.url === "https://models.example:1234/api/v0/models") {
      return Response.json({ data: [] });
    }
    if (input.url === "https://models.example:1234/api/ps") {
      return Response.json({ models: [] });
    }
    if (input.url === "https://models.example:1234/props") {
      return Response.json({
        default_generation_settings: { n_ctx: 30_720 }
      });
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const legacy: GenerationSettings = {
    provider: "openai-compatible",
    baseUrl: "https://models.example:1234/v1",
    model: "fixture",
    apiKeyEnv: null,
    temperature: 0,
    maxTokens: 128,
    systemPrompt: "Test.",
    contextWindow: null
  };

  assert.equal(await probeContextWindow(legacy), 30_720);
});

test("context probes propagate caller cancellation", async (t) => {
  const originalFetch = globalThis.fetch;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    markStarted();
    return await new Promise<Response>((_resolve, reject) => {
      input.signal.addEventListener("abort", () => reject(input.signal.reason), {
        once: true
      });
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const controller = new AbortController();

  const pending = probeContextWindow(settings("custom"), controller.signal);
  await started;
  controller.abort(new Error("caller canceled context probe"));

  await assert.rejects(pending, /caller canceled context probe/);
});

test("malformed preset metadata falls back to manual context entry", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ value: "many" })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  assert.equal(await probeContextWindow(settings("koboldcpp")), null);
});

test("context probes return only durable positive token integers", async (t) => {
  const originalFetch = globalThis.fetch;
  let contextLength: number = 0.5;
  let maximumContextLength: number = 1_000_000_001;
  globalThis.fetch = (async () => Response.json({
    data: [{
      id: "fixture",
      context_length: contextLength,
      max_context_length: maximumContextLength
    }]
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  assert.equal(await probeContextWindow(settings("custom")), null);
  contextLength = 1_000_000_000;
  maximumContextLength = Number.MAX_SAFE_INTEGER;
  assert.equal(await probeContextWindow(settings("custom")), 1_000_000_000);
});

function settings(preset: SettingsPresetV2): GenerationSettings {
  const value: GenerationSettings = {
    provider: "openai-compatible",
    baseUrl: "https://models.example/v1",
    model: "fixture",
    apiKeyEnv: null,
    temperature: 0,
    maxTokens: 128,
    systemPrompt: "Test.",
    contextWindow: null
  };
  const runtime: ProviderRuntime = {
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
  return attachProviderRuntime(value, runtime, true);
}

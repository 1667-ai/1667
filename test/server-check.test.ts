import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { probeContextWindow } from "../server/context-probe.js";
import { providerUrl } from "../server/providers.js";
import {
  checkModelServer,
  MAX_MODEL_SERVER_CHECK_MS
} from "../server/server-check.js";
import { defaultCandidateValidator } from "../server/settings-v2-runtime.js";
import {
  attachProviderRuntime,
  providerRuntimeFor
} from "../server/provider-runtime.js";
import type { SettingsPresetV2 } from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";

test("model server check verifies an authenticated OpenAI-compatible models route", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    assert.equal(input.url, "https://models.example/v1/models");
    assert.equal(input.headers.get("authorization"), "Bearer test-secret");
    return Response.json({ data: [{ id: "test-model" }] });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  process.env.AI_1667_TEST_MODEL_KEY = "test-secret";
  t.after(() => { delete process.env.AI_1667_TEST_MODEL_KEY; });

  const result = await checkModelServer(settings({
    baseUrl: "https://models.example/v1",
    apiKeyEnv: "AI_1667_TEST_MODEL_KEY"
  }));

  assert.equal(result.state, "ready");
  assert.match(result.message, /server is ready/i);
});

test("interactive model checks retain their dedicated short ceiling", () => {
  assert.equal(MAX_MODEL_SERVER_CHECK_MS, 5_000);
});

test("model server checks propagate caller cancellation", async (t) => {
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

  const pending = checkModelServer(
    settings({ baseUrl: "https://models.example/v1" }),
    undefined,
    { signal: controller.signal }
  );
  await started;
  controller.abort(new Error("caller canceled model check"));

  await assert.rejects(pending, /caller canceled model check/);
});

test("model server check distinguishes a reachable server that rejects the request", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(
    { error: { message: "bad key" } },
    { status: 401, statusText: "Unauthorized" }
  )) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await checkModelServer(settings({ baseUrl: "https://models.example/v1" }));

  assert.deepEqual(result, {
    state: "warning",
    message: "Server is reachable, but /models returned 401 Unauthorized: bad key"
  });
});

test("model server check redacts credentials reflected in the HTTP reason phrase", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    "denied",
    { status: 401, statusText: "reason-secret" }
  )) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  process.env.AI_1667_TEST_REASON_KEY = "reason-secret";
  t.after(() => { delete process.env.AI_1667_TEST_REASON_KEY; });

  const result = await checkModelServer(settings({
    baseUrl: "https://models.example/v1",
    apiKeyEnv: "AI_1667_TEST_REASON_KEY"
  }));

  assert.equal(result.state, "warning");
  assert.match(result.message, /401 \[REDACTED\]/);
  assert.doesNotMatch(result.message, /reason-secret/);
});

test("model server check uses the Anthropic models route and headers", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    assert.equal(input.url, "https://api.anthropic.com/v1/models/test-model");
    assert.equal(input.headers.get("x-api-key"), "anthropic-secret");
    assert.equal(input.headers.get("anthropic-version"), "2023-06-01");
    return Response.json({ id: "test-model" });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  process.env.AI_1667_TEST_ANTHROPIC_KEY = "anthropic-secret";
  t.after(() => { delete process.env.AI_1667_TEST_ANTHROPIC_KEY; });

  const result = await checkModelServer(settings({
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: "AI_1667_TEST_ANTHROPIC_KEY"
  }));

  assert.equal(result.state, "ready");
  assert.equal(
    providerUrl(settings({ provider: "anthropic", baseUrl: "https://api.anthropic.com/v1" }), "/v1/messages"),
    "https://api.anthropic.com/v1/messages"
  );
});

test("Anthropic checks accept credentials supplied by custom headers", async (t) => {
  process.env.AI_1667_TEST_ANTHROPIC_CUSTOM_KEY = "custom-anthropic-secret";
  t.after(() => { delete process.env.AI_1667_TEST_ANTHROPIC_CUSTOM_KEY; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    assert.equal(input.headers.get("x-api-key"), "custom-anthropic-secret");
    return Response.json({ id: "test-model" });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const base = settings({
    provider: "anthropic",
    baseUrl: "https://gateway.example",
    apiKeyEnv: null
  });
  const configured = attachProviderRuntime(base, {
    ...providerRuntimeFor(base),
    auth: { type: "none" },
    headers: [{
      name: "x-api-key",
      value: {
        type: "env",
        env: "AI_1667_TEST_ANTHROPIC_CUSTOM_KEY"
      }
    }]
  }, true);

  assert.equal((await checkModelServer(configured)).state, "ready");
});

test("keyless plaintext Anthropic checks omit the transport-forbidden query", async (t) => {
  if (process.platform !== "linux" || typeof process.getuid !== "function") {
    t.skip("owned loopback HTTP is unavailable on this target");
    return;
  }
  const server = createServer((request, response) => {
    assert.equal(request.url, "/v1/models");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "local-claude" }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.close(); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test server address");
  const base = settings({
    provider: "anthropic",
    baseUrl: `http://127.0.0.1:${address.port}`,
    model: "",
    apiKeyEnv: null
  });
  const configured = attachProviderRuntime(base, {
    ...providerRuntimeFor(base),
    auth: { type: "none" }
  }, true);

  assert.equal((await checkModelServer(configured)).state, "ready");
});

test("model server check does not accept an arbitrary successful page", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    "<!doctype html><title>Sign in</title>",
    { headers: { "content-type": "text/html" } }
  )) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await checkModelServer(settings({ baseUrl: "https://models.example/v1" }));

  assert.deepEqual(result, {
    state: "warning",
    message: "Server is reachable, but /models did not return a model list."
  });
});

test("model server check distinguishes a missing configured model", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    data: [{ id: "different-model" }]
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await checkModelServer(settings({
    baseUrl: "https://models.example/v1",
    model: "configured-model"
  }));

  assert.deepEqual(result, {
    state: "warning",
    message: "Server is reachable, but model configured-model was not present in /models."
  });
});

test("model server check never treats a display name as a remote model ID", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    data: [{ id: "canonical/model-id", name: "Configured Model" }]
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await checkModelServer(settings({
    baseUrl: "https://models.example/v1",
    model: "Configured Model"
  }));

  assert.equal(result.state, "warning");
  assert.match(result.message, /was not present/);
});

test("model server check accepts a bounded large provider catalog", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    data: [{ id: "configured-model" }],
    padding: "x".repeat(300_000)
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await checkModelServer(settings({
    baseUrl: "https://openrouter.ai/api/v1",
    model: "configured-model"
  }));

  assert.equal(result.state, "ready");
});

test("candidate activation does not gate a manual model on list membership", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    data: [{ id: "different-model" }]
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  assert.equal(await defaultCandidateValidator(settings({
    baseUrl: "https://models.example/v1",
    model: "configured-model"
  })), true);
});

test("candidate activation treats an unavailable optional catalog as reachable", async (t) => {
  const originalFetch = globalThis.fetch;
  const statuses = [404, 405, 401];
  globalThis.fetch = (async () => new Response("catalog unavailable", {
    status: statuses.shift()!
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const configured = settings({ baseUrl: "https://models.example/v1" });

  assert.equal(await defaultCandidateValidator(configured), true);
  assert.equal(await defaultCandidateValidator(configured), true);
  assert.equal(await defaultCandidateValidator(configured), false);
});

test("model server check keeps a stalled response body as a timeout error", async (t) => {
  const originalFetch = globalThis.fetch;
  const keepEventLoopAlive = setTimeout(() => {}, 1_000);
  t.after(() => clearTimeout(keepEventLoopAlive));
  globalThis.fetch = (async (input, init) => {
    assert.ok(input instanceof Request);
    const signal = init?.signal ?? input.signal;
    return new Response(new ReadableStream({
      start(controller) {
        signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      }
    }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await checkModelServer(settings({ baseUrl: "https://models.example/v1" }), 30);

  assert.equal(result.state, "error");
  assert.match(result.message, /total deadline/);
});

test("model server check clears its header deadline before reading the body", async (t) => {
  const originalFetch = globalThis.fetch;
  let bodyTimer: ReturnType<typeof setTimeout> | null = null;
  globalThis.fetch = (async (input, init) => {
    assert.ok(input instanceof Request);
    const signal = init?.signal ?? input.signal;
    return new Response(new ReadableStream({
      start(controller) {
        bodyTimer = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode('{"data":[{"id":"test-model"}]}'));
          controller.close();
        }, 50);
        signal?.addEventListener("abort", () => controller.error(signal.reason), {
          once: true
        });
      }
    }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (bodyTimer !== null) clearTimeout(bodyTimer);
  });
  const base = settings({ baseUrl: "https://models.example/v1" });
  const configured = attachProviderRuntime(base, {
    ...providerRuntimeFor(base),
    timeouts: {
      responseHeaderMs: 20,
      firstTokenMs: 100,
      idleMs: 100,
      totalMs: 200
    }
  }, true);

  const result = await checkModelServer(configured);

  assert.equal(result.state, "ready");
});

test("model server check reports missing credentials before making a request", async () => {
  delete process.env.AI_1667_TEST_MISSING_KEY;
  const result = await checkModelServer(settings({ apiKeyEnv: "AI_1667_TEST_MISSING_KEY" }));
  assert.equal(result.state, "error");
  assert.match(result.message, /AI_1667_TEST_MISSING_KEY/);
});

test("model server check identifies a failing custom-header credential", async (t) => {
  process.env.AI_1667_TEST_PRESENT_AUTH = "present-secret";
  delete process.env.AI_1667_TEST_MISSING_HEADER;
  t.after(() => { delete process.env.AI_1667_TEST_PRESENT_AUTH; });
  const base = settings({
    baseUrl: "https://models.example/v1",
    apiKeyEnv: null
  });
  const configured = attachProviderRuntime(base, {
    ...providerRuntimeFor(base),
    auth: {
      type: "bearer-env",
      env: "AI_1667_TEST_PRESENT_AUTH"
    },
    headers: [{
      name: "x-tenant-key",
      value: {
        type: "env",
        env: "AI_1667_TEST_MISSING_HEADER"
      }
    }]
  }, true);

  const result = await checkModelServer(configured);

  assert.equal(result.state, "error");
  assert.match(result.message, /AI_1667_TEST_MISSING_HEADER/);
  assert.doesNotMatch(result.message, /AI_1667_TEST_PRESENT_AUTH/);
});

test("context detection accepts LM Studio's only loaded model before model entry", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    if (input.url === "https://models.example/v1/models") {
      return Response.json({ data: [] });
    }
    assert.equal(input.url, "https://models.example/api/v0/models");
    return Response.json({
      data: [
        {
          id: "actual-loaded-model",
          loaded_context_length: 16_384,
          max_context_length: 131_072
        }
      ]
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const contextWindow = await probeContextWindow(settings({
    baseUrl: "https://models.example/v1",
    model: ""
  }, "lm-studio"));

  assert.equal(contextWindow, 16_384);
});

test("context detection rejects a sole loaded model that does not match", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    if (input.url.endsWith("/v1/models")) return Response.json({ data: [] });
    if (input.url.endsWith("/api/v0/models")) {
      return Response.json({
        data: [{ id: "model-b", loaded_context_length: 16_384 }]
      });
    }
    if (input.url.endsWith("/api/ps")) return Response.json({ models: [] });
    return Response.json({});
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const contextWindow = await probeContextWindow(settings({
    baseUrl: "https://models.example/v1",
    model: "model-a"
  }, "lm-studio"));

  assert.equal(contextWindow, null);
});

test("context detection accepts Ollama's implicit latest tag", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    if (input.url.endsWith("/api/ps")) {
      return Response.json({
        models: [{ model: "llama3.2:latest", context_length: 8_192 }]
      });
    }
    return Response.json(input.url.endsWith("/api/v0/models")
      ? { data: [] }
      : {});
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const contextWindow = await probeContextWindow(settings({
    baseUrl: "https://models.example/v1",
    model: "llama3.2"
  }, "ollama"));

  assert.equal(contextWindow, 8_192);
});

test("context detection accepts Ollama's omitted latest tag", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    if (input.url.endsWith("/api/ps")) {
      return Response.json({
        models: [{ model: "llama3.2", context_length: 4_096 }]
      });
    }
    return Response.json(input.url.endsWith("/api/v0/models")
      ? { data: [] }
      : {});
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const contextWindow = await probeContextWindow(settings({
    baseUrl: "https://models.example/v1",
    model: "llama3.2:latest"
  }, "ollama"));

  assert.equal(contextWindow, 4_096);
});

test("context detection uses llama.cpp's allocated props window", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    if (input.url.endsWith("/v1/models")) {
      return Response.json({
        data: [{
          id: "../models/story.gguf",
          owned_by: "llamacpp",
          meta: { n_ctx_train: 131_072 }
        }]
      });
    }
    assert.equal(input.url, "https://models.example/props");
    return Response.json({
      default_generation_settings: { n_ctx: 4_096 }
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const contextWindow = await probeContextWindow(settings({
    baseUrl: "https://models.example/v1",
    model: "../models/story.gguf"
  }, "llama-cpp"));

  assert.equal(contextWindow, 4_096);
});

test("context detection selects the configured llama.cpp router model", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    if (input.url.endsWith("/v1/models")) {
      return Response.json({
        data: [
          { id: "other-model", owned_by: "llamacpp" },
          { id: "org/model:Q4", owned_by: "llamacpp" }
        ]
      });
    }
    assert.equal(
      input.url,
      "https://models.example/props?model=org%2Fmodel%3AQ4&autoload=false"
    );
    return Response.json({
      default_generation_settings: { n_ctx: 12_288 }
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const contextWindow = await probeContextWindow(settings({
    baseUrl: "https://models.example/v1",
    model: "org/model:Q4"
  }, "llama-cpp"));

  assert.equal(contextWindow, 12_288);
});

test("context detection retries a single-model llama.cpp router with its selector", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    if (input.url.endsWith("/v1/models")) {
      return Response.json({
        data: [{ id: "router-model", owned_by: "llamacpp" }]
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
      "https://models.example/props?model=router-model&autoload=false"
    );
    return Response.json({
      default_generation_settings: { n_ctx: 8_192 }
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const contextWindow = await probeContextWindow(settings({
    baseUrl: "https://models.example/v1",
    model: "router-model"
  }, "llama-cpp"));

  assert.equal(contextWindow, 8_192);
});

function settings(
  overrides: Partial<GenerationSettings> = {},
  preset?: SettingsPresetV2
): GenerationSettings {
  const value: GenerationSettings = {
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "test-model",
    apiKeyEnv: null,
    temperature: 0,
    maxTokens: 128,
    systemPrompt: "Test.",
    contextWindow: null,
    ...overrides
  };
  if (preset === undefined) return value;
  return attachProviderRuntime(value, {
    ...providerRuntimeFor(value),
    preset
  }, true);
}

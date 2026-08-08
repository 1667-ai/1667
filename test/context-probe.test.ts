import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { probeContextWindow, probeKoboldCppTokenize } from "../server/context-probe.js";
import { ownedLoopbackHttpSupported } from "../server/provider-fetch.js";
import {
  attachProviderRuntime,
  type ProviderRuntime
} from "../server/provider-runtime.js";
import { EMPTY_SAMPLING_V2, type SettingsPresetV2 } from "../shared/settings-v2-types.js";
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

test("KoboldCpp tokenize probes against the same server never overlap (issue #311 review, round five, blocker)", async (t) => {
  // KoboldCpp's own upstream source documents `/api/extra/tokencount` as
  // answering from a process-global buffer (`static std::vector<int> toks`,
  // expose.cpp) it hands out through a raw pointer — two overlapping
  // requests against the same server can therefore reallocate or overwrite
  // the buffer the other is still reading, quietly returning wrong token
  // ids (server/context-probe.ts, `withKoboldCppTokenCountLock`'s own
  // comment cites the exact source lines). This fixture makes an overlap
  // observable: every request holds `inFlight` up for a fixed delay before
  // answering, so two truly concurrent requests would both be counted at
  // once. The fixture asserts 1667's own assumption about what
  // serialization must look like on the wire — one request in flight at a
  // time against one server root — not a real KoboldCpp server's behavior.
  const originalFetch = globalThis.fetch;
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    assert.equal(input.url, "https://models.example/api/extra/tokencount");
    calls += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight -= 1;
    return Response.json({ value: 1, ids: [1] });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const koboldCpp = settings("koboldcpp");
  await Promise.all([
    probeKoboldCppTokenize(koboldCpp, "alpha"),
    probeKoboldCppTokenize(koboldCpp, "bravo"),
    probeKoboldCppTokenize(koboldCpp, "charlie"),
    probeKoboldCppTokenize(koboldCpp, "delta")
  ]);

  assert.equal(calls, 4);
  assert.equal(maxInFlight, 1, "KoboldCpp tokenize probes against one server must never overlap");
});

test("KoboldCpp tokenize probe serialization is per server root, not global", async (t) => {
  // The lock must not turn two unrelated KoboldCpp servers into one queue —
  // that would slow down a writer running two local KoboldCpp instances (or
  // any two settings values that happen to hit different roots) for no
  // safety reason, since each root's buffer is that server's own process.
  const originalFetch = globalThis.fetch;
  let inFlightByRoot: Record<string, number> = { "https://alpha.example": 0, "https://bravo.example": 0 };
  let overlapped = false;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    const root = new URL(input.url).origin;
    inFlightByRoot[root] = (inFlightByRoot[root] ?? 0) + 1;
    if (Object.values(inFlightByRoot).every((count) => count > 0)) overlapped = true;
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlightByRoot[root] = (inFlightByRoot[root] ?? 0) - 1;
    return Response.json({ value: 1, ids: [1] });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await Promise.all([
    probeKoboldCppTokenize({ ...settings("koboldcpp"), baseUrl: "https://alpha.example/v1" }, "alpha"),
    probeKoboldCppTokenize({ ...settings("koboldcpp"), baseUrl: "https://bravo.example/v1" }, "bravo")
  ]);

  assert.ok(overlapped, "two different KoboldCpp server roots must be free to probe concurrently");
});

test("aborting a queued KoboldCpp tokenize probe rejects promptly without stalling the queue", async (t) => {
  // The per-root lock serializes every call against a KoboldCpp server, so a
  // second call sits queued behind a first that is still in flight. Before
  // this fix, aborting the queued call did nothing until the first call's own
  // turn finished — the queued promise stayed pending the whole time. This
  // reproduces the reported hang: block the first request, queue a second
  // behind it, abort the second, and prove it rejects immediately rather than
  // waiting on the first — and that the abort never reaches fetch, and never
  // stalls a third request queued after it.
  const originalFetch = globalThis.fetch;
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  let firstReleased = false;
  const fetchedTexts: string[] = [];
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    const body = JSON.parse(await input.text()) as { prompt: string };
    fetchedTexts.push(body.prompt);
    if (body.prompt === "first") {
      markFirstStarted();
      await firstBlocked;
      firstReleased = true;
    }
    return Response.json({ value: 1, ids: [1] });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const koboldCpp = settings("koboldcpp");
  const first = probeKoboldCppTokenize(koboldCpp, "first");
  await firstStarted;

  const controller = new AbortController();
  const second = probeKoboldCppTokenize(koboldCpp, "second", controller.signal);
  controller.abort(new Error("caller canceled the queued probe"));

  await assert.rejects(second, /caller canceled the queued probe/);
  assert.ok(!firstReleased, "the queued abort must reject before the first request is released");
  assert.ok(
    !fetchedTexts.includes("second"),
    "an aborted queued probe must never reach the provider"
  );

  const third = probeKoboldCppTokenize(koboldCpp, "third");
  releaseFirst();
  assert.deepEqual(await first, { kind: "ok", ids: [1] });
  assert.deepEqual(await third, { kind: "ok", ids: [1] });
  assert.deepEqual(fetchedTexts, ["first", "third"]);
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
    tokenProbabilities: null,
    sampling: EMPTY_SAMPLING_V2,
    capabilities: {
      temperature: "supported",
      assistantPrefill: "unknown",
      reasoningEffort: "unknown",
      promptCaching: "unknown"
    }
  };
  return attachProviderRuntime(value, runtime, true);
}

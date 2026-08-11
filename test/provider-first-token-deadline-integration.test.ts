import assert from "node:assert/strict";
import test from "node:test";
import { attachProviderRuntime } from "../server/provider-runtime.js";
import { providerSseEvents } from "../server/provider-sse.js";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";

/**
 * Issue #127: proves the derived prefill-phase deadline
 * (server/provider-first-token-deadline.ts) is actually wired into
 * server/provider-sse.ts's two setPhaseTimer calls it feeds — the
 * response-header phase and the first-token phase — not merely correct in
 * isolation. See that module's own arithmetic tests
 * (test/provider-first-token-deadline.test.ts). Every configured timeout and
 * every fake-server delay here is a handful of milliseconds, never the real
 * 120 s/30 min production defaults, so this suite stays fast.
 *
 * Review finding: a first pass here only delayed the SSE *stream* and left
 * `fetch` itself resolving immediately, so it only ever exercised the
 * first-token phase. `providerFetch` does not resolve until response
 * headers arrive, and a server can prefill before flushing headers just as
 * easily as after — this program has no way to see which side of that a
 * given server lands on. The first test below delays the fetch's own
 * settlement instead, to prove the header phase scales too.
 */

test("a large request body survives a slow header response that still fails a small one, under the same tiny configured deadline", async (t) => {
  const originalFetch = globalThis.fetch;
  const DELAY_MS = 200;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    return await new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve(new Response(
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } }
        ));
      }, DELAY_MS);
      // A deadline firing aborts the request signal before fetch would ever
      // settle on its own; a real fetch/undici call rejects its own pending
      // promise on that same signal, so the fake one has to be told to do
      // the same or it would just wait the delay out regardless of any
      // deadline, proving nothing about either.
      input.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(input.signal.reason);
      }, { once: true });
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  // Tiny on purpose (issue #127's ask): with the old flat constant this
  // configured value alone would decide the deadline, and both requests
  // below would fail identically regardless of body size.
  const settings = fixtureSettings({
    responseHeaderMs: 10,
    firstTokenMs: 5_000,
    idleMs: 5_000,
    totalMs: 10_000
  });

  // A near-empty body (2 bytes) derives to ~25 ms of allowance — still well
  // under the 200 ms header delay, so this request fails exactly as the
  // flat constant always would have.
  await assert.rejects(
    drain(providerSseEvents(
      settings,
      "https://models.example/v1/chat/completions",
      {},
      {},
      [],
      new AbortController().signal,
      (value) => value,
      undefined,
      undefined,
      (event) => event !== "[DONE]",
      (event) => event === "[DONE]"
    )),
    /did not return response headers/
  );

  // A ~300 byte body derives to ~3.8 s of allowance — comfortably past the
  // 200 ms header delay, so this request now survives the header wait where
  // the flat 10 ms constant would have failed it too.
  await drain(providerSseEvents(
    settings,
    "https://models.example/v1/chat/completions",
    { p: "x".repeat(300) },
    {},
    [],
    new AbortController().signal,
    (value) => value,
    undefined,
    undefined,
    (event) => event !== "[DONE]",
    (event) => event === "[DONE]"
  ));
});

test("a large request body survives a delay that still fails a small one, under the same tiny configured deadline", async (t) => {
  const originalFetch = globalThis.fetch;
  const DELAY_MS = 200;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    return new Response(new ReadableStream({
      start(controller) {
        const timer = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'
          ));
          controller.close();
        }, DELAY_MS);
        // A deadline firing aborts the request signal; a real fetch/undici
        // stream would reject its pending read on its own, so the fake one
        // has to be told to do the same or it would just wait the delay out
        // regardless of any deadline, proving nothing about either.
        input.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          controller.error(input.signal.reason);
        }, { once: true });
      }
    }), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  // Tiny on purpose (issue #127's ask): with the old flat constant this
  // configured value alone would decide the deadline, and both requests
  // below would fail identically regardless of body size.
  const settings = fixtureSettings({
    responseHeaderMs: 5_000,
    firstTokenMs: 10,
    idleMs: 5_000,
    totalMs: 10_000
  });

  // A near-empty body (2 bytes) derives to ~25 ms of allowance — still well
  // under the 200 ms delay, so this request fails exactly as the flat
  // constant always would have.
  await assert.rejects(
    drain(providerSseEvents(
      settings,
      "https://models.example/v1/chat/completions",
      {},
      {},
      [],
      new AbortController().signal,
      (value) => value,
      undefined,
      undefined,
      (event) => event !== "[DONE]",
      (event) => event === "[DONE]"
    )),
    /did not produce stream activity/
  );

  // A ~300 byte body derives to ~3.8 s of allowance — comfortably past the
  // 200 ms delay, so this request now survives where the flat 10 ms
  // constant would have failed it too.
  await drain(providerSseEvents(
    settings,
    "https://models.example/v1/chat/completions",
    { p: "x".repeat(300) },
    {},
    [],
    new AbortController().signal,
    (value) => value,
    undefined,
    undefined,
    (event) => event !== "[DONE]",
    (event) => event === "[DONE]"
  ));
});

test("a server that never responds still fails within a bounded derived deadline", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    return new Response(new ReadableStream({
      start(controller) {
        input.signal.addEventListener("abort", () => controller.error(input.signal.reason), {
          once: true
        });
      }
    }), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const settings = fixtureSettings({
    responseHeaderMs: 5_000,
    // Tiny configured floor: without the derivation this would be the whole
    // deadline. With it, a ~30 byte body still derives to only ~375 ms —
    // small, but finite, and that is exactly what this test checks.
    firstTokenMs: 10,
    idleMs: 5_000,
    totalMs: 10_000
  });

  const startedAt = Date.now();
  await assert.rejects(
    drain(providerSseEvents(
      settings,
      "https://models.example/v1/chat/completions",
      { p: "x".repeat(20) },
      {},
      [],
      new AbortController().signal,
      (value) => value,
      undefined,
      undefined,
      (event) => event !== "[DONE]",
      (event) => event === "[DONE]"
    )),
    /did not produce stream activity/
  );
  // Bounded, not unbounded: the request fails on its own, well inside this
  // suite's own timeout, with no event and no cancellation ever arriving
  // from the caller side to force it.
  assert.ok(Date.now() - startedAt < 5_000);
});

async function drain(stream: AsyncIterable<string>): Promise<void> {
  for await (const _chunk of stream) {
    // Drain.
  }
}

function fixtureSettings(timeouts: {
  readonly responseHeaderMs: number;
  readonly firstTokenMs: number;
  readonly idleMs: number;
  readonly totalMs: number;
}): GenerationSettings {
  return attachProviderRuntime({
    provider: "openai-compatible",
    baseUrl: "https://models.example/v1",
    model: "fixture",
    apiKeyEnv: null,
    temperature: 0,
    maxTokens: 128,
    systemPrompt: "Test.",
    contextWindow: null
  }, {
    preset: "custom",
    auth: { type: "none" },
    headers: [],
    timeouts,
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
  }, true);
}

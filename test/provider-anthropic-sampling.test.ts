import assert from "node:assert/strict";
import test from "node:test";
import { forgetRefusedSampling, streamCompletion } from "../server/providers.js";
import {
  attachProviderRuntime,
  providerErrorSummary
} from "../server/provider-runtime.js";
import type { PromptPlan } from "../shared/prompt-plan.js";
import {
  EMPTY_SAMPLING_V2,
  type SamplingSettingsV2
} from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";

/** The body api.anthropic.com returns for a model that dropped sampling. */
const DEPRECATED_TEMPERATURE = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "`temperature` is deprecated for this model."
  },
  request_id: "req_fixture"
});

const PROMPT: PromptPlan = {
  operation: "continue",
  turns: [
    {
      role: "system",
      blocks: [{
        stability: "stable",
        kind: "author-brief",
        text: "Write with restraint.",
        boundaryAfter: "candidate"
      }]
    },
    {
      role: "user",
      blocks: [{
        stability: "volatile",
        kind: "request",
        text: "Continue.",
        boundaryAfter: "none"
      }]
    }
  ]
};

test("Anthropic generation recovers from a model that rejects temperature", async (t) => {
  const originalFetch = globalThis.fetch;
  forgetRefusedSampling();
  t.after(() => { forgetRefusedSampling(); });
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    bodies.push(JSON.parse(await input.text()) as Record<string, unknown>);
    if (bodies.length === 1) {
      return new Response(DEPRECATED_TEMPERATURE, {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(
      [
        "event: content_block_delta",
        `data: ${JSON.stringify({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "the lantern" }
        })}`,
        "",
        "event: message_stop",
        `data: ${JSON.stringify({ type: "message_stop" })}`,
        "",
        ""
      ].join("\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const chunks: string[] = [];
  for await (const chunk of streamCompletion(
    anthropicSettings(),
    PROMPT,
    new AbortController().signal
  )) {
    chunks.push(chunk);
  }

  assert.equal(chunks.join(""), "the lantern");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0]?.temperature, 0.8);
  assert.equal("temperature" in (bodies[1] ?? {}), false);

  // The refusal is paid once. A second generation against the same model skips
  // the parameter outright rather than spending another rejected request, and
  // the writer's stored temperature is never touched to achieve it.
  for await (const _ of streamCompletion(
    anthropicSettings(),
    PROMPT,
    new AbortController().signal
  )) { /* drained */ }
  assert.equal(bodies.length, 3);
  assert.equal("temperature" in (bodies[2] ?? {}), false);
});

test("a sampling value the model merely bounds is the writer's to see", async (t) => {
  const originalFetch = globalThis.fetch;
  forgetRefusedSampling();
  t.after(() => { forgetRefusedSampling(); });
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "temperature: must be between 0 and 1"
        }
      }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  // Naming the parameter is not the same as refusing it. Retrying without a
  // temperature here would quietly generate at a setting nobody chose.
  await assert.rejects(async () => {
    for await (const _ of streamCompletion(
      anthropicSettings(),
      PROMPT,
      new AbortController().signal
    )) { /* the first response never yields */ }
  }, /must be between 0 and 1/u);
  assert.equal(requests, 1);
});

test("a rejected parameter this request did not send is not retried", async (t) => {
  const originalFetch = globalThis.fetch;
  forgetRefusedSampling();
  t.after(() => { forgetRefusedSampling(); });
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return new Response(
      JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "max_tokens: too large" }
      }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(async () => {
    for await (const _ of streamCompletion(
      { ...anthropicSettings(), temperature: null },
      PROMPT,
      new AbortController().signal
    )) { /* the first response never yields */ }
  });
  assert.equal(requests, 1);
});

test("a rejected sampling parameter is never removed for an Anthropic retry", async (t) => {
  const originalFetch = globalThis.fetch;
  forgetRefusedSampling();
  t.after(() => { forgetRefusedSampling(); });
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    bodies.push(JSON.parse(await input.text()) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "`top_p` is not supported for this model."
        }
      }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(async () => {
    for await (const _ of streamCompletion(
      anthropicSettings({
        ...EMPTY_SAMPLING_V2,
        topP: 0.8
      }, "claude-opus-4-5"),
      PROMPT,
      new AbortController().signal
    )) { /* the first response never yields */ }
  }, /top_p.*not supported/u);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]?.top_p, 0.8);
});

test("a provider error reads as its own sentence, not as its envelope", () => {
  assert.equal(
    providerErrorSummary(DEPRECATED_TEMPERATURE),
    "`temperature` is deprecated for this model."
  );
  // OpenAI states the same kind of reason under the same key.
  assert.equal(
    providerErrorSummary(JSON.stringify({
      error: {
        message: "Unsupported value: 'temperature' does not support 0.8 with this model.",
        type: "invalid_request_error",
        param: "temperature",
        code: "unsupported_value"
      }
    })),
    "Unsupported value: 'temperature' does not support 0.8 with this model."
  );
  // A body that states nothing readable still arrives as one bounded line.
  const wall = providerErrorSummary(`<html>\n  <body>${"gateway ".repeat(80)}</body>\n</html>`);
  assert.equal(wall.includes("\n"), false);
  assert.ok(wall.length <= 160);
});

function anthropicSettings(
  sampling: SamplingSettingsV2 = EMPTY_SAMPLING_V2,
  model = "claude-fixture"
): GenerationSettings {
  return attachProviderRuntime({
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model,
    apiKeyEnv: null,
    temperature: 0.8,
    maxTokens: 256,
    systemPrompt: "unused by prompt-plan lowering",
    contextWindow: null
  }, {
    preset: "anthropic",
    auth: { type: "none" },
    headers: [],
    timeouts: {
      responseHeaderMs: 5_000,
      firstTokenMs: 5_000,
      idleMs: 5_000,
      totalMs: 10_000
    },
    allowInsecureHttp: false,
    effort: "default",
    sampling,
    capabilities: {
      temperature: "supported",
      assistantPrefill: "unknown",
      reasoningEffort: "unknown",
      promptCaching: "unknown"
    }
  }, true);
}

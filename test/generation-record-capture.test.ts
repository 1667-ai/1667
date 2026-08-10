import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { attachProviderRuntime, resolveProviderHeaders } from "../server/provider-runtime.js";
import { ownedLoopbackHttpSupported } from "../server/provider-fetch.js";
import {
  forgetRefusedSampling,
  forgetRefusedTokenProbabilities,
  streamCompletion,
  type GenerationRecordCollector
} from "../server/providers.js";
import {
  ANTHROPIC_MESSAGES_EFFECTIVE_FIELDS,
  createGenerationRecordCapture,
  OPENAI_CHAT_EFFECTIVE_FIELDS,
  snapshotEffectiveFields,
  TEXT_COMPLETION_EFFECTIVE_FIELDS
} from "../server/generation-record-capture.js";
import type { PromptPlan } from "../shared/prompt-plan.js";
import { EMPTY_SAMPLING_V2, type SettingsPresetV2 } from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";

/**
 * Generation Records' provider-capture seams (server/generation-record-
 * capture.ts): the effective wire parameters actually sent, and the
 * distinction between a field this request itself watched a provider reject
 * and retried around (stage "retry") versus a field skipped only because an
 * earlier request already learned this model refuses it (stage
 * "construction", action "skipped-cached-refusal"). Mirrors the same
 * loopback-server pattern as test/token-probability-request.test.ts.
 */

const providerTest = ownedLoopbackHttpSupported() ? test : test.skip;

const PROMPT: PromptPlan = {
  operation: "continue",
  turns: [{
    role: "user",
    blocks: [{ stability: "volatile", kind: "request", text: "Continue.", boundaryAfter: "none" }]
  }]
};

test("effective settings include every safe scalar sampler and exclude structured request data", () => {
  const body = {
    model: "model-fixture",
    messages: [{ role: "user", content: "secret prompt" }],
    temperature: 0.4,
    min_p: 0.05,
    repeat_penalty: 1.1,
    dry_multiplier: 0.8,
    xtc_probability: 0.2,
    mirostat_mode: 2,
    stop: ["private stop"],
    logit_bias: { "42": -3 },
    stream: true
  };
  assert.deepEqual(snapshotEffectiveFields(body, OPENAI_CHAT_EFFECTIVE_FIELDS), [
    { field: "temperature", value: 0.4 },
    { field: "min_p", value: 0.05 },
    { field: "repeat_penalty", value: 1.1 },
    { field: "dry_multiplier", value: 0.8 },
    { field: "xtc_probability", value: 0.2 },
    { field: "mirostat_mode", value: 2 },
    { field: "stream", value: true }
  ]);
  assert.deepEqual(snapshotEffectiveFields({
    max_tokens: 100,
    output_config: { effort: "high" },
    system: "private system prompt"
  }, ANTHROPIC_MESSAGES_EFFECTIVE_FIELDS), [
    { field: "max_tokens", value: 100 },
    { field: "output_config.effort", value: "high" }
  ]);
  assert.deepEqual(snapshotEffectiveFields({
    rep_pen: 1.2,
    sampler_seed: 7,
    dry_penalty_last_n: 512,
    prompt: "private text prompt"
  }, TEXT_COMPLETION_EFFECTIVE_FIELDS), [
    { field: "rep_pen", value: 1.2 },
    { field: "sampler_seed", value: 7 },
    { field: "dry_penalty_last_n", value: 512 }
  ]);
});

providerTest("a 400 naming max_tokens is recorded as a retry-stage adjustment, not a cached skip", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as Record<string, unknown>;
    requests.push(body);
    if ("max_tokens" in body) {
      rejectUnsupported(response, "max_tokens");
      return;
    }
    respondOk(response, "ok");
  });
  await listen(server);
  t.after(() => closeServer(server));

  const collector: GenerationRecordCollector = { effective: null };
  const settings = fixtureSettings("openai-compatible", { baseUrl: baseUrlFor(server) });
  const text = await collect(streamCompletion(settings, PROMPT, new AbortController().signal, {
    generationRecord: collector
  }));
  assert.equal(text, "ok");
  assert.equal(requests.length, 2, "one rejected attempt, one retry");

  const effective = collector.effective;
  if (effective === null) throw new Error("expected an effective-parameters snapshot");
  assert.equal(effective.wireProtocol, "openai-chat-completions");
  assert.equal(effective.fields.some((field) => field.field === "max_tokens"), false);
  assert.ok(effective.fields.some((field) => field.field === "max_completion_tokens"));
  assert.deepEqual(
    effective.adjustments.filter((adjustment) => adjustment.stage === "construction"),
    []
  );
  const dropped = effective.adjustments.find(
    (adjustment) => adjustment.stage === "retry" && adjustment.field === "max_tokens"
  );
  const added = effective.adjustments.find(
    (adjustment) => adjustment.stage === "retry" && adjustment.field === "max_completion_tokens"
  );
  assert.equal(dropped?.action, "dropped");
  assert.equal(dropped?.attempt, 0);
  assert.equal(added?.action, "added");
  assert.equal(added?.attempt, 0);
});

providerTest("a second request against a model that already refused logprobs records a construction-stage skip, not a retry", async (t) => {
  forgetRefusedTokenProbabilities();
  t.after(() => forgetRefusedTokenProbabilities());
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as Record<string, unknown>;
    requests.push(body);
    if ("top_logprobs" in body) {
      rejectUnsupported(response, "top_logprobs");
      return;
    }
    respondOk(response, "ok");
  });
  await listen(server);
  t.after(() => closeServer(server));

  const settings = fixtureSettings("openai-compatible", {
    baseUrl: baseUrlFor(server),
    tokenProbabilities: 5,
    // "custom" deliberately never sends logprobs (preset-unknown, shared/
    // token-probability-capabilities.ts) — this test needs a preset the
    // capability matrix actually resolves to "available".
    preset: "openai"
  });
  const firstCollector: GenerationRecordCollector = { effective: null };
  await collect(streamCompletion(settings, PROMPT, new AbortController().signal, {
    generationRecord: firstCollector
  }));
  assert.equal(requests.length, 2, "one rejected attempt, one retry");
  const firstAdjustments = firstCollector.effective?.adjustments ?? [];
  assert.ok(firstAdjustments.some((adjustment) =>
    adjustment.stage === "retry" && adjustment.field === "logprobs" && adjustment.action === "dropped"));

  const secondCollector: GenerationRecordCollector = { effective: null };
  const text = await collect(streamCompletion(settings, PROMPT, new AbortController().signal, {
    generationRecord: secondCollector
  }));
  assert.equal(text, "ok");
  assert.equal(requests.length, 3, "the second generation cost exactly one request");

  const effective = secondCollector.effective;
  if (effective === null) throw new Error("expected an effective-parameters snapshot");
  assert.equal(effective.fields.some((field) => field.field === "logprobs" || field.field === "top_logprobs"), false);
  assert.deepEqual(
    effective.adjustments.filter((adjustment) => adjustment.stage === "retry"),
    []
  );
  const skipped = effective.adjustments.filter((adjustment) => adjustment.stage === "construction");
  assert.ok(skipped.some((adjustment) => adjustment.field === "logprobs" && adjustment.action === "skipped-cached-refusal"));
  assert.ok(skipped.some((adjustment) => adjustment.field === "top_logprobs" && adjustment.action === "skipped-cached-refusal"));
});

providerTest("a request that never asked for logprobs records no cached-skip adjustment for it", async (t) => {
  forgetRefusedTokenProbabilities();
  t.after(() => forgetRefusedTokenProbabilities());
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as Record<string, unknown>;
    requests.push(body);
    if ("top_logprobs" in body) {
      rejectUnsupported(response, "top_logprobs");
      return;
    }
    respondOk(response, "ok");
  });
  await listen(server);
  t.after(() => closeServer(server));

  // "custom" deliberately never sends logprobs (preset-unknown, shared/
  // token-probability-capabilities.ts) — this test needs a preset the
  // capability matrix actually resolves to "available".
  const withProbabilities = fixtureSettings("openai-compatible", {
    baseUrl: baseUrlFor(server),
    tokenProbabilities: 5,
    preset: "openai"
  });
  await collect(streamCompletion(withProbabilities, PROMPT, new AbortController().signal, {
    generationRecord: { effective: null }
  }));
  assert.equal(requests.length, 2, "one rejected attempt, one retry — the model has now refused logprobs");

  // A later request against the same model that never asked for logprobs in
  // the first place has nothing to skip: the field was never in its body.
  const withoutProbabilities = fixtureSettings("openai-compatible", {
    baseUrl: baseUrlFor(server),
    tokenProbabilities: null,
    preset: "openai"
  });
  const collector: GenerationRecordCollector = { effective: null };
  const text = await collect(streamCompletion(withoutProbabilities, PROMPT, new AbortController().signal, {
    generationRecord: collector
  }));
  assert.equal(text, "ok");
  assert.equal(requests.length, 3, "the cached refusal costs no extra request");

  const effective = collector.effective;
  if (effective === null) throw new Error("expected an effective-parameters snapshot");
  const skipped = effective.adjustments.filter((adjustment) => adjustment.stage === "construction");
  assert.deepEqual(skipped, [], "a field this request never sent is not a skip worth recording");
});

providerTest("a request with no temperature set records no cached-skip adjustment for it", async (t) => {
  forgetRefusedSampling();
  t.after(() => forgetRefusedSampling());
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as Record<string, unknown>;
    requests.push(body);
    if ("temperature" in body) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "`temperature` is deprecated for this model." }
      }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      "event: content_block_delta",
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "ok" } })}`,
      "",
      "event: message_stop",
      `data: ${JSON.stringify({ type: "message_stop" })}`,
      "",
      ""
    ].join("\n"));
  });
  await listen(server);
  t.after(() => closeServer(server));

  await collect(streamCompletion(anthropicFixtureSettings(baseUrlFor(server), 0.8), PROMPT, new AbortController().signal, {
    generationRecord: { effective: null }
  }));
  assert.equal(requests.length, 2, "one rejected attempt, one retry — the model has now refused temperature");

  // A later request against the same model that never set a temperature in
  // the first place has nothing to skip: the field was never in its body.
  const collector: GenerationRecordCollector = { effective: null };
  const text = await collect(streamCompletion(anthropicFixtureSettings(baseUrlFor(server), null), PROMPT, new AbortController().signal, {
    generationRecord: collector
  }));
  assert.equal(text, "ok");
  assert.equal(requests.length, 3, "the cached refusal costs no extra request");

  const effective = collector.effective;
  if (effective === null) throw new Error("expected an effective-parameters snapshot");
  const skipped = effective.adjustments.filter((adjustment) => adjustment.stage === "construction");
  assert.deepEqual(skipped, [], "a field this request never sent is not a skip worth recording");
});

// Not a providerTest: a bearer credential can never legally reach a plain
// HTTP loopback server in the first place — server/provider-fetch.ts throws
// "Plain HTTP provider requests cannot carry authentication" before any
// request leaves the process, on every platform, credential exclusion or
// not. So this proves the capture boundary directly, at the two seams that
// between them decide what a credential can reach: `resolveProviderHeaders`
// (../server/provider-runtime.ts), which is where a credential really does
// resolve, and `createGenerationRecordCapture`'s `finish` (../server/
// generation-record-capture.ts), which is the only place server/providers.ts
// ever builds an effective-parameters snapshot from.
test("the Generation Record capture allowlist excludes every credential, header, and body secret field", (t) => {
  const secretEnv = "AI_1667_TEST_GENERATION_RECORD_SECRET";
  const secret = "provider-secret/generation-record-value";
  process.env[secretEnv] = secret;
  t.after(() => { delete process.env[secretEnv]; });

  // A real credential, resolved through the same code path server/
  // providers.ts uses — not a stand-in for one that was never sent.
  const settings = fixtureSettings("openai-compatible", {
    baseUrl: "http://127.0.0.1:1",
    authEnv: secretEnv
  });
  const { headers, secrets } = resolveProviderHeaders(settings, { "content-type": "application/json" });
  assert.equal(headers.authorization, `Bearer ${secret}`);
  assert.deepEqual(secrets, [secret]);

  // `createGenerationRecordCapture` only ever takes a wire body (see its call
  // sites in server/providers.ts) — `headers` above has no path into it. Even
  // so, plant the same credential inside the body too, under field names a
  // future bug could plausibly use, to prove the allowlist rejects it there
  // as well: `snapshotEffectiveFields` walks the fixed allowlist array and
  // reads only those keys, so a field the allowlist never names is invisible
  // to it regardless of what value it holds.
  const body: Record<string, unknown> = {
    model: "model-fixture",
    messages: [{ role: "user", content: "secret prompt" }],
    max_tokens: 321,
    temperature: 0.25,
    stream: true,
    authorization: `Bearer ${secret}`,
    api_key: secret,
    headers: { authorization: `Bearer ${secret}` }
  };
  const collector: GenerationRecordCollector = { effective: null };
  const capture = createGenerationRecordCapture(collector, "openai-chat-completions", OPENAI_CHAT_EFFECTIVE_FIELDS);
  capture.finish(body);

  const effective = collector.effective;
  if (effective === null) throw new Error("expected an effective-parameters snapshot");
  assert.ok(effective.fields.some((field) => field.field === "max_tokens" && field.value === 321));
  assert.ok(effective.fields.some((field) => field.field === "temperature" && field.value === 0.25));
  assert.equal(effective.fields.some((field) => field.field === "authorization"), false);
  assert.equal(effective.fields.some((field) => field.field === "api_key"), false);
  assert.equal(effective.fields.some((field) => field.field === "headers"), false);
  assert.equal(JSON.stringify(effective).includes(secret), false);
});

function fixtureSettings(
  provider: GenerationSettings["provider"],
  options: {
    readonly baseUrl: string;
    readonly tokenProbabilities?: number | null;
    readonly authEnv?: string;
    readonly preset?: SettingsPresetV2;
  }
): GenerationSettings {
  const preset: SettingsPresetV2 = options.preset ?? "custom";
  return attachProviderRuntime({
    provider,
    baseUrl: options.baseUrl,
    model: "model-fixture",
    apiKeyEnv: null,
    temperature: 0.25,
    maxTokens: 321,
    systemPrompt: "unused by prompt-plan lowering",
    contextWindow: null
  }, {
    preset,
    auth: options.authEnv === undefined ? { type: "none" } : { type: "bearer-env", env: options.authEnv },
    headers: [],
    timeouts: {
      responseHeaderMs: 1_000,
      firstTokenMs: 1_000,
      idleMs: 1_000,
      totalMs: 5_000
    },
    allowInsecureHttp: options.authEnv !== undefined,
    effort: "default",
    tokenProbabilities: options.tokenProbabilities ?? null,
    sampling: EMPTY_SAMPLING_V2,
    capabilities: {
      temperature: "supported",
      assistantPrefill: "unknown",
      reasoningEffort: "unknown",
      promptCaching: "unknown"
    }
  }, true);
}

function anthropicFixtureSettings(baseUrl: string, temperature: number | null): GenerationSettings {
  const preset: SettingsPresetV2 = "anthropic";
  return attachProviderRuntime({
    provider: "anthropic",
    baseUrl,
    model: "model-fixture",
    apiKeyEnv: null,
    temperature,
    maxTokens: 256,
    systemPrompt: "unused by prompt-plan lowering",
    contextWindow: null
  }, {
    preset,
    auth: { type: "none" },
    headers: [],
    timeouts: {
      responseHeaderMs: 2_000,
      firstTokenMs: 2_000,
      idleMs: 2_000,
      totalMs: 5_000
    },
    allowInsecureHttp: true,
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

function rejectUnsupported(response: ServerResponse, param: string): void {
  response.writeHead(400, { "content-type": "application/json" });
  response.end(JSON.stringify({
    error: { message: `Unsupported parameter: '${param}'.`, type: "invalid_request_error", param, code: "unsupported_parameter" }
  }));
}

function respondOk(response: ServerResponse, text: string): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const delta of stream) text += delta;
  return text;
}

function baseUrlFor(server: ReturnType<typeof createServer>): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  buildAnthropicMessagesRequestBody,
  buildOpenAiChatRequestBody
} from "../server/provider-request-body.js";
import { attachProviderRuntime } from "../server/provider-runtime.js";
import { ownedLoopbackHttpSupported } from "../server/provider-fetch.js";
import {
  forgetRefusedTokenProbabilities,
  streamCompletion,
  type TokenProbabilityCollector
} from "../server/providers.js";
import type { PromptCacheWirePlan } from "../server/provider-cache-policy.js";
import type { PromptPlan } from "../shared/prompt-plan.js";
import {
  MAX_TOKEN_PROBABILITY_STEPS,
  type CapturedTokenProbabilities
} from "../shared/token-probabilities.js";
import { EMPTY_SAMPLING_V2, type SettingsPresetV2 } from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";

// Integration tests at the request-serializer boundary (issue #291 phase 2):
// what reaches the wire, what the refusal retry does to it, and what the
// stream capture reassembles from it. Phase 1's shared/token-probabilities.ts
// and shared/token-probability-capabilities.ts have their own test file.

const providerTest = ownedLoopbackHttpSupported() ? test : test.skip;

const PROMPT: PromptPlan = {
  operation: "continue",
  turns: [{
    role: "user",
    blocks: [{ stability: "volatile", kind: "request", text: "Continue.", boundaryAfter: "none" }]
  }]
};

const OMIT: PromptCacheWirePlan = { kind: "omit", reason: "policy-off" };

const PRESETS_THAT_SEND_LOGPROBS = ["openai", "openrouter", "llama-cpp", "koboldcpp", "lm-studio"] as const;
const PRESETS_THAT_DO_NOT = ["ollama", "custom"] as const;

test("logprobs/top_logprobs serialize with the right names and value for every preset that documents them", async () => {
  for (const preset of PRESETS_THAT_SEND_LOGPROBS) {
    const body = await buildOpenAiChatRequestBody(withTokenProbabilities(preset, 8), PROMPT, OMIT);
    assert.equal(body.logprobs, true, preset);
    assert.equal(body.top_logprobs, 8, preset);
  }
});

test("logprobs/top_logprobs are absent for a preset that does not document them", async () => {
  for (const preset of PRESETS_THAT_DO_NOT) {
    const body = await buildOpenAiChatRequestBody(withTokenProbabilities(preset, 5), PROMPT, OMIT);
    assert.equal("logprobs" in body, false, preset);
    assert.equal("top_logprobs" in body, false, preset);
  }
});

test("logprobs/top_logprobs are absent on Anthropic Messages, even when configured", async () => {
  const body = await buildAnthropicMessagesRequestBody(
    withTokenProbabilities("anthropic", 5, { provider: "anthropic" }),
    PROMPT,
    OMIT
  );
  assert.equal("logprobs" in body, false);
  assert.equal("top_logprobs" in body, false);
});

test("logprobs/top_logprobs are absent when the profile leaves the field unset", async () => {
  const body = await buildOpenAiChatRequestBody(withTokenProbabilities("openai", null), PROMPT, OMIT);
  assert.equal("logprobs" in body, false);
  assert.equal("top_logprobs" in body, false);
});

providerTest("a 400 naming top_logprobs drops both fields, retries once, and still delivers prose — then never asks again for this model", async (t) => {
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

  const settings = withTokenProbabilities("openai", 5, { baseUrl: baseUrlFor(server) });
  const first = await collect(streamCompletion(settings, PROMPT, new AbortController().signal));
  assert.equal(first, "ok");
  assert.equal(requests.length, 2, "one rejected attempt, one retry");
  assert.equal(requests[0]!.top_logprobs, 5);
  assert.equal("logprobs" in requests[1]!, false);
  assert.equal("top_logprobs" in requests[1]!, false);

  // Paid once per model (issue #291 phase 2, point 6): a second, independent
  // generation against the same endpoint and model must not resend the
  // fields and pay the same rejected round trip again.
  const second = await collect(streamCompletion(settings, PROMPT, new AbortController().signal));
  assert.equal(second, "ok");
  assert.equal(requests.length, 3, "the second generation cost exactly one request");
  assert.equal("top_logprobs" in requests[2]!, false);
});

providerTest("capture collects the same record whether logprobs arrive per delta or in one final chunk", async (t) => {
  const perDelta = await startLogprobsServer(t, (write) => {
    write({ choices: [{ delta: { content: "Hello" }, logprobs: { content: [
      logprobsEntry("Hello", -0.1, [["Hello", -0.1], ["Hi", -1.2]])
    ] }, finish_reason: null }] });
    write({ choices: [{ delta: { content: " world" }, logprobs: { content: [
      logprobsEntry(" world", -0.2, [[" world", -0.2], [" there", -1.5]])
    ] }, finish_reason: null }] });
    write({ choices: [{ delta: { content: "!" }, logprobs: { content: [
      logprobsEntry("!", -0.05, [["!", -0.05]])
    ] }, finish_reason: "stop" }] });
  });
  const finalChunk = await startLogprobsServer(t, (write) => {
    write({ choices: [{ delta: { content: "Hello" }, finish_reason: null }] });
    write({ choices: [{ delta: { content: " world" }, finish_reason: null }] });
    write({ choices: [{ delta: { content: "!" }, logprobs: { content: [
      logprobsEntry("Hello", -0.1, [["Hello", -0.1], ["Hi", -1.2]]),
      logprobsEntry(" world", -0.2, [[" world", -0.2], [" there", -1.5]]),
      logprobsEntry("!", -0.05, [["!", -0.05]])
    ] }, finish_reason: "stop" }] });
  });

  const perDeltaCollector: TokenProbabilityCollector = { record: null };
  const perDeltaText = await collect(streamCompletion(
    withTokenProbabilities("openai", 2, { baseUrl: perDelta.baseUrl }),
    PROMPT,
    new AbortController().signal,
    undefined,
    undefined,
    undefined,
    perDeltaCollector
  ));
  const finalChunkCollector: TokenProbabilityCollector = { record: null };
  const finalChunkText = await collect(streamCompletion(
    withTokenProbabilities("openai", 2, { baseUrl: finalChunk.baseUrl }),
    PROMPT,
    new AbortController().signal,
    undefined,
    undefined,
    undefined,
    finalChunkCollector
  ));

  assert.equal(perDeltaText, "Hello world!");
  assert.equal(finalChunkText, "Hello world!");
  assert.ok(perDeltaCollector.record !== null);
  assert.deepEqual(perDeltaCollector.record, finalChunkCollector.record);
  assert.equal(perDeltaCollector.record?.steps.length, 3);
  assert.equal(perDeltaCollector.record?.requested, 2);
  assert.deepEqual(perDeltaCollector.record?.steps.map((step) => step.token), ["Hello", " world", "!"]);
});

providerTest("a malformed logprobs entry is skipped without failing the generation", async (t) => {
  const server = await startLogprobsServer(t, (write) => {
    write({ choices: [{ delta: { content: "Hello" }, logprobs: { content: [
      logprobsEntry("Hello", -0.1, [["Hello", -0.1]]),
      // Wrong types entirely.
      { token: 42, logprob: "nope" },
      // A positive logprob violates the format's own bound.
      { token: "extra", logprob: 0.5, top_logprobs: [] }
    ] }, finish_reason: "stop" }] });
  });
  const collector: TokenProbabilityCollector = { record: null };
  const text = await collect(streamCompletion(
    withTokenProbabilities("openai", 3, { baseUrl: server.baseUrl }),
    PROMPT,
    new AbortController().signal,
    undefined,
    undefined,
    undefined,
    collector
  ));
  assert.equal(text, "Hello");
  assert.equal(collector.record?.steps.length, 1);
  assert.equal(collector.record?.steps[0]?.token, "Hello");
});

providerTest("capture stops at the step limit and marks the record truncated", async (t) => {
  const entries = Array.from({ length: MAX_TOKEN_PROBABILITY_STEPS + 5 }, (_unused, index) =>
    logprobsEntry(`t${index}`, -0.1, [[`t${index}`, -0.1]]));
  const server = await startLogprobsServer(t, (write) => {
    write({ choices: [{ delta: { content: "done" }, logprobs: { content: entries }, finish_reason: "stop" }] });
  });
  const collector: TokenProbabilityCollector = { record: null };
  await collect(streamCompletion(
    withTokenProbabilities("openai", 1, { baseUrl: server.baseUrl }),
    PROMPT,
    new AbortController().signal,
    undefined,
    undefined,
    undefined,
    collector
  ));
  assert.equal(collector.record?.steps.length, MAX_TOKEN_PROBABILITY_STEPS);
  assert.equal(collector.record?.truncated, true);
});

providerTest("a collector requested on a route that never sends logprobs stays null, not an empty record", async (t) => {
  const server = await startLogprobsServer(t, (write) => {
    write({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] });
  });
  const collector: TokenProbabilityCollector = { record: null };
  const text = await collect(streamCompletion(
    withTokenProbabilities("custom", null, { baseUrl: server.baseUrl }),
    PROMPT,
    new AbortController().signal,
    undefined,
    undefined,
    undefined,
    collector
  ));
  assert.equal(text, "ok");
  assert.equal(collector.record, null);
});

function withTokenProbabilities(
  preset: SettingsPresetV2,
  tokenProbabilities: number | null,
  options: {
    readonly provider?: GenerationSettings["provider"];
    readonly baseUrl?: string;
    /** Names an environment variable whose value the request sends as a
     *  bearer credential, so the redactor has a secret to recognise. */
    readonly authEnv?: string;
  } = {}
): GenerationSettings {
  return attachProviderRuntime({
    provider: options.provider ?? "openai-compatible",
    baseUrl: options.baseUrl ?? "https://provider.example/v1",
    model: "model-fixture",
    apiKeyEnv: null,
    temperature: 0.25,
    maxTokens: 321,
    systemPrompt: "unused by prompt-plan lowering",
    contextWindow: null
  }, {
    preset,
    auth: options.authEnv === undefined
      ? { type: "none" }
      : { type: "bearer-env", env: options.authEnv },
    headers: [],
    timeouts: {
      responseHeaderMs: 1_000,
      firstTokenMs: 1_000,
      idleMs: 1_000,
      totalMs: 5_000
    },
    // A credential may not ride plain HTTP unless the runtime says so, and
    // every test server here is loopback HTTP.
    allowInsecureHttp: options.authEnv !== undefined,
    effort: "default",
    tokenProbabilities,
    sampling: EMPTY_SAMPLING_V2,
    capabilities: {
      temperature: "supported",
      assistantPrefill: "unknown",
      reasoningEffort: "unknown",
      promptCaching: "unknown"
    }
  }, true);
}

function logprobsEntry(
  token: string,
  logprob: number,
  alternatives: ReadonlyArray<readonly [string, number]>
): Record<string, unknown> {
  return {
    token,
    logprob,
    top_logprobs: alternatives.map(([altToken, altLogprob]) => ({ token: altToken, logprob: altLogprob }))
  };
}

async function startLogprobsServer(
  t: test.TestContext,
  respond: (write: (event: Record<string, unknown>) => void) => void
): Promise<{ baseUrl: string }> {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      respond((event) => response.write(`data: ${JSON.stringify(event)}\n\n`));
      response.end("data: [DONE]\n\n");
    });
  });
  await listen(server);
  t.after(() => closeServer(server));
  return { baseUrl: baseUrlFor(server) };
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

// Streamed prose leaves through the stream redactor; captured tokens never
// touched it. An endpoint that returns the key it was given would otherwise
// have that key written into the story bundle and read back by the viewer.
//
// These drive `globalThis.fetch` rather than the loopback server the tests
// above use, because a plain HTTP loopback request refuses to carry a
// credential at all — so a real secret can only reach this code path over a
// stubbed transport, the same way the provider redaction tests do it.
async function captureWithSecret(
  t: test.TestContext,
  secretEnv: string,
  secret: string,
  events: readonly Record<string, unknown>[]
): Promise<{ record: CapturedTokenProbabilities | null; text: string }> {
  process.env[secretEnv] = secret;
  t.after(() => { delete process.env[secretEnv]; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } }
  )) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const collector: TokenProbabilityCollector = { record: null };
  const text = await collect(streamCompletion(
    withTokenProbabilities("openai", 2, { authEnv: secretEnv }),
    PROMPT,
    new AbortController().signal,
    undefined,
    undefined,
    undefined,
    collector
  ));
  return { record: collector.record, text };
}

test("a captured alternative that carries the provider credential stores nothing", async (t) => {
  const secret = "provider-secret-alternative";
  const { record, text } = await captureWithSecret(t, "AI_1667_TEST_PROBS_LEAK", secret, [
    { choices: [{ delta: { content: "Hello" }, logprobs: { content: [
      logprobsEntry("Hello", -0.1, [["Hello", -0.1], [secret, -1.2]])
    ] }, finish_reason: "stop" }] }
  ]);

  assert.equal(text, "Hello", "the writer still gets their prose");
  assert.equal(record, null, "the record carrying the credential is dropped whole");
});

// The same leak, spread thin: no single token holds the credential, but the
// strings the provider sent concatenate to it.
test("a credential split across captured tokens stores nothing", async (t) => {
  const { record } = await captureWithSecret(t, "AI_1667_TEST_PROBS_SPLIT", "abcdefghij", [
    { choices: [{ delta: { content: "x" }, logprobs: { content: [
      logprobsEntry("abcde", -0.1, [["abcde", -0.1]]),
      logprobsEntry("fghij", -0.2, [["fghij", -0.2]])
    ] }, finish_reason: "stop" }] }
  ]);

  assert.equal(record, null);
});

// The guard must cost an ordinary generation nothing: the same endpoint, the
// same credential, alternatives that do not carry it.
test("an ordinary capture is unaffected by the credential guard", async (t) => {
  const { record } = await captureWithSecret(t, "AI_1667_TEST_PROBS_CLEAN", "provider-secret-unused", [
    { choices: [{ delta: { content: "Hello" }, logprobs: { content: [
      logprobsEntry("Hello", -0.1, [["Hello", -0.1], ["Hi", -1.2]])
    ] }, finish_reason: "stop" }] }
  ]);

  assert.equal(record?.steps.length, 1);
  assert.equal(record?.steps[0]?.alternatives[1]?.token, "Hi");
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { continueStory } from "../server/generation-http.js";
import { GenerationAdmissionRegistry } from "../server/generation-admission.js";
import { LEGACY_PROMPT_CACHE_CONTEXT, PromptCacheRuntime } from "../server/provider-cache-policy.js";
import { attachProviderRuntime } from "../server/provider-runtime.js";
import { StoryStore } from "../server/stories.js";
import type { SettingsStore } from "../server/settings.js";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";

/**
 * Issue #107: KoboldCpp sends every token probability in one SSE event,
 * after all the prose — its own source calls this "a hack that sends an
 * extra message containing ALL the logprobs". server/provider-sse.ts's
 * per-event byte cap did not know a request had asked for `top_logprobs`,
 * so that one event routinely exceeded the flat 1 MiB cap and the whole
 * generation, prose included, was thrown away over a diagnostic the writer
 * merely opted into.
 *
 * These tests drive the fix at the same layer test/reasoning-storage.test.ts
 * and test/token-probability-storage.test.ts use — a fake OpenAI-compatible
 * SSE stream through `continueStory` — so a passing test proves the take
 * actually commits and, where expected, actually stores the record, not
 * just that the parser stops throwing.
 */

const ALT_COUNT = 10;

test("an oversized token-probability event is dropped, not fatal: the take still commits its prose", { timeout: 20_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-token-probability-oversized-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  // Generous maxTokens keeps this fixture's own prose text well inside
  // providerOutputByteLimit (server/provider-stream-output.ts) regardless of
  // how many probability steps it takes to build a large event — that cap
  // is a different safety limit and this test has no business tripping it.
  const maxTokens = 8_192;
  // Past MAX_PROBABILITY_EVENT_BYTES (the 8 MiB absolute ceiling in
  // server/provider-sse.ts) even after Part 2's per-request budget widens
  // the allowance — so only Part 1's discard-instead-of-throw path can save
  // this take.
  const stepCount = stepsReachingBytes(9 * 1024 * 1024, ALT_COUNT);
  const { text, steps } = buildLogprobsSteps(stepCount, ALT_COUNT);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    proseDeltaEvent(text) + logprobsFinalEvent(steps) + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } }
  )) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await continueStory(
    story.id,
    { parentId: null, instruction: "Continue.", genId: "gen-oversized" },
    stories,
    stubSettingsStore(koboldSettings(ALT_COUNT, maxTokens)),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal
  );
  const node = result?.nodes[0];
  if (node === undefined) throw new Error("continuation did not commit a take");

  // The prose survives: the oversized event never threw the generation away.
  assert.equal(node.text, text);
  // The probabilities do not: the one event that would have carried them was
  // too large even for the raised per-request budget, so it was discarded —
  // the same end state as any other path where the record cannot be kept.
  assert.equal(node.tokenProbabilities, undefined);
});

test("a probability event within the new per-request allowance is parsed and stored, not discarded", { timeout: 20_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-token-probability-within-budget-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const maxTokens = 4_096;
  // Comfortably past the OLD flat 1 MiB event / 2 MiB partial caps this
  // event would have tripped before the fix (issue #107's own measured
  // 4,096-token/10-alternative row lands at 3.29 MiB), and comfortably below
  // the budget maxSseEventBytesFor derives for this request.
  const stepCount = stepsReachingBytes(2_200 * 1024, ALT_COUNT);
  assert.ok(
    stepCount < 8_192,
    "fixture must stay under MAX_TOKEN_PROBABILITY_STEPS or truncation, not the size budget, would decide this test"
  );
  const { text, steps } = buildLogprobsSteps(stepCount, ALT_COUNT);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    proseDeltaEvent(text) + logprobsFinalEvent(steps) + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } }
  )) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await continueStory(
    story.id,
    { parentId: null, instruction: "Continue.", genId: "gen-within-budget" },
    stories,
    stubSettingsStore(koboldSettings(ALT_COUNT, maxTokens)),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal
  );
  const node = result?.nodes[0];
  if (node === undefined) throw new Error("continuation did not commit a take");

  assert.equal(node.text, text);
  assert.equal(node.tokenProbabilities, true);
  const record = await stories.loadTokenProbabilities(story.id, node.id);
  assert.equal(record.requested, ALT_COUNT);
  assert.equal(record.steps.length, stepCount);
  assert.equal(record.steps.map((step) => step.token).join(""), text);
});

test("a request that asked for no probabilities still refuses an oversized event", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-token-probability-not-requested-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    `data: ${"x".repeat(1024 * 1024 + 1)}\n\n`,
    { headers: { "content-type": "text/event-stream" } }
  )) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  // Same koboldcpp preset as the tests above — the only difference is that
  // this request never turned probabilities on (tokenProbabilities: null),
  // proving the relaxation is keyed on what the request asked for, not on
  // whether the preset could support them.
  await assert.rejects(
    continueStory(
      story.id,
      { parentId: null, instruction: "Continue.", genId: "gen-not-requested" },
      stories,
      stubSettingsStore(koboldSettings(null, 256)),
      new PromptCacheRuntime(),
      new GenerationAdmissionRegistry(),
      () => {},
      new AbortController().signal
    ),
    /provider_response_too_large/
  );
});

const VOCAB = [
  "the", "story", "moved", "forward", "quietly", "and", "then", "paused",
  "before", "a", "door", "opened", "onto", "rain", "light", "shadow",
  "voice", "answered", "softly", "again"
] as const;

function wordToken(index: number): string {
  const word = VOCAB[index % VOCAB.length]!;
  return index === 0 ? word : ` ${word}`;
}

function alternativeToken(stepIndex: number, rank: number): string {
  const word = VOCAB[(stepIndex + rank + 7) % VOCAB.length]!;
  return ` ${word}`;
}

/** Realistic KoboldCpp/OpenAI-shaped `choices[0].logprobs.content` entries:
 *  each carries the sampled token, its logprob, and `altCount` alternatives
 *  the model weighed with it (`top_logprobs`) — the same shape
 *  server/token-probability-capture.ts's parseOpenAiLogprobsEntry reads. The
 *  sampled tokens concatenate to exactly the prose text the test also
 *  streams as `delta.content`, so commit-time alignment
 *  (shared/token-probabilities.ts's alignTokenProbabilities) can place the
 *  whole capture inside the take's stored text instead of refusing it on a
 *  mismatch unrelated to this issue. */
function buildLogprobsSteps(
  stepCount: number,
  altCount: number
): { readonly text: string; readonly steps: readonly Record<string, unknown>[] } {
  const steps: Record<string, unknown>[] = [];
  const textParts: string[] = [];
  for (let index = 0; index < stepCount; index += 1) {
    const token = wordToken(index);
    textParts.push(token);
    const alternatives: Record<string, unknown>[] = [{ token, logprob: -0.05 }];
    for (let rank = 1; rank < altCount; rank += 1) {
      alternatives.push({
        token: alternativeToken(index, rank),
        logprob: -0.05 - rank * 0.3
      });
    }
    steps.push({ token, logprob: -0.05, top_logprobs: alternatives });
  }
  return { text: textParts.join(""), steps };
}

/** Grows the step count until the wire-encoded content array reaches at
 *  least `targetBytes` — measuring the real JSON encoding rather than
 *  hand-predicting it, since key names and escaping make hand math
 *  unreliable at this scale. */
function stepsReachingBytes(targetBytes: number, altCount: number): number {
  let stepCount = 64;
  for (;;) {
    const bytes = Buffer.byteLength(JSON.stringify(buildLogprobsSteps(stepCount, altCount).steps));
    if (bytes >= targetBytes) return stepCount;
    stepCount = Math.ceil(stepCount * 1.4);
  }
}

function proseDeltaEvent(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

function logprobsFinalEvent(steps: readonly Record<string, unknown>[]): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: {}, finish_reason: "stop", logprobs: { content: steps } }]
  })}\n\n`;
}

function koboldSettings(tokenProbabilities: number | null, maxTokens: number): GenerationSettings {
  return attachProviderRuntime({
    provider: "openai-compatible",
    baseUrl: "https://kobold.example/v1",
    model: "fixture",
    apiKeyEnv: null,
    temperature: 0,
    maxTokens,
    systemPrompt: "Write.",
    contextWindow: null
  }, {
    preset: "koboldcpp",
    auth: { type: "none" },
    headers: [],
    timeouts: {
      responseHeaderMs: 5_000,
      firstTokenMs: 5_000,
      idleMs: 5_000,
      totalMs: 20_000
    },
    allowInsecureHttp: false,
    effort: "default",
    tokenProbabilities,
    sampling: EMPTY_SAMPLING_V2,
    capabilities: {
      temperature: "supported",
      assistantPrefill: "unsupported",
      reasoningEffort: "unsupported",
      promptCaching: "unsupported"
    }
  }, true);
}

function stubSettingsStore(settings: GenerationSettings): SettingsStore {
  return {
    loadGeneration: async () => ({ settings, promptCache: LEGACY_PROMPT_CACHE_CONTEXT })
  } as unknown as SettingsStore;
}

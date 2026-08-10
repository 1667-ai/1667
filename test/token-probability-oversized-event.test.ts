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
 * Two review passes corrected the first cut of the fix, both covered below:
 *  - the budget was sized from a synthetic OpenAI-spec payload scaled by the
 *    requested alternative count; KoboldCpp's real serializer always reports
 *    a hard-coded 10 alternatives per token regardless of what was
 *    requested, and costs ~1452 bytes/token, not bytes/(token*alternative) —
 *    buildKoboldLogprobsSteps below mirrors that real shape, not the OpenAI
 *    spec's minimal one;
 *  - the discard predicate proved only that `delta` carried no prose; an
 *    oversized event with an empty `delta` can still carry a real
 *    `finish_reason` or a provider `error`, so discarding it could hide a
 *    truncation or failure behind a later `[DONE]`.
 *
 * These tests drive the fix at the same layer test/reasoning-storage.test.ts
 * and test/token-probability-storage.test.ts use — a fake OpenAI-compatible
 * SSE stream through `continueStory` — so a passing test proves the take
 * actually commits and, where expected, actually stores the record, not
 * just that the parser stops throwing.
 */

/** What these tests ask the fake provider for. Kept fixed at 10 for most
 *  cases purely for readability — the whole point of the low-alt-count test
 *  below is that this value no longer has any bearing on the wire size or
 *  the budget derived from it. */
const REQUESTED_ALT_COUNT = 10;

/** Shared by every test whose whole point is that the event stays too large
 *  no matter how generous the per-request budget gets: comfortably past
 *  MAX_PROBABILITY_EVENT_BYTES (the 8 MiB absolute ceiling in
 *  server/provider-sse-probability-budget.ts), regardless of the exact
 *  per-token constant. OVERSIZED_MAX_TOKENS is set high enough that the step
 *  count stepsReachingBytes finds for OVERSIZED_TARGET_BYTES (using
 *  KoboldCpp's real, heavier entry shape — see buildKoboldLogprobsSteps)
 *  still reads as a plausible generation length, not an artifact of the
 *  fixture overshooting its own target. */
const OVERSIZED_TARGET_BYTES = 8_700_000;
const OVERSIZED_MAX_TOKENS = 16_384;

/** Shared by every test proving an event that fits the new allowance is
 *  parsed and stored, not discarded: comfortably past the OLD flat 1 MiB
 *  event / 2 MiB partial caps this event would have tripped before the fix
 *  (issue #107's own measured 2,048-token row lands at 2.84 MiB on
 *  KoboldCpp's real serializer), and comfortably below the ~8 MiB budget
 *  maxSseEventBytesFor derives for WITHIN_BUDGET_MAX_TOKENS tokens (2,048
 *  B/token headroom over KoboldCpp's real ~1452 B/token, clamped to the
 *  absolute ceiling here). */
const WITHIN_BUDGET_TARGET_BYTES = 2_201_600;
const WITHIN_BUDGET_MAX_TOKENS = 4_096;

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
  const maxTokens = OVERSIZED_MAX_TOKENS;
  const stepCount = stepsReachingBytes(OVERSIZED_TARGET_BYTES);
  const { text, steps } = buildKoboldLogprobsSteps(stepCount);

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
    stubSettingsStore(koboldSettings(REQUESTED_ALT_COUNT, maxTokens)),
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

  const maxTokens = WITHIN_BUDGET_MAX_TOKENS;
  const stepCount = stepsReachingBytes(WITHIN_BUDGET_TARGET_BYTES);
  assert.ok(
    stepCount < 8_192,
    "fixture must stay under MAX_TOKEN_PROBABILITY_STEPS or truncation, not the size budget, would decide this test"
  );
  assert.ok(
    stepCount <= maxTokens,
    "fixture step count should not exceed the request's maxTokens, or this stops being a plausible generation"
  );
  const { text, steps } = buildKoboldLogprobsSteps(stepCount);

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
    stubSettingsStore(koboldSettings(REQUESTED_ALT_COUNT, maxTokens)),
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
  assert.equal(record.requested, REQUESTED_ALT_COUNT);
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

// Structural-review finding on the fix above: discardOversizedEvents was
// request-wide, so ANY oversized event was silently dropped once a request
// had asked for probabilities — but a real OpenAI-compatible event can carry
// `delta.content` (prose), `logprobs`, and finish/error fields together. A
// mixed event over budget must never be silently discarded: it must throw,
// exactly like an oversized event always did before this feature existed.
test("a mixed event carrying real prose alongside an oversized logprobs payload throws instead of silently losing the prose", { timeout: 20_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-token-probability-mixed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const maxTokens = OVERSIZED_MAX_TOKENS;
  const stepCount = stepsReachingBytes(OVERSIZED_TARGET_BYTES);
  const { steps } = buildKoboldLogprobsSteps(stepCount);
  const prose = "Real prose that must survive.";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    mixedProseAndLogprobsEvent(prose, steps) + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } }
  )) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    continueStory(
      story.id,
      { parentId: null, instruction: "Continue.", genId: "gen-mixed" },
      stories,
      stubSettingsStore(koboldSettings(REQUESTED_ALT_COUNT, maxTokens)),
      new PromptCacheRuntime(),
      new GenerationAdmissionRegistry(),
      () => {},
      new AbortController().signal
    ),
    /provider_response_too_large/
  );

  // Not just a rejected promise: nothing was silently committed with the
  // prose missing.
  const reloaded = await stories.load(story.id);
  assert.equal(reloaded.nodes.length, 0);
});

test("an oversized event whose prefix is inconclusive (logprobs ordered before delta) throws rather than guessing", { timeout: 20_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-token-probability-inconclusive-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const maxTokens = OVERSIZED_MAX_TOKENS;
  const stepCount = stepsReachingBytes(OVERSIZED_TARGET_BYTES);
  // `delta` carries no real prose here (content: ""), so if the parser
  // could see it, it would recognize the event as safe to drop. The point
  // of this test is that it never gets the chance to see it: `logprobs`
  // comes first and is large enough that `delta` sits well past the
  // inspection prefix's cutoff.
  const { steps } = buildKoboldLogprobsSteps(stepCount);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    logprobsBeforeDeltaEvent(steps) + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } }
  )) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    continueStory(
      story.id,
      { parentId: null, instruction: "Continue.", genId: "gen-inconclusive" },
      stories,
      stubSettingsStore(koboldSettings(REQUESTED_ALT_COUNT, maxTokens)),
      new PromptCacheRuntime(),
      new GenerationAdmissionRegistry(),
      () => {},
      new AbortController().signal
    ),
    /provider_response_too_large/
  );

  const reloaded = await stories.load(story.id);
  assert.equal(reloaded.nodes.length, 0);
});

// Review finding on the budget itself (not the discard predicate): the
// first cut scaled the per-event budget by the REQUESTED alternative count,
// but KoboldCpp's real wire size does not depend on it — the serializer
// always emits its own hard-coded 10 alternatives per token. A request that
// asks for only 1 must get exactly the same budget (and the same successful
// outcome) as one that asks for 10.
test("a low requested alternative count does not shrink the per-token budget", { timeout: 20_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-token-probability-low-alt-count-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const maxTokens = WITHIN_BUDGET_MAX_TOKENS;
  // Identical construction to the within-budget test above — same maxTokens,
  // same real wire size — the ONLY difference is the requested alt count.
  const stepCount = stepsReachingBytes(WITHIN_BUDGET_TARGET_BYTES);
  const { text, steps } = buildKoboldLogprobsSteps(stepCount);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    proseDeltaEvent(text) + logprobsFinalEvent(steps) + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } }
  )) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await continueStory(
    story.id,
    { parentId: null, instruction: "Continue.", genId: "gen-low-alt-count" },
    stories,
    // Asked for only 1 alternative; KoboldCpp's wire event still reports 10
    // per token (buildKoboldLogprobsSteps mirrors that) and still costs the
    // same ~1452 B/token regardless. The old alt-scaled formula would have
    // derived a budget around maxTokens * 256 here — far below this event's
    // real size — and silently discarded it.
    stubSettingsStore(koboldSettings(1, maxTokens)),
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
  assert.equal(record.requested, 1);
  assert.equal(record.steps.length, stepCount);
});

// Review finding on the discard predicate: proving `delta` carries no prose
// is not the same as proving the event carries no terminal state. An empty
// delta with a real (non-null) finish_reason means the generation actually
// ended on this event — discarding it would hide that behind a later
// [DONE], letting a truncated or failed take commit as if it had finished
// cleanly.
test("an oversized event with an empty delta but a non-null finish_reason throws instead of discarding", { timeout: 20_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-token-probability-finish-reason-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const maxTokens = OVERSIZED_MAX_TOKENS;
  const stepCount = stepsReachingBytes(OVERSIZED_TARGET_BYTES);
  const { steps } = buildKoboldLogprobsSteps(stepCount);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    // Empty delta — on its own, the old (prose-only) predicate would have
    // called this safe to drop. "length" is a real terminal reason, not
    // KoboldCpp's own null, so it must not be.
    logprobsFinalEvent(steps, "length") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } }
  )) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    continueStory(
      story.id,
      { parentId: null, instruction: "Continue.", genId: "gen-finish-reason" },
      stories,
      stubSettingsStore(koboldSettings(REQUESTED_ALT_COUNT, maxTokens)),
      new PromptCacheRuntime(),
      new GenerationAdmissionRegistry(),
      () => {},
      new AbortController().signal
    ),
    /provider_response_too_large/
  );

  const reloaded = await stories.load(story.id);
  assert.equal(reloaded.nodes.length, 0);
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

/** KoboldCpp's own hard-coded cap on alternatives per token
 *  (`logprobs_max` in `koboldcpp.py`'s `parse_last_logprobs`) — the wire
 *  always reports exactly this many, regardless of what `top_logprobs` the
 *  request asked for. */
const KOBOLD_WIRE_ALTERNATIVES = 10;

function tokenBytes(token: string): readonly number[] {
  return Array.from(Buffer.from(token, "utf8"));
}

/** A long-precision negative fraction, the same shape a real serializer's
 *  double-precision logprob produces (`-0.00034998950031499054`, not a
 *  short literal like `-0.05`) — a short literal understates the real
 *  per-token byte cost enough to throw off these fixtures' step counts
 *  relative to `maxTokens`. Deterministic, not random: the same (index,
 *  rank) always produces the same value. */
function logprobFor(index: number, rank: number): number {
  return -(((index * 7 + rank * 13 + 1) % 99_999) + 1) / 100_003;
}

/** A plausible large vocabulary token id (real tokenizers commonly range up
 *  to the low hundreds of thousands), for the same reason as logprobFor:
 *  a small id understates the real per-token byte cost. */
function tokenIdFor(index: number, rank: number): number {
  return 150_000 + ((index * 31 + rank) % 199_999);
}

/** KoboldCpp's real `choices[0].logprobs.content[]` entry shape (issue #107
 *  review, corrected after reading `parse_last_logprobs` directly, not the
 *  bare OpenAI spec): every entry — the sampled token and each of its
 *  KOBOLD_WIRE_ALTERNATIVES alternatives — carries `token_id` and a `bytes`
 *  array (the token's UTF-8 bytes) alongside `token`/`logprob`. The count of
 *  alternatives is always KOBOLD_WIRE_ALTERNATIVES, independent of any
 *  `altCount` the caller asked the (fake) provider for — that is the whole
 *  point of the low-requested-alt-count test above.
 *
 *  The sampled tokens concatenate to exactly the prose text the test also
 *  streams as `delta.content`, so commit-time alignment
 *  (shared/token-probabilities.ts's alignTokenProbabilities) can place the
 *  whole capture inside the take's stored text instead of refusing it on a
 *  mismatch unrelated to this issue. */
function buildKoboldLogprobsSteps(
  stepCount: number
): { readonly text: string; readonly steps: readonly Record<string, unknown>[] } {
  const steps: Record<string, unknown>[] = [];
  const textParts: string[] = [];
  for (let index = 0; index < stepCount; index += 1) {
    const token = wordToken(index);
    textParts.push(token);
    const alternatives: Record<string, unknown>[] = [];
    for (let rank = 0; rank < KOBOLD_WIRE_ALTERNATIVES; rank += 1) {
      const altToken = rank === 0 ? token : alternativeToken(index, rank);
      alternatives.push({
        token: altToken,
        token_id: tokenIdFor(index, rank),
        logprob: logprobFor(index, rank),
        bytes: tokenBytes(altToken)
      });
    }
    steps.push({
      token,
      token_id: tokenIdFor(index, 0),
      logprob: logprobFor(index, 0),
      bytes: tokenBytes(token),
      top_logprobs: alternatives
    });
  }
  return { text: textParts.join(""), steps };
}

/** Grows the step count until the wire-encoded content array reaches at
 *  least `targetBytes` — measuring the real JSON encoding rather than
 *  hand-predicting it, since key names and escaping make hand math
 *  unreliable at this scale. */
function stepsReachingBytes(targetBytes: number): number {
  let stepCount = 64;
  for (;;) {
    const bytes = Buffer.byteLength(JSON.stringify(buildKoboldLogprobsSteps(stepCount).steps));
    if (bytes >= targetBytes) return stepCount;
    stepCount = Math.ceil(stepCount * 1.4);
  }
}

function proseDeltaEvent(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

/** KoboldCpp's real probability-only event carries `"finish_reason":null` —
 *  it is a bonus message, not the generation's actual terminal chunk
 *  (issue #107 review). `finishReason` defaults to that real shape; tests
 *  that need to prove a REAL finish_reason still blocks the discard pass an
 *  explicit non-null value. */
function logprobsFinalEvent(
  steps: readonly Record<string, unknown>[],
  finishReason: string | null = null
): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: {}, finish_reason: finishReason, logprobs: { content: steps } }]
  })}\n\n`;
}

/** A single event carrying real prose (`delta.content`) and a large
 *  `logprobs` payload together — the mixed shape a real OpenAI-compatible
 *  stream can send, and the exact case server/provider-sse.ts's
 *  decideOversizedEvent must never silently discard: `delta` comes before
 *  `logprobs`, matching KoboldCpp's own field order, but this time with
 *  content the fix must not lose. `finish_reason: null` keeps this test
 *  isolated to the prose gate specifically — nothing else about the event
 *  should be a reason to refuse it. */
function mixedProseAndLogprobsEvent(prose: string, steps: readonly Record<string, unknown>[]): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { content: prose }, finish_reason: null, logprobs: { content: steps } }]
  })}\n\n`;
}

/** The inconclusive shape: `logprobs` ordered before `delta`, so the parser's
 *  bounded inspection prefix runs out inside the large `logprobs` payload
 *  and never reaches `delta` at all — prefixProvesSafeToDiscard cannot prove
 *  anything about a field it never saw, and must fail closed. */
function logprobsBeforeDeltaEvent(steps: readonly Record<string, unknown>[]): string {
  return `data: ${JSON.stringify({
    choices: [{ logprobs: { content: steps }, delta: { content: "" }, finish_reason: null }]
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

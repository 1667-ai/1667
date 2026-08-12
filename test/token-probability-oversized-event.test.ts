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
import { MAX_TOKEN_PROBABILITY_STEPS } from "../shared/token-probabilities.js";
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
 * Two review passes tried to widen the cap AND let an oversized event be
 * discarded (kept, not thrown) whenever it could be shown to carry no
 * prose. Both attempts were reverted (issue #107, third review pass): an
 * event too large to buffer is precisely the one whose `finish_reason` or
 * `error` field can sit past whatever inspection window the parser can
 * afford, so "safe to discard" can never be soundly decided at the
 * transport layer — the only place with the whole event to look at is the
 * one that already has it, and by then it isn't oversized anymore.
 *
 * The actual fix has two parts:
 *  - server/provider-sse-probability-budget.ts sizes the per-event budget to
 *    what a real KoboldCpp payload for this request's `maxTokens` needs
 *    (measured directly against `parse_last_logprobs`, not a synthetic
 *    OpenAI-spec shape — see that module's comment), capped at
 *    12 MiB — exactly as much as MAX_TOKEN_PROBABILITY_STEPS (8,192) steps
 *    could ever produce, with headroom;
 *  - graceful degradation for a payload that parses fine but is still too
 *    big to store already exists one layer up:
 *    server/story-node-token-probabilities.ts's attachTakeTokenProbabilities
 *    drops a record that busts MAX_TOKEN_PROBABILITY_BYTES (4 MiB) once
 *    serialized, silently, keeping the take's prose. The transport doesn't
 *    need to duplicate that decision — it only needs to let a
 *    storable-sized payload through.
 *
 * Past the 12 MiB transport ceiling, an event still fails loudly — the same
 * pre-existing behaviour any oversized provider response has always had.
 *
 * These tests drive the fix at the same layer test/reasoning-storage.test.ts
 * and test/token-probability-storage.test.ts use — a fake OpenAI-compatible
 * SSE stream through `continueStory` — so a passing test proves the take
 * actually commits and, where expected, actually stores (or doesn't store)
 * the record, not just that the parser stops throwing.
 */

/** What these tests ask the fake provider for. Kept fixed at 10 for most
 *  cases purely for readability — the whole point of the low-alt-count test
 *  below is that this value no longer has any bearing on the wire size or
 *  the budget derived from it. */
const REQUESTED_ALT_COUNT = 10;

/** Shared by every test proving an event that fits the new allowance is
 *  parsed and stored, not refused: comfortably past the OLD flat 1 MiB
 *  event / 2 MiB partial caps this event would have tripped before the fix
 *  (issue #107's own measured 2,048-token row lands at 2.84 MiB on
 *  KoboldCpp's real serializer), and comfortably below the ~8.0 MiB budget
 *  maxSseEventBytesFor derives for WITHIN_BUDGET_MAX_TOKENS tokens (2,048
 *  B/token headroom over KoboldCpp's real ~1452 B/token). */
const WITHIN_BUDGET_TARGET_BYTES = 2_201_600;
const WITHIN_BUDGET_MAX_TOKENS = 4_096;

test("a probability event within the new per-request allowance is parsed and stored, not refused", { timeout: 20_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-token-probability-within-budget-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const maxTokens = WITHIN_BUDGET_MAX_TOKENS;
  const stepCount = stepsReachingBytes(WITHIN_BUDGET_TARGET_BYTES);
  assert.ok(
    stepCount < MAX_TOKEN_PROBABILITY_STEPS,
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

// Review finding on the budget itself: the first cut scaled the per-event
// budget by the REQUESTED alternative count, but KoboldCpp's real wire size
// does not depend on it — the serializer always emits its own hard-coded 10
// alternatives per token. A request that asks for only 1 must get exactly
// the same budget (and the same successful outcome) as one that asks for 10.
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
    // real size — and refused the event as too large.
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

// The guarantee issue #107 actually cares about: a payload the transport
// accepts can still be too big to store. A full MAX_TOKEN_PROBABILITY_STEPS
// payload (KoboldCpp's real per-entry shape) is comfortably under the 12 MiB
// transport ceiling on the wire, but its stored form — token/logprob pairs
// only, no token_id or bytes — still busts the 4 MiB storage cap. Storage's
// own try/catch (server/story-node-token-probabilities.ts's
// attachTakeTokenProbabilities) is what has to drop it, and the take keeps
// its prose either way.
test("a payload within the transport ceiling but over the storage cap commits its prose with no stored alternatives", { timeout: 20_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-token-probability-storage-cap-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const maxTokens = MAX_TOKEN_PROBABILITY_STEPS;
  const stepCount = MAX_TOKEN_PROBABILITY_STEPS;
  const { text, steps } = buildKoboldLogprobsSteps(stepCount);
  // Measured directly against this fixture: ~8.7 MiB on the wire (under the
  // 12 MiB transport ceiling — this event must reach the provider layer
  // intact), reserializing to ~4.4 MiB in the leaner stored shape (over the
  // 4 MiB storage cap — this is the record storage must refuse).
  const wireBytes = Buffer.byteLength(JSON.stringify(steps));
  assert.ok(wireBytes < 12 * 1024 * 1024, "fixture must stay under the transport ceiling to reach storage at all");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    proseDeltaEvent(text) + logprobsFinalEvent(steps) + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } }
  )) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await continueStory(
    story.id,
    { parentId: null, instruction: "Continue.", genId: "gen-storage-cap" },
    stories,
    stubSettingsStore(koboldSettings(REQUESTED_ALT_COUNT, maxTokens)),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal
  );
  const node = result?.nodes[0];
  if (node === undefined) throw new Error("continuation did not commit a take");

  // The prose commits regardless — the transport accepted the event, and
  // storage's own refusal of the oversized record never touches the take's
  // text.
  assert.equal(node.text, text);
  // Storage dropped the record: no alternatives were kept.
  assert.equal(node.tokenProbabilities, undefined);
  await assert.rejects(
    () => stories.loadTokenProbabilities(story.id, node.id),
    /no stored token probabilities/
  );
});

// The boundary this module's ceiling actually draws: an event too large
// even for MAX_TOKEN_PROBABILITY_STEPS worth of real KoboldCpp output still
// fails the generation loudly. That is the same behaviour any oversized
// provider response has always had — the ceiling doesn't try to absorb it.
test("an event past the 12 MiB transport ceiling still throws", { timeout: 20_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-token-probability-past-ceiling-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const maxTokens = 16_384;
  const stepCount = stepsReachingBytes(13 * 1024 * 1024);
  const { steps } = buildKoboldLogprobsSteps(stepCount);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    logprobsFinalEvent(steps) + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } }
  )) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    continueStory(
      story.id,
      { parentId: null, instruction: "Continue.", genId: "gen-past-ceiling" },
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
 *  array (the token's UTF-8 bytes) alongside `token`/`logprob`, fields
 *  server/token-probability-capture.ts's parseOpenAiLogprobsEntry reads past
 *  and doesn't store — which is exactly why the wire and stored sizes differ
 *  enough for the storage-cap test above to matter. The count of
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
 *  it is a bonus message, sent after the stream is already done, not the
 *  generation's actual terminal chunk. */
function logprobsFinalEvent(steps: readonly Record<string, unknown>[]): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: {}, finish_reason: null, logprobs: { content: steps } }]
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
    loadGeneration: async () => ({ settings, promptCache: LEGACY_PROMPT_CACHE_CONTEXT, imageInputCapability: null })
  } as unknown as SettingsStore;
}

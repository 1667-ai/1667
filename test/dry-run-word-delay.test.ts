import assert from "node:assert/strict";
import test from "node:test";
import type { PromptOperation, PromptPlan } from "../shared/prompt-plan.js";
import type { GenerationSettings } from "../shared/types.js";
import { DRY_RUN_WORD_DELAY_VARIABLE, streamCompletion } from "../server/providers.js";

/**
 * The dry-run per-word delay test seam (web UI #409 step 5, owner decision
 * 4): `AI_1667_DRY_RUN_WORD_DELAY_MS` lets a browser e2e suite watch a whole
 * dry-run stream — reasoning and prose alike — inside a couple of seconds
 * instead of the real ~1s pace, without changing the streamed text. Unset,
 * out of range, or not a number all leave dry-run's own literal delays
 * (8ms reasoning, 15ms prose) untouched.
 *
 * Every case below uses the "rewrite" operation: `streamDryRun` still runs
 * its full reasoning loop first (7 words at the per-word delay) regardless
 * of operation, but `dryRunRewrite`'s fixed 15-word placeholder (no
 * selection/boundary blocks supplied) is the shortest fabricated output any
 * operation produces, keeping the baseline (unset) pace under a third of a
 * second rather than the ~1.1s a "continue" prompt would take.
 */

test.afterEach(() => {
  delete process.env[DRY_RUN_WORD_DELAY_VARIABLE];
});

test("unset: dry-run keeps its own literal per-word pace", async () => {
  delete process.env[DRY_RUN_WORD_DELAY_VARIABLE];
  const { elapsedMs, text } = await streamRewrite();
  // 7 reasoning words at 8ms + 15 prose words at 15ms = 281ms, floor-bound by
  // real setTimeout calls; generous headroom on both sides against scheduler
  // jitter without masking a regression that skips the delay entirely.
  assert.ok(elapsedMs >= 220, `expected the unset default pace (~281ms), got ${elapsedMs}ms`);
  assert.ok(elapsedMs < 2_000, `expected the unset default pace (~281ms), got ${elapsedMs}ms`);
  assert.ok(text.length > 0);
});

test("set: overrides both the reasoning and prose per-word delay", async () => {
  process.env[DRY_RUN_WORD_DELAY_VARIABLE] = "20";
  const { elapsedMs } = await streamRewrite();
  // 22 words (7 reasoning + 15 prose) at 20ms = 440ms.
  assert.ok(elapsedMs >= 380, `expected the overridden 20ms pace (~440ms), got ${elapsedMs}ms`);
  assert.ok(elapsedMs < 1_500, `expected the overridden 20ms pace (~440ms), got ${elapsedMs}ms`);
});

test("set to 0: near-instant, and the streamed text is unaffected", async () => {
  process.env[DRY_RUN_WORD_DELAY_VARIABLE] = "0";
  const { elapsedMs, text } = await streamRewrite();
  assert.ok(elapsedMs < 300, `expected a near-instant stream, got ${elapsedMs}ms`);
  const { elapsedMs: baselineElapsedMs, text: baselineText } = await streamRewrite({ noOverride: true });
  assert.equal(text, baselineText, "the delay must never change what dry-run streams, only its pace");
  assert.ok(baselineElapsedMs > elapsedMs);
});

test("bounded: a value above the maximum falls back to the default pace, "
  + "not to the requested one", { timeout: 4_000 }, async () => {
  process.env[DRY_RUN_WORD_DELAY_VARIABLE] = "2000";
  const { elapsedMs } = await streamRewrite();
  // If an out-of-range value were honored (or clamped to the 1000ms
  // ceiling) instead of rejected, 22 words would take 44s (or 22s) — either
  // one blows well past this test's own 4s timeout, so a regression here
  // fails fast rather than hanging.
  assert.ok(elapsedMs < 2_000, `expected the default pace, got ${elapsedMs}ms`);
});

test("bounded: negative and non-numeric values fall back to the default pace",
  { timeout: 4_000 }, async () => {
  for (const invalid of ["-5", "not-a-number", ""]) {
    process.env[DRY_RUN_WORD_DELAY_VARIABLE] = invalid;
    const { elapsedMs } = await streamRewrite();
    assert.ok(elapsedMs < 2_000, `"${invalid}" expected the default pace, got ${elapsedMs}ms`);
  }
});

async function streamRewrite(
  options: { readonly noOverride?: boolean } = {}
): Promise<{ elapsedMs: number; text: string }> {
  const restore = options.noOverride ? process.env[DRY_RUN_WORD_DELAY_VARIABLE] : undefined;
  if (options.noOverride) delete process.env[DRY_RUN_WORD_DELAY_VARIABLE];
  const start = Date.now();
  let text = "";
  try {
    for await (const delta of streamCompletion(
      settings("dry-run"), prompt("rewrite"), new AbortController().signal
    )) {
      text += delta;
    }
  } finally {
    if (options.noOverride) {
      if (restore === undefined) delete process.env[DRY_RUN_WORD_DELAY_VARIABLE];
      else process.env[DRY_RUN_WORD_DELAY_VARIABLE] = restore;
    }
  }
  return { elapsedMs: Date.now() - start, text };
}

function settings(
  provider: GenerationSettings["provider"],
  overrides: Partial<GenerationSettings> = {}
): GenerationSettings {
  return {
    provider,
    baseUrl: "",
    model: "fixture",
    apiKeyEnv: null,
    temperature: null,
    maxTokens: 16,
    systemPrompt: "fixture",
    contextWindow: null,
    ...overrides
  };
}

function prompt(operation: PromptOperation): PromptPlan {
  return {
    operation,
    turns: [{
      role: "user",
      blocks: [{
        stability: "volatile",
        kind: "request",
        text: operation,
        boundaryAfter: "none"
      }]
    }]
  };
}

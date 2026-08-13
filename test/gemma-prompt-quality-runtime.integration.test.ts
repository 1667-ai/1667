import assert from "node:assert/strict";
import test from "node:test";
import { renderPromptPlan } from "../shared/prompt-plan.js";
import { baselineContinuationPlan } from "../evals/gemma-prompt-quality/baseline.js";
import {
  assertGemmaFixtureContextSize,
  GEMMA_AUTHOR_BRIEF,
  GEMMA_FACTS_BLOCK,
  GEMMA_LONG_STORY,
  GEMMA_OPERATION_FIXTURES,
  GEMMA_SCORING_CONTEXT
} from "../evals/gemma-prompt-quality/fixture.js";
import {
  parseReplayProfileManifest,
  replayProfileFromEvidence
} from "../evals/gemma-prompt-quality/profile.js";
import { parseGemmaRuntimeConfiguration } from "../evals/gemma-prompt-quality/runtime.js";
import { buildReplayRequestPairs } from "../evals/gemma-prompt-quality/runner.js";
import { assembleContinuation } from "../server/continuation-assembly.js";
import { isGemmaReplayCliEntry } from "../evals/gemma-prompt-quality/cli.js";
import { assertApprovedReplay, parseApprovedReplay } from "../evals/gemma-prompt-quality/approved-replay.js";

const runtime = parseGemmaRuntimeConfiguration({
  schemaVersion: 1,
  runtime: "llama.cpp",
  model: {
    id: "gemma-4-31b",
    identity: "Gemma 4 31B",
    artifact: {
      fileName: "gemma-4-31b-Q4_K_M.gguf",
      sha256: `sha256:${"a".repeat(64)}`,
      quantization: "Q4_K_M"
    }
  },
  llamaCpp: { build: "b1234", chatTemplate: "gemma", contextWindow: 32768 }
});

function manifest(logitBias: Record<string, number> = {}) {
  return {
    schemaVersion: 1,
    runtimeArtifactSha256: runtime.configuration.model.artifact.sha256,
    profile: {
      name: "Replay sampler",
      generation: {
        temperature: 0.7,
        maxOutputTokens: 400,
        effort: "default",
        cachePolicy: "off",
        tokenProbabilities: null
      },
      sampling: {
        topP: 0.92,
        topK: 40,
        minP: null,
        frequencyPenalty: null,
        presencePenalty: null,
        repeatPenalty: null,
        seed: null,
        dryMultiplier: null,
        dryBase: null,
        dryRange: null,
        xtcThreshold: null,
        xtcProbability: null,
        dynatempRange: null,
        mirostat: null,
        mirostatTau: null,
        mirostatEta: null,
        stop: [],
        logitBias,
        bannedStrings: [],
        phraseBias: [],
        dryBreakers: []
      }
    }
  };
}

test("Gemma replay manifest preserves raw bias and binds it to the checked artifact", () => {
  const profile = parseReplayProfileManifest(manifest({ "123": -2 }), runtime);
  assert.equal(profile.logitBiasState, "present");
  assert.deepEqual(profile.sampling.logitBias, { "123": -2 });
  assert.throws(
    () => parseReplayProfileManifest({ ...manifest(), runtimeArtifactSha256: `sha256:${"b".repeat(64)}` }, runtime),
    /does not match the checked runtime artifact/
  );
  assert.throws(
    () => parseReplayProfileManifest({
      ...manifest(),
      profile: { ...manifest().profile, sampling: { ...manifest().profile.sampling, logitBias: undefined } }
    }, runtime),
    /logitBias must be an object/
  );
  assert.throws(
    () => parseReplayProfileManifest({
      ...manifest(),
      profile: {
        ...manifest().profile,
        generation: { ...manifest().profile.generation, effort: "off" }
      }
    }, runtime),
    /requires generation\.effort to be default/
  );
  assert.throws(
    () => parseReplayProfileManifest(manifest({ "01": 0 }), runtime), /key "01" is invalid/);
  assert.throws(
    () => parseReplayProfileManifest(manifest({ "123": 101 }), runtime), /123 must be an integer in -100\.\.100/);
  assert.throws(
    () => parseReplayProfileManifest(manifest(Object.fromEntries(
      Array.from({ length: 201 }, (_, index) => [String(index), 0])
    )), runtime), /exceeds the 200-entry limit/);
});

test("Gemma replay manifest requires exact generation fields and rebuilds evidence profiles", () => {
  const missing = manifest();
  delete (missing.profile.generation as { tokenProbabilities?: number | null }).tokenProbabilities;
  assert.throws(
    () => parseReplayProfileManifest(missing, runtime),
    /generation has unsupported or missing fields/
  );
  assert.throws(
    () => parseReplayProfileManifest({
      ...manifest(),
      profile: {
        ...manifest().profile,
        generation: { ...manifest().profile.generation, unsupported: true }
      }
    }, runtime),
    /generation has unsupported or missing fields/
  );
  const profile = parseReplayProfileManifest(manifest({ "123": -2 }), runtime);
  const rebuilt = replayProfileFromEvidence({
    name: profile.name,
    sourceFingerprint: profile.sourceFingerprint,
    temperature: profile.temperature,
    maxOutputTokens: profile.maxOutputTokens,
    effort: profile.effort,
    cachePolicy: "off",
    tokenProbabilities: profile.tokenProbabilities,
    sampling: profile.sampling,
    logitBiasState: profile.logitBiasState
  }, runtime);
  assert.equal(rebuilt.sourceFingerprint, profile.sourceFingerprint);
});

test("Gemma replay requests exercise Author's Note and chapter-summary context", async () => {
  const profile = parseReplayProfileManifest(manifest(), runtime);
  const pairs = await buildReplayRequestPairs("http://127.0.0.1:8080/v1", runtime, profile);
  assert.equal(pairs.length, 10);
  for (const pair of pairs) {
    assert.doesNotThrow(() => assertGemmaFixtureContextSize(pair.baseline.prompt));
    assert.doesNotThrow(() => assertGemmaFixtureContextSize(pair.candidate.prompt));
    assert.deepEqual(
      pair.candidate.prompt,
      assembleContinuation({
        story: {
          authorBrief: GEMMA_AUTHOR_BRIEF,
          authorsNote: pair.operation.authorsNote.text,
          authorsNoteDepth: pair.operation.authorsNote.depth,
          chapterBreaks: pair.operation.chapterBreaks,
          nodes: pair.operation.nodes
        },
        settings: pair.settings,
        contextParts: pair.operation.context,
        instruction: pair.operation.instruction,
        appendLast: pair.operation.appendLast,
        images: []
      }).plan(GEMMA_FACTS_BLOCK).prompt
    );
    const candidate = JSON.stringify(renderPromptPlan(pair.candidate.prompt));
    assert.match(candidate, /Keep the bell's sound physical/);
    assert.match(candidate, /Inherited continuity summary of/);
    const baseline = JSON.stringify(renderPromptPlan(baselineContinuationPlan(
      pair.operation,
      GEMMA_AUTHOR_BRIEF,
      GEMMA_FACTS_BLOCK
    )));
    assert.match(baseline, /Keep the bell's sound physical/);
    assert.match(baseline, /Inherited continuity summary of/);
    assert.deepEqual(
      baselineContinuationPlan(pair.operation, GEMMA_AUTHOR_BRIEF, GEMMA_FACTS_BLOCK).turns.map((turn) => ({
        role: turn.role,
        kinds: turn.blocks.map((block) => block.kind)
      })),
      pair.candidate.prompt.turns.map((turn) => ({
        role: turn.role,
        kinds: turn.blocks.map((block) => block.kind)
      }))
    );
  }
  assert.equal(GEMMA_OPERATION_FIXTURES.length, 2);
});

test("Gemma fixture rejects a shortened rendered context", () => {
  assert.throws(
    () => assertGemmaFixtureContextSize({ operation: "continue", turns: [] }),
    /fixture context must contain at least 20000 UTF-8 bytes/
  );
});

test("Gemma fixture follows the tower collapse into the marked-channel seam", () => {
  assert.match(GEMMA_LONG_STORY[4]!.text, /not yet an answer\.$/);
  assert.match(GEMMA_LONG_STORY[5]!.text, /^By dawn, the ferry house/);
  assert.match(GEMMA_LONG_STORY[6]!.text, /^Jun woke when Mara lifted the ferry rope/);
  assert.match(GEMMA_LONG_STORY[7]!.text, /began to$/);
  assert.doesNotMatch(GEMMA_LONG_STORY[6]!.text, /The first bell struck/);
  assert.match(GEMMA_SCORING_CONTEXT.facts.join("\n"), /collapsed tower/);
});

test("Gemma replay CLI entry check accepts native and Windows paths", () => {
  assert.equal(isGemmaReplayCliEntry("/work/evals/gemma-prompt-quality/cli.ts"), true);
  assert.equal(isGemmaReplayCliEntry("C:\\work\\evals\\gemma-prompt-quality\\cli.ts"), true);
  assert.equal(isGemmaReplayCliEntry("/work/other/cli.ts"), false);
});

test("approved Gemma replay protocol rejects changed or incomplete fields", () => {
  assert.throws(() => parseApprovedReplay({ schemaVersion: 1 }), /unsupported, missing, or changed/);
  assert.throws(() => parseApprovedReplay({
    schemaVersion: 1,
    runtime: { runtime: "llama.cpp", modelId: "gemma-4-31b" },
    profile: {}
  }), /unsupported, missing, or changed/);
});

test("approved Gemma replay protocol rejects changed profiles and runtimes", () => {
  const profile = parseReplayProfileManifest(approvedManifest(), runtime);
  assert.doesNotThrow(() => assertApprovedReplay(runtime, profile));
  assert.throws(
    () => assertApprovedReplay(runtime, { ...profile, maxOutputTokens: 401 }),
    /profile does not match approved replay protocol/
  );
  assert.throws(
    () => assertApprovedReplay(runtime, { ...profile, temperature: 0.6 }),
    /profile does not match approved replay protocol/
  );
  assert.throws(
    () => assertApprovedReplay(runtime, { ...profile, sampling: { ...profile.sampling, topK: 41 } }),
    /profile does not match approved replay protocol/
  );
  for (const changedRuntime of [
    runtimeConfiguration({ chatTemplate: "chatml" }),
    runtimeConfiguration({ contextWindow: 32767 }),
    runtimeConfiguration({ quantization: "Q5_K_M" })
  ]) {
    assert.throws(
      () => assertApprovedReplay(changedRuntime, profile),
      /runtime does not match approved replay protocol/
    );
  }
});

function approvedManifest() {
  const value = manifest();
  return {
    ...value,
    profile: {
      ...value.profile,
      sampling: { ...value.profile.sampling, minP: 0.05, repeatPenalty: 1.08 }
    }
  };
}

function runtimeConfiguration(changes: {
  readonly chatTemplate?: string;
  readonly contextWindow?: number;
  readonly quantization?: string;
}) {
  return parseGemmaRuntimeConfiguration({
    schemaVersion: 1,
    runtime: "llama.cpp",
    model: {
      id: "gemma-4-31b",
      identity: "Gemma 4 31B",
      artifact: {
        fileName: "gemma-4-31b-Q4_K_M.gguf",
        sha256: `sha256:${"a".repeat(64)}`,
        quantization: changes.quantization ?? "Q4_K_M"
      }
    },
    llamaCpp: {
      build: "b1234",
      chatTemplate: changes.chatTemplate ?? "gemma",
      contextWindow: changes.contextWindow ?? 32768
    }
  });
}

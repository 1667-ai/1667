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
  replayProfileFromEvidence,
  replaySettings
} from "../evals/gemma-prompt-quality/profile.js";
import { parseGemmaRuntimeConfiguration } from "../evals/gemma-prompt-quality/runtime.js";
import { buildReplayRequestPairs } from "../evals/gemma-prompt-quality/runner.js";
import { GEMMA_CANDIDATE_OPTIMIZATION } from "../evals/gemma-prompt-quality/contract.js";
import { assembleContinuation } from "../server/continuation-assembly.js";
import { providerRuntimeFor } from "../server/provider-runtime.js";
import { defaultConnectionTimeouts } from "../shared/settings-provider-defaults.js";
import { isGemmaReplayCliEntry } from "../evals/gemma-prompt-quality/cli.js";
import { assertApprovedReplay, parseApprovedReplay } from "../evals/gemma-prompt-quality/approved-replay.js";

const runtime = parseGemmaRuntimeConfiguration({
  schemaVersion: 1,
  runtime: "koboldcpp",
  model: {
    id: "koboldcpp/gemma-4-31B-it-uncensored-heretic-Q8_0",
    identity: "Gemma 4 31B test runtime",
    artifact: {
      fileName: "gemma-4-31B-it-uncensored-heretic-Q8_0.gguf",
      sha256: `sha256:${"a".repeat(64)}`,
      quantization: "Q8_0"
    }
  },
  koboldCpp: {
    version: "1.117.1",
    chatTemplateSha256: "sha256:0a52be69cda5ab8aeb627d6ff51a7b34c7d06afabb6b0f00cf8ee63df16a6315",
    contextWindow: 32768
  }
});

const PREFILL_CONTINUITY_GUARD = "Preserve the established point of view and tense.";

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
      },
      timeouts: { responseHeaderMs: 600_000, firstTokenMs: 120_000, idleMs: 120_000, totalMs: 1_800_000 }
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
      Array.from({ length: 17 }, (_, index) => [String(index), 0])
    )), runtime), /exceeds the KoboldCpp 16-entry limit/);
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
    timeouts: profile.timeouts,
    logitBiasState: profile.logitBiasState
  }, runtime);
  assert.equal(rebuilt.sourceFingerprint, profile.sourceFingerprint);
});

test("Gemma replay requests exercise Author's Note and chapter-summary context", async () => {
  const profile = parseReplayProfileManifest(manifest(), runtime);
  const pairs = await buildReplayRequestPairs(
    "http://127.0.0.1:8080/v1",
    runtime,
    profile,
    GEMMA_CANDIDATE_OPTIMIZATION
  );
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
    if (pair.operation.operation === "retake") {
      assert.match(candidate, /Write the next passage of the story in response to the final user direction\./);
      assert.match(candidate, /Return only story prose: no summary, explanation, or commentary\./);
      assert.doesNotMatch(candidate, /Continuation mode: the final assistant message is an unfinished passage\./);
      assert.doesNotMatch(candidate, /Preserve the established point of view and tense\./);
    } else {
      assert.match(candidate, new RegExp(PREFILL_CONTINUITY_GUARD));
      assert.doesNotMatch(candidate, /Write the next passage of the story in response to the final user direction\./);
      assert.doesNotMatch(candidate, /Continuation mode: the final assistant message is an unfinished passage\./);
    }
    const baseline = JSON.stringify(renderPromptPlan(baselineContinuationPlan(
      pair.operation,
      GEMMA_AUTHOR_BRIEF,
      GEMMA_FACTS_BLOCK
    )));
    assert.match(baseline, /Keep the bell's sound physical/);
    assert.match(baseline, /Inherited continuity summary of/);
    assert.notDeepEqual(
      renderPromptPlan(baselineContinuationPlan(
        pair.operation,
        GEMMA_AUTHOR_BRIEF,
        GEMMA_FACTS_BLOCK
      )),
      renderPromptPlan(pair.candidate.prompt)
    );
  }
  assert.equal(GEMMA_OPERATION_FIXTURES.length, 2);
});

test("Gemma replay resolves both layouts through the production settings runtime", () => {
  const profile = parseReplayProfileManifest(manifest(), runtime);
  const baseline = replaySettings("http://127.0.0.1:8080/v1", runtime.configuration, profile, 101);
  const candidate = replaySettings(
    "http://127.0.0.1:8080/v1",
    runtime.configuration,
    profile,
    101,
    GEMMA_CANDIDATE_OPTIMIZATION
  );
  assert.equal(providerRuntimeFor(baseline).continuationPromptLayout, "compatibility");
  assert.equal(providerRuntimeFor(candidate).continuationPromptLayout, "late-cache-stable");
  assert.equal(providerRuntimeFor(candidate).sampling.seed, 101);
});

test("Gemma replay uses its bound header deadline without changing product defaults", () => {
  const profile = parseReplayProfileManifest(manifest(), runtime);
  const settings = replaySettings("http://127.0.0.1:8080/v1", runtime.configuration, profile, 101);
  assert.deepEqual(providerRuntimeFor(settings).timeouts, profile.timeouts);
  assert.equal(providerRuntimeFor(settings).timeouts.responseHeaderMs, 600_000);
  assert.equal(defaultConnectionTimeouts("openai-compatible").responseHeaderMs, 120_000);
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
    runtime: { runtime: "koboldcpp", modelId: "koboldcpp/gemma-4-31B-it-uncensored-heretic-Q8_0" },
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
  assert.throws(
    () => assertApprovedReplay(runtime, {
      ...profile,
      timeouts: { ...profile.timeouts, responseHeaderMs: 120_000 }
    }),
    /profile does not match approved replay protocol/
  );
  for (const changedRuntime of [
    runtimeConfiguration({ chatTemplateSha256: `sha256:${"b".repeat(64)}` }),
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
  readonly chatTemplateSha256?: string;
  readonly contextWindow?: number;
  readonly quantization?: string;
}) {
  return parseGemmaRuntimeConfiguration({
    schemaVersion: 1,
    runtime: "koboldcpp",
    model: {
      id: "koboldcpp/gemma-4-31B-it-uncensored-heretic-Q8_0",
      identity: "Gemma 4 31B test runtime",
      artifact: {
        fileName: "gemma-4-31B-it-uncensored-heretic-Q8_0.gguf",
        sha256: `sha256:${"a".repeat(64)}`,
        quantization: changes.quantization ?? "Q8_0"
      }
    },
    koboldCpp: {
      version: "1.117.1",
      chatTemplateSha256: changes.chatTemplateSha256 ?? "sha256:0a52be69cda5ab8aeb627d6ff51a7b34c7d06afabb6b0f00cf8ee63df16a6315",
      contextWindow: changes.contextWindow ?? 32768
    }
  });
}

import assert from "node:assert/strict";
import test from "node:test";
import type { SamplingSettingsV2 } from "../shared/settings-v2-types.js";
import { streamCompletion } from "../server/providers.js";
import { ownedLoopbackHttpSupported } from "../server/provider-fetch.js";
import { providerRuntimeFor } from "../server/provider-runtime.js";
import { SettingsStore } from "../server/settings.js";
import {
  FIXED_TIME,
  MUTATION_A,
  MUTATION_B,
  MUTATION_C,
  initializedFormat2Directory,
  saveCommand
} from "./settings-store-fixtures.js";
import {
  collect,
  documentFor,
  LLAMA_CPP_FIXTURE_TOKENS,
  PROMPT,
  startProviderFixture
} from "./sampling-e2e-fixtures.js";

test("saved llama.cpp sampling survives activation and restart and reaches the wire", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  const fixture = await startProviderFixture(t);
  const dataDir = await initializedFormat2Directory(t, "1667-sampling-llama-e2e-");
  const first = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await first.init(2);
  const sampling: SamplingSettingsV2 = {
    topP: 0.9,
    topK: 40,
    minP: 0.05,
    frequencyPenalty: 0.2,
    presencePenalty: -0.1,
    repeatPenalty: 1.1,
    seed: 42,
    stop: ["END", "DONE"],
    logitBias: { "15043": 1 },
    bannedStrings: [],
    phraseBias: []
  };
  await first.save(saveCommand(
    MUTATION_A,
    1,
    documentFor(fixture.origin, "llama-cpp", "e2e-model", sampling)
  ));

  const restarted = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await restarted.init(2);
  const runtime = await restarted.loadGeneration();
  assert.deepEqual(providerRuntimeFor(runtime.settings).sampling, sampling);
  await collect(streamCompletion(runtime.settings, PROMPT, new AbortController().signal));
  const body = fixture.bodies.at(-1)!;
  assert.deepEqual({
    top_p: body.top_p,
    top_k: body.top_k,
    min_p: body.min_p,
    frequency_penalty: body.frequency_penalty,
    presence_penalty: body.presence_penalty,
    repeat_penalty: body.repeat_penalty,
    seed: body.seed,
    stop: body.stop,
    logit_bias: body.logit_bias
  }, {
    top_p: 0.9,
    top_k: 40,
    min_p: 0.05,
    frequency_penalty: 0.2,
    presence_penalty: -0.1,
    repeat_penalty: 1.1,
    seed: 42,
    stop: ["END", "DONE"],
    logit_bias: { "15043": 1 }
  });
});

test("phrase bias and banned strings tokenize and merge into logit_bias, with explicit entries winning", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  const fixture = await startProviderFixture(t);
  const dataDir = await initializedFormat2Directory(t, "1667-sampling-phrase-bias-e2e-");
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await store.init(2);
  // "dragon" and "wolf" are each single-token in every one of the four
  // surface variants (typed, leading space, capitalized, leading space
  // capitalized — shared/sampling-capabilities.ts) under o200k_base,
  // verified with tokenizePhraseTokenIds, so both resolve rather than
  // being rejected. "dragon" appears in both phraseBias and bannedStrings
  // to exercise the documented merge order (server/sampling-phrase-bias.ts):
  // bannedStrings outranks phraseBias, and an explicit numeric logitBias
  // entry outranks both — but only for the one token ID it names; "dragon"'s
  // other three variant IDs still carry bannedStrings' bias.
  await store.save(saveCommand(
    `m1.1767225600004.${"f".repeat(32)}`,
    1,
    documentFor(fixture.origin, "openai", "gpt-4o", {
      topP: null,
      topK: null,
      minP: null,
      frequencyPenalty: null,
      presencePenalty: null,
      repeatPenalty: null,
      seed: null,
      stop: [],
      logitBias: { "84021": 42 },
      phraseBias: [{ phrase: "dragon", weight: 5 }],
      bannedStrings: ["dragon", "wolf"]
    })
  ));
  const runtime = await store.loadGeneration();
  await collect(streamCompletion(runtime.settings, PROMPT, new AbortController().signal));
  const body = fixture.bodies.at(-1)!;
  assert.deepEqual(body.logit_bias, {
    // The explicit numeric entry wins over both text sources for the one
    // token ID it names ("dragon" typed).
    "84021": 42,
    // "dragon"'s other three variants ( " dragon", "Dragon", " Dragon")
    // still carry bannedStrings' bias — the documented minimum weight, see
    // SAMPLING_LOGIT_BIAS_POLICY.minimum.
    "45342": -100,
    "91530": -100,
    "34057": -100,
    // "wolf"'s four variants, all biased to the same minimum.
    "92538": -100,
    "66316": -100,
    "126693": -100,
    "35565": -100
  });
});

// Issue #282 stage 1, point 5: llama.cpp resolves phraseBias/bannedStrings
// through its own live POST /tokenize endpoint (server/context-probe.ts,
// probeLlamaCppTokenize) rather than trusting its reported model name. This
// drives the whole pipeline — save, load, generate — against a fixture
// server that actually answers /tokenize, proving the resolved bias reaches
// the real chat-completions wire body.
test("llama.cpp phrase bias resolves through its own tokenize endpoint and reaches the wire", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  const fixture = await startProviderFixture(t, { "whatever-this-server-calls-itself": LLAMA_CPP_FIXTURE_TOKENS });
  const dataDir = await initializedFormat2Directory(t, "1667-sampling-llama-tokenize-e2e-");
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await store.init(2);
  await store.save(saveCommand(
    `m1.1767225600005.${"a".repeat(32)}`,
    1,
    documentFor(fixture.origin, "llama-cpp", "whatever-this-server-calls-itself", {
      topP: null,
      topK: null,
      minP: null,
      frequencyPenalty: null,
      presencePenalty: null,
      repeatPenalty: null,
      seed: null,
      stop: [],
      logitBias: {},
      phraseBias: [{ phrase: "griffin", weight: -3 }],
      bannedStrings: []
    })
  ));
  const runtime = await store.loadGeneration();
  await collect(streamCompletion(runtime.settings, PROMPT, new AbortController().signal));
  const body = fixture.bodies.at(-1)!;
  assert.deepEqual(body.logit_bias, {
    "501": -3,
    "502": -3,
    "503": -3,
    "504": -3
  });
});

// Regression test for issue #282 review round 2, finding 3: the tokenize
// probe originally posted only `{ content }`, with no model selector.
// llama.cpp routes POST endpoints by the body's `model` field
// (tools/server/README.md), so a multi-model server in router mode rejects
// a body with no model outright, and a server that instead fell back to a
// default would silently answer from the wrong vocabulary. The fixture
// below models a llama-server hosting two models and, like router mode,
// requires an exact `model` match before it answers — a probe that forgot
// to send the routed connection's own model could never pass this test.
test("llama.cpp tokenize probe sends the routed model, not just the text", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  const fixture = await startProviderFixture(t, {
    "qwen3-8b": LLAMA_CPP_FIXTURE_TOKENS,
    // A different vocabulary for the second model: if the probe ever sent
    // the wrong model (or none), and the fixture answered anyway, these
    // IDs would show up on the wire instead of the expected ones.
    "llama3-8b": { griffin: 901, " griffin": 902, Griffin: 903, " Griffin": 904 }
  });
  const dataDir = await initializedFormat2Directory(t, "1667-sampling-llama-tokenize-model-e2e-");
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await store.init(2);
  await store.save(saveCommand(
    `m1.1767225600006.${"b".repeat(32)}`,
    1,
    documentFor(fixture.origin, "llama-cpp", "qwen3-8b", {
      topP: null,
      topK: null,
      minP: null,
      frequencyPenalty: null,
      presencePenalty: null,
      repeatPenalty: null,
      seed: null,
      stop: [],
      logitBias: {},
      phraseBias: [{ phrase: "griffin", weight: -3 }],
      bannedStrings: []
    })
  ));
  const runtime = await store.loadGeneration();
  await collect(streamCompletion(runtime.settings, PROMPT, new AbortController().signal));
  const body = fixture.bodies.at(-1)!;
  assert.deepEqual(body.logit_bias, {
    "501": -3,
    "502": -3,
    "503": -3,
    "504": -3
  });
});

// Regression test for issue #282 review round 2, finding 6: llama-cpp used
// to skip save-time bias validation wholesale, so a phrase the live server
// cannot resolve to one token per surface variant — here, the fixture has
// no entry at all for " Hydra" (leading-space-capitalized) — could save
// cleanly and only fail later, mid-generation, with the writer's only
// feedback a failed request. Save-time validation must reach the same live
// probe and reject it up front, leaving the active document untouched.
test("llama.cpp save-time validation rejects a phrase the live server cannot resolve to one token per variant", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  const fixture = await startProviderFixture(t, {
    "e2e-model": { hydra: 601, " hydra": 602, Hydra: 603 }
  });
  const dataDir = await initializedFormat2Directory(t, "1667-sampling-llama-save-validate-");
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await store.init(2);
  const before = (await store.loadView()).document;
  const candidate = documentFor(fixture.origin, "llama-cpp", "e2e-model", {
    topP: null,
    topK: null,
    minP: null,
    frequencyPenalty: null,
    presencePenalty: null,
    repeatPenalty: null,
    seed: null,
    stop: [],
    logitBias: {},
    phraseBias: [{ phrase: "hydra", weight: 2 }],
    bannedStrings: []
  });
  await assert.rejects(
    () => store.save(saveCommand(MUTATION_C, 1, candidate)),
    /hydra.*is 0 tokens/s
  );
  assert.deepEqual((await store.loadView()).document, before);
});

test("unset sampling knobs stay absent from an activated OpenAI request", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  const fixture = await startProviderFixture(t);
  const dataDir = await initializedFormat2Directory(t, "1667-sampling-omit-e2e-");
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await store.init(2);
  await store.save(saveCommand(
    MUTATION_B,
    1,
    documentFor(fixture.origin, "custom", "e2e-model", {
      topP: 0.9,
      topK: null,
      minP: null,
      frequencyPenalty: null,
      presencePenalty: null,
      repeatPenalty: null,
      seed: null,
      stop: [],
      logitBias: {},
      bannedStrings: [],
      phraseBias: []
    })
  ));
  const runtime = await store.loadGeneration();
  await collect(streamCompletion(runtime.settings, PROMPT, new AbortController().signal));
  assert.deepEqual(Object.keys(fixture.bodies.at(-1)!).sort(), [
    "max_tokens",
    "messages",
    "model",
    "stream",
    "temperature",
    "top_p"
  ]);
});

test("Ollama rejects logit bias at save time without changing the active document", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-sampling-ollama-save-");
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await store.init(2);
  const before = (await store.loadView()).document;
  const candidate = documentFor("http://127.0.0.1:11434/v1", "ollama", "ollama-model", {
    topP: null,
    topK: null,
    minP: null,
    frequencyPenalty: null,
    presencePenalty: null,
    repeatPenalty: null,
    seed: null,
    stop: [],
    logitBias: { "1": 1 },
    bannedStrings: [],
    phraseBias: []
  });
  await assert.rejects(
    () => store.save(saveCommand(MUTATION_C, 1, candidate)),
    /logit bias.*preset/u
  );
  assert.deepEqual((await store.loadView()).document, before);
});

test("Anthropic lowering uses stop_sequences and does not emit OpenAI stop", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  const fixture = await startProviderFixture(t);
  const dataDir = await initializedFormat2Directory(t, "1667-sampling-anthropic-e2e-");
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await store.init(2);
  await store.save(saveCommand(
    `m1.1767225600003.${"e".repeat(32)}`,
    1,
    documentFor(fixture.origin, "custom", "claude-opus-4-5", {
      topP: 0.9,
      topK: 32,
      minP: null,
      frequencyPenalty: null,
      presencePenalty: null,
      repeatPenalty: null,
      seed: null,
      stop: ["END"],
      logitBias: {},
      bannedStrings: [],
      phraseBias: []
    }, "anthropic")
  ));
  const runtime = await store.loadGeneration();
  await collect(streamCompletion(runtime.settings, PROMPT, new AbortController().signal));
  const body = fixture.bodies.at(-1)!;
  assert.deepEqual(body.stop_sequences, ["END"]);
  assert.equal("stop" in body, false);
});

test("Anthropic Messages rejects seed at save time without changing the active document", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-sampling-anthropic-seed-save-");
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await store.init(2);
  const before = (await store.loadView()).document;
  const candidate = documentFor("https://api.anthropic.com", "anthropic", "claude-opus-4-5", {
    topP: null,
    topK: null,
    minP: null,
    frequencyPenalty: null,
    presencePenalty: null,
    repeatPenalty: null,
    seed: 42,
    stop: [],
    logitBias: {},
    bannedStrings: [],
    phraseBias: []
  }, "anthropic");
  await assert.rejects(
    () => store.save(saveCommand(MUTATION_C, 1, candidate)),
    /seed.*protocol/u
  );
  assert.deepEqual((await store.loadView()).document, before);
});

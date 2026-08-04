import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import {
  EMPTY_SAMPLING_V2,
  type SamplingSettingsV2
} from "../shared/settings-v2-types.js";
import { ServiceError } from "../server/errors.js";
import { streamCompletion } from "../server/providers.js";
import { ownedLoopbackHttpSupported } from "../server/provider-fetch.js";
import { providerRuntimeFor } from "../server/provider-runtime.js";
import { SettingsStore } from "../server/settings.js";
import { SAMPLING_BIAS_SAVE_PROBE_DEADLINE_MS } from "../server/settings-v2-store.js";
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
  KOBOLDCPP_FIXTURE_TOKENS,
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
    dryMultiplier: 0.8,
    dryBase: 1.75,
    dryRange: 1024,
    xtcThreshold: 0.1,
    xtcProbability: 0.5,
    dynatempRange: 0.45,
    mirostat: 2,
    mirostatTau: 5,
    mirostatEta: 0.1,
    stop: ["END", "DONE"],
    logitBias: { "15043": 1 },
    bannedStrings: [],
    phraseBias: [],
    dryBreakers: ["\n", ":", "\"", "*"]
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
    dry_multiplier: body.dry_multiplier,
    dry_base: body.dry_base,
    dry_penalty_last_n: body.dry_penalty_last_n,
    xtc_threshold: body.xtc_threshold,
    xtc_probability: body.xtc_probability,
    dynatemp_range: body.dynatemp_range,
    mirostat: body.mirostat,
    mirostat_tau: body.mirostat_tau,
    mirostat_eta: body.mirostat_eta,
    stop: body.stop,
    logit_bias: body.logit_bias,
    dry_sequence_breakers: body.dry_sequence_breakers
  }, {
    top_p: 0.9,
    top_k: 40,
    min_p: 0.05,
    frequency_penalty: 0.2,
    presence_penalty: -0.1,
    repeat_penalty: 1.1,
    seed: 42,
    dry_multiplier: 0.8,
    dry_base: 1.75,
    dry_penalty_last_n: 1024,
    xtc_threshold: 0.1,
    xtc_probability: 0.5,
    dynatemp_range: 0.45,
    mirostat: 2,
    mirostat_tau: 5,
    mirostat_eta: 0.1,
    stop: ["END", "DONE"],
    logit_bias: { "15043": 1 },
    dry_sequence_breakers: ["\n", ":", "\"", "*"]
  });
});

test("saved KoboldCpp sampling with the new knobs reaches the wire", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  const fixture = await startProviderFixture(t);
  const dataDir = await initializedFormat2Directory(t, "1667-sampling-koboldcpp-e2e-");
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await store.init(2);
  const sampling: SamplingSettingsV2 = {
    ...EMPTY_SAMPLING_V2,
    topP: 0.92,
    topK: 50,
    minP: 0.02,
    // KoboldCpp does not document frequencyPenalty; leave it unset.
    repeatPenalty: 1.05,
    dryMultiplier: 0.6,
    dryBase: 2,
    dryRange: 512,
    xtcThreshold: 0.15,
    xtcProbability: 0.3,
    dynatempRange: 0.2,
    mirostat: 1,
    mirostatTau: 4.5,
    mirostatEta: 0.2,
    dryBreakers: ["\n"]
  };
  await store.save(saveCommand(
    `m1.1767225600004.${"f".repeat(32)}`,
    1,
    documentFor(fixture.origin, "koboldcpp", "e2e-model", sampling)
  ));
  const runtime = await store.loadGeneration();
  await collect(streamCompletion(runtime.settings, PROMPT, new AbortController().signal));
  const body = fixture.bodies.at(-1)!;
  assert.equal("frequency_penalty" in body, false);
  assert.deepEqual({
    top_p: body.top_p,
    top_k: body.top_k,
    min_p: body.min_p,
    repeat_penalty: body.repeat_penalty,
    dry_multiplier: body.dry_multiplier,
    dry_base: body.dry_base,
    dry_penalty_last_n: body.dry_penalty_last_n,
    xtc_threshold: body.xtc_threshold,
    xtc_probability: body.xtc_probability,
    dynatemp_range: body.dynatemp_range,
    mirostat_mode: body.mirostat_mode,
    mirostat_tau: body.mirostat_tau,
    mirostat_eta: body.mirostat_eta,
    dry_sequence_breakers: body.dry_sequence_breakers
  }, {
    top_p: 0.92,
    top_k: 50,
    min_p: 0.02,
    repeat_penalty: 1.05,
    dry_multiplier: 0.6,
    dry_base: 2,
    dry_penalty_last_n: 512,
    xtc_threshold: 0.15,
    xtc_probability: 0.3,
    dynatemp_range: 0.2,
    mirostat_mode: 1,
    mirostat_tau: 4.5,
    mirostat_eta: 0.2,
    dry_sequence_breakers: ["\n"]
  });
  // KoboldCpp's OpenAI-compatible adapter writes `mirostat_mode` over
  // `mirostat`, so a request that names `mirostat` arrives as mode 0.
  assert.equal("mirostat" in body, false);
});

// Tau and eta left set after Mirostat goes off once blocked the whole
// settings save. The serializer and the panel each cover their half, but
// every case above has Mirostat on, so this walks that state through a real
// save, restart, and request.
test("mirostat off with tau and eta configured omits all three mirostat fields on the wire", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  const fixture = await startProviderFixture(t);
  const dataDir = await initializedFormat2Directory(t, "1667-sampling-mirostat-off-e2e-");
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await store.init(2);
  const sampling: SamplingSettingsV2 = {
    ...EMPTY_SAMPLING_V2,
    topP: 0.9,
    seed: 42,
    mirostat: null,
    mirostatTau: 5,
    mirostatEta: 0.1
  };
  await store.save(saveCommand(
    `m1.1767225600009.${"9".repeat(32)}`,
    1,
    documentFor(fixture.origin, "llama-cpp", "e2e-model", sampling)
  ));
  const runtime = await store.loadGeneration();
  assert.deepEqual(providerRuntimeFor(runtime.settings).sampling, sampling);
  await collect(streamCompletion(runtime.settings, PROMPT, new AbortController().signal));
  const body = fixture.bodies.at(-1)!;
  assert.equal("mirostat" in body, false);
  assert.equal("mirostat_tau" in body, false);
  assert.equal("mirostat_eta" in body, false);
  // The ordinary knobs must still reach the wire, so this test would fail
  // if sampling were dropped wholesale rather than just the inactive
  // mirostat knobs.
  assert.equal(body.top_p, 0.9);
  assert.equal(body.seed, 42);
});

test("an LM Studio route with DRY configured refuses to save, naming the reason", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  const fixture = await startProviderFixture(t);
  const dataDir = await initializedFormat2Directory(t, "1667-sampling-lm-studio-dry-e2e-");
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await store.init(2);
  const candidate = documentFor(fixture.origin, "lm-studio", "e2e-model", {
    ...EMPTY_SAMPLING_V2,
    dryMultiplier: 0.8
  });
  const before = (await store.loadView()).document;
  await assert.rejects(
    () => store.save(saveCommand(`m1.1767225600005.${"5".repeat(32)}`, 1, candidate)),
    /dry multiplier.*support is unknown for this provider/u
  );
  assert.deepEqual((await store.loadView()).document, before);
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
  // being rejected. The three sources here — phraseBias, bannedStrings, and
  // the raw numeric map — name disjoint tokens, so all three merge into one
  // object additively (server/sampling-phrase-bias.ts documents the merge
  // order: phraseBias, then bannedStrings, then the explicit numeric map).
  // A phrase that instead collides with a higher-priority entry over the
  // same token is a different, blocking outcome — issue #282 review round
  // 3, findings 1 and 2 — covered at the request-serializer boundary in
  // test/provider-request-body.test.ts, not here: this test's job is the
  // additive, non-conflicting path all the way through a real save, load,
  // and generate round trip.
  await store.save(saveCommand(
    `m1.1767225600004.${"f".repeat(32)}`,
    1,
    documentFor(fixture.origin, "openai", "gpt-4o", {
      ...EMPTY_SAMPLING_V2,
      logitBias: { "1234": -7 },
      phraseBias: [{ phrase: "dragon", weight: 5 }],
      bannedStrings: ["wolf"]
    })
  ));
  const runtime = await store.loadGeneration();
  await collect(streamCompletion(runtime.settings, PROMPT, new AbortController().signal));
  const body = fixture.bodies.at(-1)!;
  assert.deepEqual(body.logit_bias, {
    // The explicit numeric entry, standing on its own.
    "1234": -7,
    // "dragon"'s four variants, all at the phrase's own weight.
    "84021": 5,
    "45342": 5,
    "91530": 5,
    "34057": 5,
    // "wolf"'s four variants, all biased to the documented minimum — see
    // SAMPLING_LOGIT_BIAS_POLICY.minimum.
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
      ...EMPTY_SAMPLING_V2,
      phraseBias: [{ phrase: "griffin", weight: -3 }]
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
  // Regression test for issue #282 review round 3, finding 4b: every
  // /tokenize call must send `parse_special: false`. llama.cpp's server
  // README documents this field's default as `true`, under which a special
  // token in the writer's literal text (for example `<|eot_id|>`) tokenizes
  // to that one control token instead of the ordinary tokens that spell the
  // text — resolving an ID that does not represent what the writer typed.
  assert.ok(fixture.tokenizeBodies.length > 0);
  for (const tokenizeBody of fixture.tokenizeBodies) {
    assert.equal(tokenizeBody.parse_special, false);
  }
});

// Regression test for issue #282 review round 2, finding 3: the tokenize
// probe originally posted only `{ content }`, with no model selector. A
// multi-model (router-mode) llama.cpp server needs a `model` field to pick
// which model answers, so a server that fell back to a default instead
// could silently answer from the wrong vocabulary. llama.cpp's server
// README does not document `model` as a `/tokenize` field (issue #282
// review round 3, finding 4c) — it is 1667's own routing convenience, not a
// documented contract — so this test, and the fixture below, exercise
// 1667's own assumption about router-mode behavior, not a verified round
// trip against a real server. The fixture models a llama-server hosting two
// models and requires an exact `model` match before it answers — a probe
// that forgot to send the routed connection's own model could never pass
// this test.
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
      ...EMPTY_SAMPLING_V2,
      phraseBias: [{ phrase: "griffin", weight: -3 }]
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
    ...EMPTY_SAMPLING_V2,
    phraseBias: [{ phrase: "hydra", weight: 2 }]
  });
  await assert.rejects(
    () => store.save(saveCommand(MUTATION_C, 1, candidate)),
    (error: unknown) => {
      assert.match((error as Error).message, /hydra.*is 0 tokens/s);
      // The save path must throw a ServiceError, not a bare
      // SettingsFormatError: the worker/HTTP transport's error
      // classification (server/service-error-policy.ts) only recognizes
      // ServiceError and a short allow-list of other known types, and
      // reports anything else as a generic "Internal server error" —
      // which would have silently swallowed this exact validation message.
      assert.ok(error instanceof ServiceError, "expected a ServiceError, not a raw SettingsFormatError");
      assert.equal(error.status, 400);
      return true;
    }
  );
  assert.deepEqual((await store.loadView()).document, before);
});

// Issue #311 review, second pass, BLOCKER B, save-time counterpart to the
// request-time refusal in test/provider-request-body.test.ts: a profile
// configuring phraseBias "ember"@5 and bannedStrings "ember" together on
// KoboldCpp must not save. `validateSamplingRoute`
// (server/settings-v2-sampling-validation.ts) only reaches KoboldCpp's live
// resolution through the save path's own async probe
// (server/settings-v2-save-bias-check.ts), so this needs a real reachable
// fixture the way the llama.cpp save-time test above does, not the
// synchronous fallback the numeric-only save-time test uses. Issue #311
// review, third pass, findings G/H reworked the native path to reuse
// `settleTokenOwnership` itself, so the phraseBias entry now reports the
// same "shadowed" message every token-merge preset already uses for the
// identical contradiction, not a bespoke native-only message.
test("KoboldCpp save-time validation rejects a phrase bias that contradicts a same-scope banned string", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  const fixture = await startProviderFixture(t, undefined, { koboldTokenizeMap: KOBOLDCPP_FIXTURE_TOKENS });
  const dataDir = await initializedFormat2Directory(t, "1667-sampling-kobold-save-contradiction-");
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await store.init(2);
  const before = (await store.loadView()).document;
  const candidate = documentFor(fixture.origin, "koboldcpp", "kobold-model", {
    ...EMPTY_SAMPLING_V2,
    phraseBias: [{ phrase: "ember", weight: 5 }],
    bannedStrings: ["ember"]
  });
  await assert.rejects(
    () => store.save(saveCommand(MUTATION_C, 1, candidate)),
    (error: unknown) => {
      assert.match(
        (error as Error).message,
        /"ember" loses its bias on .* to banned string "ember", which takes precedence there/
      );
      assert.ok(error instanceof ServiceError, "expected a ServiceError, not a raw SettingsFormatError");
      assert.equal(error.status, 400);
      return true;
    }
  );
  assert.deepEqual((await store.loadView()).document, before);
});

/** A fixture that answers `/v1/models` normally but never answers
 * `/tokenize` at all — standing in for a blackholed host (a sleeping
 * laptop, a dropped VPN, a stale address), not a refused connection, which
 * fails fast on its own and needs no deadline to prove anything. Used only
 * by the two save-path deadline/abort tests below (issue #282 review round
 * 3, finding 3). */
async function startHangingTokenizeFixture(
  t: { after(callback: () => void | Promise<void>): void }
): Promise<{ readonly origin: string }> {
  const server: Server = createServer((request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "e2e-model" }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/tokenize") return; // never responds
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => { server.close(); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture has no address");
  return { origin: `http://127.0.0.1:${address.port}` };
}

function hangingSamplingDocument(origin: string) {
  return documentFor(origin, "llama-cpp", "e2e-model", {
    ...EMPTY_SAMPLING_V2,
    phraseBias: [{ phrase: "griffin", weight: -3 }]
  });
}

// Regression test for issue #282 review round 3, finding 3: the save path
// used to give the llama-cpp bias probe the same per-request timeout as an
// ordinary provider call (up to 30 seconds), separately for each of up to
// three routed profiles — so a single blackholed host could make a save
// wait up to three times that. `SAMPLING_BIAS_SAVE_PROBE_DEADLINE_MS` now
// bounds the whole phase. This check is fail-open, so a save against a
// server that never answers /tokenize must still complete, and the test's
// own timeout — comfortably above the deadline, far below the old worst
// case — is the proof: if the deadline were not honored, this test would
// hang and fail on its own timeout rather than on an assertion.
test("the save-path bias probe honors its own deadline against a server that never answers", {
  skip: !ownedLoopbackHttpSupported(),
  timeout: 8 * SAMPLING_BIAS_SAVE_PROBE_DEADLINE_MS
}, async (t) => {
  assert.ok(SAMPLING_BIAS_SAVE_PROBE_DEADLINE_MS > 0 && SAMPLING_BIAS_SAVE_PROBE_DEADLINE_MS < 30_000);
  const fixture = await startHangingTokenizeFixture(t);
  const dataDir = await initializedFormat2Directory(t, "1667-sampling-llama-save-deadline-");
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await store.init(2);
  await store.save(saveCommand(
    `m1.1767225600007.${"1".repeat(32)}`,
    1,
    hangingSamplingDocument(fixture.origin)
  ));
  const runtime = await store.loadGeneration();
  assert.deepEqual(providerRuntimeFor(runtime.settings).sampling.phraseBias, [
    { phrase: "griffin", weight: -3 }
  ]);
});

// Regression test for issue #282 review round 3, finding 3: the save path
// used to pass no AbortSignal to the bias probe at all, so it kept running
// inside the mutation even after the client that started the save gave up.
// An aborted signal, threaded through, must let this fail-open check reach
// its verdict promptly instead of waiting out the shared deadline — the
// short test timeout below (well under the deadline) is only reachable if
// the abort actually cut the probe short.
test("the save-path bias probe honors an aborted signal without waiting out its deadline", {
  skip: !ownedLoopbackHttpSupported(),
  timeout: SAMPLING_BIAS_SAVE_PROBE_DEADLINE_MS
}, async (t) => {
  const fixture = await startHangingTokenizeFixture(t);
  const dataDir = await initializedFormat2Directory(t, "1667-sampling-llama-save-abort-");
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await store.init(2);
  const controller = new AbortController();
  controller.abort();
  await store.save(
    saveCommand(`m1.1767225600008.${"2".repeat(32)}`, 1, hangingSamplingDocument(fixture.origin)),
    controller.signal
  );
  const runtime = await store.loadGeneration();
  assert.deepEqual(providerRuntimeFor(runtime.settings).sampling.phraseBias, [
    { phrase: "griffin", weight: -3 }
  ]);
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
      ...EMPTY_SAMPLING_V2,
      topP: 0.9
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
    ...EMPTY_SAMPLING_V2,
    logitBias: { "1": 1 }
  });
  await assert.rejects(
    () => store.save(saveCommand(MUTATION_C, 1, candidate)),
    /logit bias.*because this provider does not support it/u
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
      ...EMPTY_SAMPLING_V2,
      topP: 0.9,
      topK: 32,
      stop: ["END"]
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
    ...EMPTY_SAMPLING_V2,
    seed: 42
  }, "anthropic");
  await assert.rejects(
    () => store.save(saveCommand(MUTATION_C, 1, candidate)),
    /seed.*because this provider does not support it/u
  );
  assert.deepEqual((await store.loadView()).document, before);
});

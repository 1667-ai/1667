import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyBasicSettingsDraft } from "../shared/settings-basic-draft.js";
import { applySamplingSettings } from "../shared/sampling-capabilities.js";
import { EMPTY_SAMPLING_V2, type SamplingSettingsV2 } from "../shared/settings-v2-types.js";
import { ServiceError } from "../server/errors.js";
import { ownedLoopbackHttpSupported } from "../server/provider-fetch.js";
import { INITIAL_SETTINGS_DOCUMENT_V2 } from "../server/settings-v2-default.js";
import { StoryService } from "../server/story-service.js";
import {
  FIXED_TIME,
  initializedFormat2Directory,
  MUTATION_A,
  saveCommand
} from "./settings-store-fixtures.js";
import {
  documentFor,
  KOBOLDCPP_FIXTURE_TOKENS,
  LLAMA_CPP_FIXTURE_TOKENS,
  startProviderFixture
} from "./sampling-e2e-fixtures.js";
import { SettingsStore } from "../server/settings.js";

/**
 * Integration coverage for the resolveSamplingBias worker method
 * (shared/worker-protocol.ts) and the resolved-bias bound it exists to
 * support. This is the path the TUI sampling editor calls to show resolved
 * token IDs (design goal for issue #282): the WASM tokenizer lives in
 * server/ and must not load into the TUI's render process, so this proves
 * the worker boundary actually reaches it, not just the pure functions.
 */

const OPENAI_PROBE_TARGET = {
  provider: "openai-compatible" as const,
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o"
};

test("resolveSamplingBias resolves real, encoding-specific token IDs for every surface variant through the service", async (t) => {
  const service = StoryService.withoutDiagnostics({
    dataDir: await temporaryDataDirectory(t, "1667-resolve-bias-")
  });
  await service.init();
  t.after(() => service.dispose());

  // Exact IDs confirmed against the compiled tiktoken o200k_base encoder for
  // "hello" typed, " hello", "Hello", and " Hello" (also see
  // tui/scripts/prompt-tokenizer-smoke.ts, which pins the o200k count for
  // the same word). "hello" is single-token in every variant, so it resolves
  // rather than being rejected.
  const result = await service.resolveSamplingBias({
    settings: OPENAI_PROBE_TARGET,
    logitBias: {},
    phraseBias: [{ phrase: "hello", weight: 3 }],
    bannedStrings: []
  });
  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") throw new Error("unreachable");
  assert.deepEqual(result.logitBias, {
    "24912": 3,
    "40617": 3,
    "13225": 3,
    "32949": 3
  });
  assert.equal(result.phraseBias.length, 1);
  const entry = result.phraseBias[0]!;
  assert.equal(entry.kind, "resolved");
  if (entry.kind !== "resolved") throw new Error("unreachable");
  assert.deepEqual([...entry.tokenIds].sort((a, b) => a - b), [13225, 24912, 32949, 40617]);
  assert.equal(entry.variants.length, 4);
  assert.deepEqual(entry.variants.map((variant) => variant.variant), [
    "typed",
    "leading-space",
    "capitalized",
    "leading-space-capitalized"
  ]);
  for (const variant of entry.variants) assert.equal(variant.outcome.kind, "single-token");
  assert.equal(result.bannedStrings.length, 0);
});

// Issue #341: the editor's preview (this worker method) and the request
// (server/provider-sampling.ts) must never disagree about a draft that
// combines a story overlay with the profile — this proves the preview side
// of that invariant. The story's own weight for "hello" overrides the
// profile's, and the override does not block the resolution.
test("resolveSamplingBias combines a story overlay with the profile, and the story entry overrides the profile's", async (t) => {
  const service = StoryService.withoutDiagnostics({
    dataDir: await temporaryDataDirectory(t, "1667-resolve-bias-story-overlay-")
  });
  await service.init();
  t.after(() => service.dispose());

  const result = await service.resolveSamplingBias({
    settings: OPENAI_PROBE_TARGET,
    logitBias: {},
    phraseBias: [{ phrase: "hello", weight: 20 }],
    bannedStrings: [],
    storyPhraseBias: [{ phrase: "hello", weight: -7 }],
    storyBannedStrings: []
  });
  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") throw new Error("unreachable");
  assert.deepEqual(result.logitBias, {
    "24912": -7,
    "40617": -7,
    "13225": -7,
    "32949": -7
  });
  assert.equal(result.phraseBias.length, 2);
  const [profileEntry, storyEntry] = result.phraseBias;
  assert.equal(profileEntry!.kind, "overridden");
  assert.equal(profileEntry!.scope, "profile");
  assert.equal(storyEntry!.kind, "resolved");
  assert.equal(storyEntry!.scope, "story");
});

// Different encodings produce different IDs for the same text, which is the
// whole point of routing on the model's encoding.
test("resolveSamplingBias resolves different token IDs for a different model's encoding", async (t) => {
  const service = StoryService.withoutDiagnostics({
    dataDir: await temporaryDataDirectory(t, "1667-resolve-bias-encoding-")
  });
  await service.init();
  t.after(() => service.dispose());

  const result = await service.resolveSamplingBias({
    settings: { provider: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4-turbo" },
    logitBias: {},
    phraseBias: [{ phrase: "hello", weight: 3 }],
    bannedStrings: []
  });
  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") throw new Error("unreachable");
  assert.deepEqual(result.logitBias, {
    "15339": 3,
    "24748": 3,
    "9906": 3,
    "22691": 3
  });
});

// Regression test for issue #282 stage 1, point 1: resolution used to spread
// a phrase's weight across every one of its tokens instead of refusing a
// multi-token phrase. "hello world" needs two tokens in every surface
// variant, so it must land as a rejected entry with the resolved IDs shown,
// not silently approximated or dropped.
test("a multi-token phrase is rejected, not approximated, and shows its resolved IDs", async (t) => {
  const service = StoryService.withoutDiagnostics({
    dataDir: await temporaryDataDirectory(t, "1667-resolve-bias-multi-token-")
  });
  await service.init();
  t.after(() => service.dispose());

  const result = await service.resolveSamplingBias({
    settings: OPENAI_PROBE_TARGET,
    logitBias: {},
    phraseBias: [{ phrase: "hello world", weight: 3 }],
    bannedStrings: []
  });
  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") throw new Error("unreachable");
  assert.equal(result.phraseBias.length, 1);
  const entry = result.phraseBias[0]!;
  assert.equal(entry.kind, "rejected");
  if (entry.kind !== "rejected") throw new Error("unreachable");
  const typed = entry.variants.find((variant) => variant.variant === "typed")!;
  assert.deepEqual(typed.outcome, { kind: "multi-token", tokenIds: [24912, 2375] });
  // A rejected entry contributes nothing to the merged bias — never a
  // silent partial application of the phrase it could not fully resolve.
  assert.deepEqual(result.logitBias, {});
  assert.equal(result.resolvedEntryCount, 0);
});

// Regression test for issue #282 stage 1, point 2: "curse" is one token as
// typed. A design that only checked the typed form (the behavior before
// variant expansion) would have accepted it. Its capitalized form — the
// form it takes at a sentence start — is two tokens, so the whole entry
// must still be rejected.
test("variant expansion rejects a phrase whose typed form is single-token but whose capitalized form is not", async (t) => {
  const service = StoryService.withoutDiagnostics({
    dataDir: await temporaryDataDirectory(t, "1667-resolve-bias-variant-")
  });
  await service.init();
  t.after(() => service.dispose());

  const result = await service.resolveSamplingBias({
    settings: OPENAI_PROBE_TARGET,
    logitBias: {},
    phraseBias: [{ phrase: "curse", weight: -2 }],
    bannedStrings: []
  });
  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") throw new Error("unreachable");
  const entry = result.phraseBias[0]!;
  assert.equal(entry.kind, "rejected");
  if (entry.kind !== "rejected") throw new Error("unreachable");
  const typed = entry.variants.find((variant) => variant.variant === "typed")!;
  assert.equal(typed.outcome.kind, "single-token");
  const capitalized = entry.variants.find((variant) => variant.variant === "capitalized")!;
  assert.deepEqual(capitalized.outcome, { kind: "multi-token", tokenIds: [17532, 344] });
});

// Regression test for issue #282 review finding C: tiktoken's encode()
// defaults disallowed_special to "all", so a schema-valid phrase that spells
// a special token used to throw and get reported as "the tokenizer failed
// to load" — a phrase-specific failure misreported as a systemic one. This
// phrase must tokenize as ordinary text (real token IDs, not "unencodable"),
// even though it then rejects for the ordinary reason of being multi-token.
test("a phrase spelling a tiktoken special token tokenizes as ordinary text", async (t) => {
  const service = StoryService.withoutDiagnostics({
    dataDir: await temporaryDataDirectory(t, "1667-resolve-bias-special-token-")
  });
  await service.init();
  t.after(() => service.dispose());

  const result = await service.resolveSamplingBias({
    settings: OPENAI_PROBE_TARGET,
    logitBias: {},
    phraseBias: [{ phrase: "<|endoftext|>", weight: -10 }],
    bannedStrings: ["<|endoftext|>"]
  });
  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") throw new Error("unreachable");
  for (const list of [result.phraseBias, result.bannedStrings]) {
    const entry = list[0]!;
    assert.equal(entry.kind, "rejected");
    if (entry.kind !== "rejected") throw new Error("unreachable");
    const typed = entry.variants.find((variant) => variant.variant === "typed")!;
    assert.equal(typed.outcome.kind, "multi-token");
  }
});

test("resolveSamplingBias rejects a blank phrase and an oversized phrase", async (t) => {
  const service = StoryService.withoutDiagnostics({
    dataDir: await temporaryDataDirectory(t, "1667-resolve-bias-invalid-")
  });
  await service.init();
  t.after(() => service.dispose());

  await assert.rejects(
    service.resolveSamplingBias({
      settings: OPENAI_PROBE_TARGET,
      logitBias: {},
      phraseBias: [{ phrase: "", weight: 1 }],
      bannedStrings: []
    }),
    (error: unknown) => error instanceof ServiceError && error.status === 400
  );
  await assert.rejects(
    service.resolveSamplingBias({
      settings: OPENAI_PROBE_TARGET,
      logitBias: {},
      phraseBias: [],
      bannedStrings: ["x".repeat(65)]
    }),
    (error: unknown) => error instanceof ServiceError && error.status === 400
  );
});

test("resolveSamplingBias reports the tokenizer as unavailable for a model with no exact tokenizer", async (t) => {
  const service = StoryService.withoutDiagnostics({
    dataDir: await temporaryDataDirectory(t, "1667-resolve-bias-no-tokenizer-")
  });
  await service.init();
  t.after(() => service.dispose());

  const result = await service.resolveSamplingBias({
    settings: { provider: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "not-a-known-model" },
    logitBias: {},
    phraseBias: [{ phrase: "hello", weight: 1 }],
    bannedStrings: []
  });
  assert.deepEqual(result, { kind: "tokenizer-unavailable", cause: "model-unknown" });
});

// Regression test for issue #282 review round 5, finding 1: round three's fix
// for review round 2, finding 3 made the llama.cpp tokenize probe
// (server/context-probe.ts, probeLlamaCppTokenize) send `model` in every
// /tokenize POST unconditionally — including a blank one. A blank remote
// model name is how the llama-cpp preset says "use whatever this server has
// loaded": the schema places no minimum length on a model's `remoteId`, and
// this is exactly the target the editor's live preview sends before a writer
// has typed a model name. Sending `model: ""` instead asks a router-mode
// server for a model literally named the empty string, which none has, so
// the probe failed and every phrase and banned string reported
// tokenizer-unavailable on an otherwise reachable, correctly configured
// server. The fix must omit `model` for a blank name instead.
test("resolveSamplingBias resolves llama.cpp phrase bias when the routed model name is blank", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  const fixture = await startProviderFixture(
    t,
    { "whatever-this-server-has-loaded": LLAMA_CPP_FIXTURE_TOKENS },
    { allowBlankModel: true }
  );
  const service = StoryService.withoutDiagnostics({
    dataDir: await temporaryDataDirectory(t, "1667-resolve-bias-llama-blank-model-")
  });
  await service.init();
  t.after(() => service.dispose());

  // documentFor requires a nonblank model (the basic editor draft it applies
  // rejects an empty one), so build a normal document and then blank the
  // routed model's remoteId directly — exactly how a writer who has not
  // picked a model yet, or a router-mode connection left to autoload, is
  // represented on the wire.
  const withPlaceholderModel = documentFor(
    fixture.origin,
    "llama-cpp",
    "placeholder-until-the-server-picks-one",
    EMPTY_SAMPLING_V2
  );
  const modelId = withPlaceholderModel.profiles.default!.modelId;
  const document = {
    ...withPlaceholderModel,
    models: {
      ...withPlaceholderModel.models,
      [modelId]: { ...withPlaceholderModel.models[modelId]!, remoteId: "" }
    }
  };

  const result = await service.resolveSamplingBias({
    settings: { kind: "settings-document", document, purpose: "default" },
    logitBias: {},
    phraseBias: [{ phrase: "griffin", weight: -3 }],
    bannedStrings: []
  });
  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") throw new Error("unreachable");
  assert.deepEqual(result.logitBias, {
    "501": -3,
    "502": -3,
    "503": -3,
    "504": -3
  });
  assert.ok(fixture.tokenizeBodies.length > 0);
  for (const tokenizeBody of fixture.tokenizeBodies) {
    assert.ok(
      !Object.hasOwn(tokenizeBody, "model"),
      "a blank model name must be left out of the body, never sent as model: \"\""
    );
  }
});

// Issue #311: the worker-boundary counterpart to the request-serializer
// tests in test/provider-request-body.test.ts — proves the WASM tokenizer
// stays server-side and the editor's own preview (this worker method) reads
// through the exact same probe and merge the request itself uses. Uses the
// real loopback fixture (test/sampling-e2e-fixtures.ts), not a mocked
// fetch, so this is the closest 1667's own test suite gets to a round trip
// — but the fixture still only asserts 1667's own assumption about
// KoboldCpp's `/api/extra/tokencount` and `/v1/chat/completions` wire
// shapes, not a real KoboldCpp server's behavior (see the KoboldCppFixtureTokenizeMap
// and assertBannedTokensBodyShape comments in that file).
test("resolveSamplingBias resolves KoboldCpp phrase bias through the tokencount probe, and reports a banned string as native", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  const fixture = await startProviderFixture(t, undefined, { koboldTokenizeMap: KOBOLDCPP_FIXTURE_TOKENS });
  const service = StoryService.withoutDiagnostics({
    dataDir: await temporaryDataDirectory(t, "1667-resolve-bias-kobold-")
  });
  await service.init();
  t.after(() => service.dispose());

  const document = documentFor(fixture.origin, "koboldcpp", "kobold-model", EMPTY_SAMPLING_V2);

  const result = await service.resolveSamplingBias({
    settings: { kind: "settings-document", document, purpose: "default" },
    logitBias: {},
    phraseBias: [{ phrase: "ember", weight: -3 }],
    bannedStrings: ["a phrase with several words"]
  });
  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") throw new Error("unreachable");
  assert.deepEqual(result.logitBias, {
    "601": -3,
    "602": -3,
    "603": -3,
    "604": -3
  });
  assert.equal(result.phraseBias.length, 1);
  const phraseEntry = result.phraseBias[0]!;
  assert.equal(phraseEntry.kind, "resolved");
  if (phraseEntry.kind !== "resolved") throw new Error("unreachable");
  assert.deepEqual([...phraseEntry.tokenIds].sort((a, b) => a - b), [601, 602, 603, 604]);

  // The banned string reaches "native" on its own field — no token IDs, no
  // variants, and never a member of `result.bannedStrings` at all (issue
  // #311 review, second pass, finding A: an earlier version carried it as a
  // fifth `kind` inside `bannedStrings`, which nothing stopped from being
  // constructed on a preset other than KoboldCpp).
  assert.equal(result.bannedStrings.length, 0);
  assert.equal(result.nativeBannedStrings.length, 1);
  const nativeEntry = result.nativeBannedStrings[0]!;
  assert.equal(nativeEntry.kind, "native");
  assert.equal(nativeEntry.phrase, "a phrase with several words");

  // Exactly phraseBias's four surface variants reached the probe, plus the
  // one empty-string calibration probe `koboldCppLiveTokenizeProbe`
  // (server/sampling-phrase-bias.ts) sends once per resolution to learn this
  // build's BOS prefix (issue #311) — the banned string, needing no
  // tokenizer at all, never queued a call of its own.
  assert.equal(fixture.koboldTokenizeBodies.length, 5);
  assert.deepEqual(
    fixture.koboldTokenizeBodies.map((body) => body.prompt).sort(),
    ["", " Ember", " ember", "Ember", "ember"]
  );
});

// Issue #311 review, first pass, BLOCKER: KoboldCpp's own documented
// /api/extra/tokencount example returns `ids` beginning with the model's
// BOS token ("ids": [1, 22557, 28725, …]) — so a lexically single-token
// phrase like "ember" used to come back as two IDs, [BOS, token], on any
// BOS-adding build (the normal case), get misclassified multi-token in
// every surface variant, and be rejected outright. The fix
// (koboldCppLiveTokenizeProbe, server/sampling-phrase-bias.ts) tokenizes the
// empty string once per resolution and strips whatever prefix comes back
// from every later response before classifying it. `koboldBosPrefix: [1]`
// makes this fixture answer exactly the way the bug report describes —
// this test would fail against the pre-fix code, which never stripped
// anything, because "ember" would come back two IDs per variant and reject.
// It asserts 1667's own assumption about the wire shape (a build that
// prepends one constant BOS token to every response), not a real KoboldCpp
// server's behavior.
test("resolveSamplingBias strips a KoboldCpp build's calibrated BOS prefix so a single-token phrase resolves, while a genuinely multi-token one still rejects", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  const fixture = await startProviderFixture(t, undefined, {
    koboldTokenizeMap: {
      ...KOBOLDCPP_FIXTURE_TOKENS,
      "several words": [901, 902],
      " several words": [903, 904],
      "Several words": [905, 906],
      " Several words": [907, 908]
    },
    koboldBosPrefix: [1]
  });
  const service = StoryService.withoutDiagnostics({
    dataDir: await temporaryDataDirectory(t, "1667-resolve-bias-kobold-bos-")
  });
  await service.init();
  t.after(() => service.dispose());

  const document = documentFor(fixture.origin, "koboldcpp", "kobold-model", EMPTY_SAMPLING_V2);

  const result = await service.resolveSamplingBias({
    settings: { kind: "settings-document", document, purpose: "default" },
    logitBias: {},
    phraseBias: [
      { phrase: "ember", weight: -3 },
      { phrase: "several words", weight: 2 }
    ],
    bannedStrings: []
  });
  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") throw new Error("unreachable");
  assert.equal(result.phraseBias.length, 2);

  const emberEntry = result.phraseBias.find((entry) => entry.phrase === "ember")!;
  assert.equal(emberEntry.kind, "resolved");
  if (emberEntry.kind !== "resolved") throw new Error("unreachable");
  // Every raw response was actually [1, 601], [1, 602], [1, 603], [1, 604] —
  // stripping the calibrated [1] prefix is what makes "ember" single-token
  // rather than rejected, the exact bug this fixes.
  assert.deepEqual([...emberEntry.tokenIds].sort((a, b) => a - b), [601, 602, 603, 604]);

  const multiEntry = result.phraseBias.find((entry) => entry.phrase === "several words")!;
  assert.equal(multiEntry.kind, "rejected");
  if (multiEntry.kind !== "rejected") throw new Error("unreachable");
  const typed = multiEntry.variants.find((variant) => variant.variant === "typed")!;
  // Stripped of the BOS prefix this is genuinely two tokens (901, 902) — not
  // three (the prefix left in) and not one (the prefix mistaken for the
  // whole answer): the strip does not accidentally make everything look
  // single-token.
  assert.deepEqual(typed.outcome, { kind: "multi-token", tokenIds: [901, 902] });
});

// Issue #311 review, first pass, named edge case: a phrase whose IDs equal
// the calibrated prefix exactly needs no special-casing in the resolver —
// stripped to zero tokens, it falls straight through the ordinary
// `tokenIds.length === 1` check into "multi-token" with an empty tokenIds
// array, the same honest rejection any other non-single-token count gets,
// never approximated as free or as single-token. This fixture's map has no
// entries at all, so every surface variant of the configured phrase comes
// back as exactly the prefix and nothing else.
test("resolveSamplingBias rejects a KoboldCpp phrase whose stripped IDs are empty, not silently zero-cost", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  const fixture = await startProviderFixture(t, undefined, {
    koboldTokenizeMap: {},
    koboldBosPrefix: [1, 2]
  });
  const service = StoryService.withoutDiagnostics({
    dataDir: await temporaryDataDirectory(t, "1667-resolve-bias-kobold-bos-empty-")
  });
  await service.init();
  t.after(() => service.dispose());

  const document = documentFor(fixture.origin, "koboldcpp", "kobold-model", EMPTY_SAMPLING_V2);

  const result = await service.resolveSamplingBias({
    settings: { kind: "settings-document", document, purpose: "default" },
    logitBias: {},
    phraseBias: [{ phrase: "ghost", weight: 1 }],
    bannedStrings: []
  });
  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") throw new Error("unreachable");
  const entry = result.phraseBias[0]!;
  assert.equal(entry.kind, "rejected");
  if (entry.kind !== "rejected") throw new Error("unreachable");
  const typed = entry.variants.find((variant) => variant.variant === "typed")!;
  assert.deepEqual(typed.outcome, { kind: "multi-token", tokenIds: [] });
});

// Issue #311 review, first pass, named edge case: an empty-string response
// that is not actually a prefix of a phrase's IDs — the calibration probe
// answered normally, but the build's own prefix assumption did not hold for
// this one phrase. Guessing which part of a mismatched response is "real"
// risks biasing the wrong token, so this must report the same honest
// tokenizer-unavailable outcome a calibration probe that never answered at
// all reports, rather than a guess. `koboldBosPrefixExemptPrompts` is
// 1667's own synthetic assumption-check (see its comment in
// test/sampling-e2e-fixtures.ts) — no known KoboldCpp build answers
// inconsistently this way.
test("resolveSamplingBias reports tokenizer-unavailable when a KoboldCpp phrase's IDs do not actually start with the calibrated prefix", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  const fixture = await startProviderFixture(t, undefined, {
    koboldTokenizeMap: KOBOLDCPP_FIXTURE_TOKENS,
    koboldBosPrefix: [1],
    koboldBosPrefixExemptPrompts: new Set(["ember"])
  });
  const service = StoryService.withoutDiagnostics({
    dataDir: await temporaryDataDirectory(t, "1667-resolve-bias-kobold-bos-mismatch-")
  });
  await service.init();
  t.after(() => service.dispose());

  const document = documentFor(fixture.origin, "koboldcpp", "kobold-model", EMPTY_SAMPLING_V2);

  const result = await service.resolveSamplingBias({
    settings: { kind: "settings-document", document, purpose: "default" },
    logitBias: {},
    phraseBias: [{ phrase: "ember", weight: -3 }],
    bannedStrings: []
  });
  assert.deepEqual(result, { kind: "tokenizer-unavailable", cause: "probe-failed" });
});

// Issue #311: a KoboldCpp server that never answers /api/extra/tokencount
// must report the tokenizer as unavailable for phraseBias, the same
// "probe-failed" outcome llama.cpp's own failed probe reports above — the
// editor's preview must show the same failure the request would hit, never
// a silently approximated one.
test("resolveSamplingBias reports the KoboldCpp tokenizer as unavailable when the probe does not answer", async (t) => {
  const service = StoryService.withoutDiagnostics({
    dataDir: await temporaryDataDirectory(t, "1667-resolve-bias-kobold-probe-failed-")
  });
  await service.init();
  t.after(() => service.dispose());

  // "provider.example" is an RFC 2606 reserved domain that never resolves —
  // the same fixture-free failure source test/provider-request-body.test.ts
  // uses for the equivalent llama.cpp and KoboldCpp request-level tests.
  const document = documentFor("https://provider.example", "koboldcpp", "kobold-model", EMPTY_SAMPLING_V2);

  const result = await service.resolveSamplingBias({
    settings: { kind: "settings-document", document, purpose: "default" },
    logitBias: {},
    phraseBias: [{ phrase: "ember", weight: -3 }],
    bannedStrings: []
  });
  assert.deepEqual(result, { kind: "tokenizer-unavailable", cause: "probe-failed" });
});

// Issue #311 review, second pass, BLOCKER B: a native banned string never
// resolves a token, so it cannot lose a token-ownership fight the way a
// tokenized bannedStrings entry does on every other preset — but a writer
// who configures phraseBias "ember"@5 and bannedStrings "ember" together in
// the same scope is self-contradicting on KoboldCpp exactly the way they
// are on llama.cpp and openai (there, the two entries fight over the same
// resolved token and the phraseBias entry loses, "shadowed"). This proves
// the same contradiction is caught here too, by literal text instead of by
// token — checked once for the profile scope, once for the story scope, so
// the rule is shown to be about matching scope, not about the profile
// specifically. The genuine cross-scope case (no contradiction) is the next
// test below.
test("resolveSamplingBias blocks a KoboldCpp banned string that contradicts a same-scope phrase bias", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  // "dragon" needs its own real single-token mapping, distinct from a text
  // this fixture's vocabulary simply does not have — an unmapped nonempty
  // text now answers "failed" (issue #311 review, second pass, finding E:
  // a non-empty prompt tokenizing to zero IDs is systemic, not a phrase
  // fact), not a legitimate 0-token rejection, so this test needs "dragon"
  // to genuinely resolve in order to isolate the contradiction check from
  // that unrelated probe-failure path.
  const fixture = await startProviderFixture(t, undefined, {
    koboldTokenizeMap: {
      ...KOBOLDCPP_FIXTURE_TOKENS,
      dragon: 701,
      " dragon": 702,
      Dragon: 703,
      " Dragon": 704
    }
  });
  const service = StoryService.withoutDiagnostics({
    dataDir: await temporaryDataDirectory(t, "1667-resolve-bias-kobold-contradiction-")
  });
  await service.init();
  t.after(() => service.dispose());

  const document = documentFor(fixture.origin, "koboldcpp", "kobold-model", EMPTY_SAMPLING_V2);

  const result = await service.resolveSamplingBias({
    settings: { kind: "settings-document", document, purpose: "default" },
    logitBias: {},
    // Profile-scoped contradiction: boosts and bans "ember" together.
    phraseBias: [{ phrase: "ember", weight: 5 }],
    bannedStrings: ["ember"],
    // Story-scoped contradiction: boosts and bans "dragon" together, both
    // in the story's own scope — proves the rule checks *matching* scope,
    // not "profile" specifically.
    storyPhraseBias: [{ phrase: "dragon", weight: 5 }],
    storyBannedStrings: ["dragon"]
  });
  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") throw new Error("unreachable");

  assert.equal(result.nativeBannedStrings.length, 2);
  const profileScope = result.nativeBannedStrings.find((entry) => entry.phrase === "ember")!;
  assert.equal(profileScope.kind, "blocked");
  if (profileScope.kind !== "blocked") throw new Error("unreachable");
  assert.equal(profileScope.conflictingPhrase, "ember");

  const storyScope = result.nativeBannedStrings.find((entry) => entry.phrase === "dragon")!;
  assert.equal(storyScope.kind, "blocked");
  if (storyScope.kind !== "blocked") throw new Error("unreachable");
  assert.equal(storyScope.conflictingPhrase, "dragon");
});

// The genuine cross-scope case: the profile boosts "wolf" and the story
// separately bans it — settled rule 2 says a cross-scope conflict is a
// non-blocking "override", never told apart from a same-scope contradiction
// the writer needs to fix. A native banned string must keep that same
// promise: "wolf" ships as native, unblocked, even though the profile's own
// phraseBias names the identical text.
test("resolveSamplingBias leaves a KoboldCpp banned string alone when it only contradicts a different scope's phrase bias", {
  skip: !ownedLoopbackHttpSupported()
}, async (t) => {
  const fixture = await startProviderFixture(t, undefined, { koboldTokenizeMap: KOBOLDCPP_FIXTURE_TOKENS });
  const service = StoryService.withoutDiagnostics({
    dataDir: await temporaryDataDirectory(t, "1667-resolve-bias-kobold-cross-scope-")
  });
  await service.init();
  t.after(() => service.dispose());

  const document = documentFor(fixture.origin, "koboldcpp", "kobold-model", EMPTY_SAMPLING_V2);

  const result = await service.resolveSamplingBias({
    settings: { kind: "settings-document", document, purpose: "default" },
    logitBias: {},
    phraseBias: [{ phrase: "ember", weight: 5 }],
    bannedStrings: [],
    storyBannedStrings: ["ember"]
  });
  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") throw new Error("unreachable");
  assert.equal(result.nativeBannedStrings.length, 1);
  const entry = result.nativeBannedStrings[0]!;
  assert.equal(entry.kind, "native");
  assert.equal(entry.phrase, "ember");
});

// Regression test for issue #282 review finding A: raising
// SAMPLING_LOGIT_BIAS_POLICY.maxEntries from 16 to 200 removed the guard
// that used to cover every preset, because the replacement preset-aware
// bound only ran when phraseBias or bannedStrings were configured. A
// KoboldCpp profile with plain numeric entries and empty phrase lists — the
// exact shape that was impossible to save before this change — must still
// be rejected.
test("KoboldCpp's documented 16-entry cap rejects 17 plain numeric logitBias entries at save time", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-resolve-bias-kobold-numeric-");
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await store.init(2);
  const koboldDocument = koboldcppDocument();
  const sampling: SamplingSettingsV2 = {
    ...EMPTY_SAMPLING_V2,
    logitBias: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [String(index), 1]))
  };
  await assert.rejects(
    () => store.save(saveCommand(
      MUTATION_A,
      1,
      applySamplingSettings(koboldDocument, sampling)
    )),
    /16-entry limit for preset koboldcpp/
  );
});

function koboldcppDocument() {
  const base = applyBasicSettingsDraft(INITIAL_SETTINGS_DOCUMENT_V2, {
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:5001/v1",
    model: "gpt-4o",
    apiKeyEnv: null,
    temperature: 0.7,
    maxTokens: 128,
    systemPrompt: "Continue the story.",
    contextWindow: 8_192
  });
  const connectionId = base.models[base.profiles.default!.modelId]!.connectionId;
  return {
    ...base,
    connections: {
      ...base.connections,
      [connectionId]: { ...base.connections[connectionId]!, preset: "koboldcpp" as const }
    }
  };
}

async function temporaryDataDirectory(
  t: test.TestContext,
  prefix: string
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

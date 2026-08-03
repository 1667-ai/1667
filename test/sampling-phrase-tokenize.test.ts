import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyBasicSettingsDraft } from "../shared/settings-basic-draft.js";
import { applySamplingSettings } from "../shared/sampling-capabilities.js";
import { EMPTY_SAMPLING_V2, type SamplingSettingsV2 } from "../shared/settings-v2-types.js";
import { ServiceError } from "../server/errors.js";
import { INITIAL_SETTINGS_DOCUMENT_V2 } from "../server/settings-v2-default.js";
import { StoryService } from "../server/story-service.js";
import {
  FIXED_TIME,
  initializedFormat2Directory,
  MUTATION_A,
  saveCommand
} from "./settings-store-fixtures.js";
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

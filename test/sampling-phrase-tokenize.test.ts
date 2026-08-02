import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyBasicSettingsDraft } from "../shared/settings-basic-draft.js";
import { applySamplingSettings } from "../shared/sampling-capabilities.js";
import type { SamplingSettingsV2 } from "../shared/settings-v2-types.js";
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

test("resolveSamplingBias resolves real, encoding-specific token IDs through the service", async (t) => {
  const service = StoryService.withoutDiagnostics({
    dataDir: await temporaryDataDirectory(t, "1667-resolve-bias-")
  });
  await service.init();
  t.after(() => service.dispose());

  // Exact IDs confirmed against the compiled tiktoken encoders (also see
  // tui/scripts/prompt-tokenizer-smoke.ts, which pins the o200k count for
  // the same phrase). Different encodings produce different IDs for the
  // same text, which is the whole point of routing on the model's encoding.
  assert.deepEqual(
    await service.resolveSamplingBias({
      logitBias: {},
      phraseBias: [{ phrase: "hello world", weight: 3 }],
      bannedStrings: [],
      encoding: "o200k_base"
    }),
    {
      kind: "resolved",
      logitBias: { "24912": 3, "2375": 3 },
      phraseBias: [{ phrase: "hello world", tokenIds: [24912, 2375] }],
      bannedStrings: [],
      resolvedEntryCount: 2
    }
  );
  assert.deepEqual(
    await service.resolveSamplingBias({
      logitBias: {},
      phraseBias: [{ phrase: "hello world", weight: 3 }],
      bannedStrings: [],
      encoding: "cl100k_base"
    }),
    {
      kind: "resolved",
      logitBias: { "15339": 3, "1917": 3 },
      phraseBias: [{ phrase: "hello world", tokenIds: [15339, 1917] }],
      bannedStrings: [],
      resolvedEntryCount: 2
    }
  );
});

// Regression test for issue #282 review finding C: tiktoken's encode()
// defaults disallowed_special to "all", so a schema-valid phrase that spells
// a special token used to throw and get reported as "the tokenizer failed
// to load" — a phrase-specific failure misreported as a systemic one. This
// phrase must resolve normally, as ordinary text, not fail at all.
test("a phrase spelling a tiktoken special token resolves as ordinary text", async (t) => {
  const service = StoryService.withoutDiagnostics({
    dataDir: await temporaryDataDirectory(t, "1667-resolve-bias-special-token-")
  });
  await service.init();
  t.after(() => service.dispose());

  const result = await service.resolveSamplingBias({
    logitBias: {},
    phraseBias: [{ phrase: "<|endoftext|>", weight: -10 }],
    bannedStrings: ["<|endoftext|>"],
    encoding: "o200k_base"
  });
  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") throw new Error("unreachable");
  assert.ok(result.phraseBias[0]!.tokenIds.length > 0);
  assert.ok(result.bannedStrings[0]!.tokenIds.length > 0);
});

test("resolveSamplingBias rejects a blank phrase, an oversized phrase, and an unknown encoding", async (t) => {
  const service = StoryService.withoutDiagnostics({
    dataDir: await temporaryDataDirectory(t, "1667-resolve-bias-invalid-")
  });
  await service.init();
  t.after(() => service.dispose());

  await assert.rejects(
    service.resolveSamplingBias({
      logitBias: {},
      phraseBias: [{ phrase: "", weight: 1 }],
      bannedStrings: [],
      encoding: "o200k_base"
    }),
    (error: unknown) => error instanceof ServiceError && error.status === 400
  );
  await assert.rejects(
    service.resolveSamplingBias({
      logitBias: {},
      phraseBias: [],
      bannedStrings: ["x".repeat(65)],
      encoding: "o200k_base"
    }),
    (error: unknown) => error instanceof ServiceError && error.status === 400
  );
  await assert.rejects(
    service.resolveSamplingBias({
      logitBias: {},
      phraseBias: [],
      bannedStrings: [],
      encoding: "p50k_base"
    }),
    (error: unknown) => error instanceof ServiceError && error.status === 400
  );
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
    topP: null,
    topK: null,
    minP: null,
    frequencyPenalty: null,
    presencePenalty: null,
    repeatPenalty: null,
    stop: [],
    logitBias: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [String(index), 1])),
    bannedStrings: [],
    phraseBias: []
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

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
 * Integration coverage for the tokenizeSamplingPhrase worker method
 * (shared/worker-protocol.ts) and the resolved-bias bound it exists to
 * support. This is the path the TUI sampling editor calls to show resolved
 * token IDs (design goal for issue #282): the WASM tokenizer lives in
 * server/ and must not load into the TUI's render process, so this proves
 * the worker boundary actually reaches it, not just the pure functions.
 */

test("tokenizeSamplingPhrase resolves real, encoding-specific token IDs through the service", async (t) => {
  const service = StoryService.withoutDiagnostics({
    dataDir: await temporaryDataDirectory(t, "1667-tokenize-phrase-")
  });
  await service.init();
  t.after(() => service.dispose());

  // Exact IDs confirmed against the compiled tiktoken encoders (also see
  // tui/scripts/prompt-tokenizer-smoke.ts, which pins the o200k count for
  // the same phrase). Different encodings produce different IDs for the
  // same text, which is the whole point of routing on the model's encoding.
  assert.deepEqual(
    await service.tokenizeSamplingPhrase({ phrase: "hello world", encoding: "o200k_base" }),
    { tokenIds: [24912, 2375] }
  );
  assert.deepEqual(
    await service.tokenizeSamplingPhrase({ phrase: "hello world", encoding: "cl100k_base" }),
    { tokenIds: [15339, 1917] }
  );
});

test("tokenizeSamplingPhrase rejects a blank phrase, an oversized phrase, and an unknown encoding", async (t) => {
  const service = StoryService.withoutDiagnostics({
    dataDir: await temporaryDataDirectory(t, "1667-tokenize-phrase-invalid-")
  });
  await service.init();
  t.after(() => service.dispose());

  await assert.rejects(
    service.tokenizeSamplingPhrase({ phrase: "", encoding: "o200k_base" }),
    (error: unknown) => error instanceof ServiceError && error.status === 400
  );
  await assert.rejects(
    service.tokenizeSamplingPhrase({ phrase: "x".repeat(65), encoding: "o200k_base" }),
    (error: unknown) => error instanceof ServiceError && error.status === 400
  );
  await assert.rejects(
    service.tokenizeSamplingPhrase({ phrase: "hello", encoding: "p50k_base" }),
    (error: unknown) => error instanceof ServiceError && error.status === 400
  );
});

test("KoboldCpp's documented 16-entry logit_bias cap rejects an over-budget phrase list at save time", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-tokenize-phrase-kobold-bound-");
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await store.init(2);
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
  const koboldDocument = {
    ...base,
    connections: {
      ...base.connections,
      [connectionId]: { ...base.connections[connectionId]!, preset: "koboldcpp" as const }
    }
  };
  // Seventeen single-token phrases resolve to seventeen distinct logit_bias
  // entries, one over KoboldCpp's documented 16-entry cap (see
  // SAMPLING_LOGIT_BIAS_POLICY in shared/sampling-validation-policy.ts).
  const sampling: SamplingSettingsV2 = {
    topP: null,
    topK: null,
    minP: null,
    frequencyPenalty: null,
    presencePenalty: null,
    repeatPenalty: null,
    stop: [],
    logitBias: {},
    bannedStrings: [],
    phraseBias: Array.from({ length: 17 }, (_, index) => ({
      phrase: `word${index}`,
      weight: 1
    }))
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

async function temporaryDataDirectory(
  t: test.TestContext,
  prefix: string
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

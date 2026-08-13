import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../server/canonical-json.js";
import { parseJsonRejectingDuplicateKeys } from "../../server/strict-json.js";
import type { GemmaRuntimeRecord } from "./runtime.js";
import type { ReplayProfile } from "./profile.js";

export type ApprovedReplay = {
  readonly schemaVersion: 1;
  readonly runtime: { readonly runtime: "llama.cpp"; readonly modelId: "gemma-4-31b"; readonly modelIdentity: "Gemma 4 31B"; readonly quantization: "Q4_K_M"; readonly chatTemplate: "gemma"; readonly minimumContextWindow: 32768 };
  readonly profile: Omit<ReplayProfile, "name" | "sourceFingerprint" | "logitBiasState">;
};

const APPROVED_REPLAY: ApprovedReplay = {
  schemaVersion: 1,
  runtime: {
    runtime: "llama.cpp", modelId: "gemma-4-31b", modelIdentity: "Gemma 4 31B",
    quantization: "Q4_K_M", chatTemplate: "gemma", minimumContextWindow: 32768
  },
  profile: {
    temperature: 0.7, maxOutputTokens: 400, effort: "default", cachePolicy: "off", tokenProbabilities: null,
    sampling: {
      topP: 0.92, topK: 40, minP: 0.05, frequencyPenalty: null, presencePenalty: null, repeatPenalty: 1.08,
      seed: null, dryMultiplier: null, dryBase: null, dryRange: null, xtcThreshold: null, xtcProbability: null,
      dynatempRange: null, mirostat: null, mirostatTau: null, mirostatEta: null, stop: [], logitBias: {},
      bannedStrings: [], phraseBias: [], dryBreakers: []
    }
  }
};

/** Validate the complete, closed approved protocol. Strict JSON rejects duplicate keys. */
export function parseApprovedReplay(value: unknown): ApprovedReplay {
  if (canonicalJson(value) !== canonicalJson(APPROVED_REPLAY)) {
    throw new Error("approved Gemma replay protocol has unsupported, missing, or changed fields");
  }
  return APPROVED_REPLAY;
}

const approved = parseApprovedReplay(parseJsonRejectingDuplicateKeys(
  readFileSync(fileURLToPath(new URL("./approved-replay.json", import.meta.url)), "utf8"),
  "approved Gemma replay"
));

export function assertApprovedReplay(runtime: GemmaRuntimeRecord, profile: ReplayProfile): void {
  const config = runtime.configuration;
  const expectedRuntime = approved.runtime;
  if (config.runtime !== expectedRuntime.runtime || config.model.id !== expectedRuntime.modelId
    || config.model.identity !== expectedRuntime.modelIdentity || config.model.artifact.quantization !== expectedRuntime.quantization
    || config.llamaCpp.chatTemplate !== expectedRuntime.chatTemplate || config.llamaCpp.contextWindow < expectedRuntime.minimumContextWindow) {
    throw new Error("Gemma replay runtime does not match approved replay protocol");
  }
  const expected = approved.profile;
  if (profile.temperature !== expected.temperature || profile.maxOutputTokens !== expected.maxOutputTokens
    || profile.effort !== expected.effort || profile.cachePolicy !== expected.cachePolicy
    || profile.tokenProbabilities !== expected.tokenProbabilities
    || canonicalJson(profile.sampling) !== canonicalJson(expected.sampling)) {
    throw new Error("Gemma replay profile does not match approved replay protocol");
  }
}

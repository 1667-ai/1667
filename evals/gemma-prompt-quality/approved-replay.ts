import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../server/canonical-json.js";
import { parseJsonRejectingDuplicateKeys } from "../../server/strict-json.js";
import type { GemmaRuntimeRecord } from "./runtime.js";
import type { ReplayProfile } from "./profile.js";

export type ApprovedReplay = {
  readonly schemaVersion: 1;
  readonly runtime: { readonly runtime: "koboldcpp"; readonly modelId: "koboldcpp/gemma-4-31B-it-uncensored-heretic-Q8_0"; readonly quantization: "Q8_0"; readonly chatTemplateSha256: "sha256:0a52be69cda5ab8aeb627d6ff51a7b34c7d06afabb6b0f00cf8ee63df16a6315"; readonly minimumContextWindow: 32768 };
  readonly profile: Omit<ReplayProfile, "name" | "sourceFingerprint" | "logitBiasState">;
};

const APPROVED_REPLAY: ApprovedReplay = {
  schemaVersion: 1,
  runtime: {
    runtime: "koboldcpp", modelId: "koboldcpp/gemma-4-31B-it-uncensored-heretic-Q8_0",
    quantization: "Q8_0", chatTemplateSha256: "sha256:0a52be69cda5ab8aeb627d6ff51a7b34c7d06afabb6b0f00cf8ee63df16a6315", minimumContextWindow: 32768
  },
  profile: {
    temperature: 0.7, maxOutputTokens: 400, effort: "default", cachePolicy: "off", tokenProbabilities: null,
    timeouts: { responseHeaderMs: 600_000, firstTokenMs: 120_000, idleMs: 120_000, totalMs: 1_800_000 },
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
    || config.model.artifact.quantization !== expectedRuntime.quantization
    || config.koboldCpp.chatTemplateSha256 !== expectedRuntime.chatTemplateSha256 || config.koboldCpp.contextWindow < expectedRuntime.minimumContextWindow) {
    throw new Error("Gemma replay runtime does not match approved replay protocol");
  }
  const expected = approved.profile;
  if (profile.temperature !== expected.temperature || profile.maxOutputTokens !== expected.maxOutputTokens
    || profile.effort !== expected.effort || profile.cachePolicy !== expected.cachePolicy
    || profile.tokenProbabilities !== expected.tokenProbabilities
    || canonicalJson(profile.timeouts) !== canonicalJson(expected.timeouts)
    || canonicalJson(profile.sampling) !== canonicalJson(expected.sampling)) {
    throw new Error("Gemma replay profile does not match approved replay protocol");
  }
}

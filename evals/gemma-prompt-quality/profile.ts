import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonicalJson } from "../../server/canonical-json.js";
import { importProfileExport } from "../../server/import-profile-export.js";
import { parseJsonRejectingDuplicateKeys } from "../../server/strict-json.js";
import { effectiveStandardGenerationRuntime } from "../../server/settings-runtime-resolver.js";
import {
  defaultModelCapabilities
} from "../../shared/settings-provider-defaults.js";
import type { ContinuationPromptOptimizationV2 } from "../../shared/continuation-prompt-optimization.js";
import {
  EMPTY_SAMPLING_V2,
  type ConnectionTimeoutsV2,
  type GenerationEffortV2,
  type ModelCapabilitiesV2,
  type SamplingSettingsV2,
  type SettingsDocumentV2
} from "../../shared/settings-v2-types.js";
import {
  rawLogitBiasLimit,
  validateSamplingLogitBias
} from "../../shared/sampling-validation-policy.js";
import type { GenerationSettings } from "../../shared/types.js";
import type { GemmaRuntimeConfiguration, GemmaRuntimeRecord } from "./runtime.js";
import type { GemmaEvidenceProfile } from "./contract.js";

export interface ReplayProfile {
  readonly name: string;
  readonly sourceFingerprint: string;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  readonly effort: GenerationEffortV2;
  readonly cachePolicy: string;
  readonly tokenProbabilities: number | null;
  readonly sampling: SamplingSettingsV2;
  /** Replay transport limits. These do not change product connection defaults. */
  readonly timeouts: ConnectionTimeoutsV2;
  /** The complete manifest explicitly records the raw token-bias map. */
  readonly logitBiasState: "empty" | "present";
}

/** Shape shared by replay and evidence artifacts before canonical projection. */
export interface ReplayProfileBoundary {
  readonly name: string;
  readonly sourceFingerprint: string;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  readonly effort: GenerationEffortV2;
  readonly cachePolicy: "off";
  readonly tokenProbabilities: number | null;
  readonly sampling: Record<string, unknown>;
  readonly timeouts: ConnectionTimeoutsV2;
  readonly logitBiasState: "empty" | "present";
}

/** A replay-only manifest preserves raw token IDs and binds them to the
 * checked model artifact. Ordinary Profile Exports deliberately omit them. */
export interface ReplayProfileManifest {
  readonly schemaVersion: 1;
  readonly runtimeArtifactSha256: string;
  readonly profile: {
    readonly name: string;
    readonly generation: {
      readonly temperature: number;
      readonly maxOutputTokens: number;
      readonly effort: GenerationEffortV2;
      readonly cachePolicy: "off";
      readonly tokenProbabilities: number | null;
    };
    readonly sampling: Record<string, unknown>;
    readonly timeouts: ConnectionTimeoutsV2;
  };
}

export async function readReplayProfileManifest(
  path: string,
  runtime: GemmaRuntimeRecord
): Promise<ReplayProfile> {
  const value = parseJsonRejectingDuplicateKeys(
    await readFile(path, "utf8"),
    "Gemma replay profile manifest"
  );
  return parseReplayProfileManifest(value, runtime);
}

/** Parse a full raw-bias manifest. This is the only replay profile input. */
export function parseReplayProfileManifest(
  value: unknown,
  runtime: GemmaRuntimeRecord
): ReplayProfile {
  const manifest = requireRecord(value, "Gemma replay profile manifest");
  requireKeys(
    manifest,
    ["schemaVersion", "runtimeArtifactSha256", "profile"],
    "Gemma replay profile manifest"
  );
  if (manifest.schemaVersion !== 1) throw new Error("Gemma replay profile manifest.schemaVersion is invalid");
  if (manifest.runtimeArtifactSha256 !== runtime.configuration.model.artifact.sha256) {
    throw new Error("Gemma replay profile manifest runtimeArtifactSha256 does not match the checked runtime artifact");
  }
  const profile = requireRecord(manifest.profile, "Gemma replay profile manifest.profile");
  requireKeys(profile, ["name", "generation", "sampling", "timeouts"], "Gemma replay profile manifest.profile");
  const generation = requireRecord(profile.generation, "Gemma replay profile manifest.profile.generation");
  requireKeys(
    generation,
    ["temperature", "maxOutputTokens", "effort", "cachePolicy", "tokenProbabilities"],
    "Gemma replay profile manifest.profile.generation"
  );
  if (generation.effort !== "default") {
    throw new Error("Gemma replay requires generation.effort to be default because the checked runtime does not declare reasoning-effort support");
  }
  const sampling = requireRecord(profile.sampling, "Gemma replay profile manifest.profile.sampling");
  requireKeys(sampling, Object.keys(EMPTY_SAMPLING_V2), "Gemma replay profile manifest.profile.sampling");
  const { logitBias: rawLogitBias, ...transferableSampling } = sampling;
  const logitBias = validateReplayLogitBias(rawLogitBias);
  const timeouts = parseReplayTimeouts(profile.timeouts, "Gemma replay profile manifest.profile.timeouts");
  if (rawLogitBiasLimit(logitBias, "koboldcpp").exceeds) {
    throw new Error("Gemma replay profile manifest.profile.sampling.logitBias exceeds the KoboldCpp 16-entry limit");
  }
  const parsed = importProfileExport(JSON.stringify({
    profileExportVersion: 1,
    name: profile.name,
    generation,
    sampling: transferableSampling
  }));
  return profileFromCandidate({
    ...parsed,
    sampling: { ...(parsed.sampling ?? {}), logitBias },
    timeouts
  }, canonicalManifestText(manifest));
}

/** Rebuild the complete manifest from compact evidence. This lets the
 * compatibility checker verify deterministic requests without a cast. */
export function replayProfileFromEvidence(
  evidence: GemmaEvidenceProfile,
  runtime: GemmaRuntimeRecord
): ReplayProfile {
  return validateReplayProfileBoundary({ ...evidence, sampling: { ...evidence.sampling } }, runtime);
}

/** Validate a shape-checked artifact profile and project it to replay settings. */
export function validateReplayProfileBoundary(
  evidence: ReplayProfileBoundary,
  runtime: GemmaRuntimeRecord
): ReplayProfile {
  const profile = parseReplayProfileManifest({
    schemaVersion: 1,
    runtimeArtifactSha256: runtime.configuration.model.artifact.sha256,
    profile: {
      name: evidence.name,
      generation: {
        temperature: evidence.temperature,
        maxOutputTokens: evidence.maxOutputTokens,
        effort: evidence.effort,
        cachePolicy: evidence.cachePolicy,
        tokenProbabilities: evidence.tokenProbabilities
      },
      sampling: { ...evidence.sampling },
      timeouts: evidence.timeouts
    }
  }, runtime);
  if (profile.sourceFingerprint !== evidence.sourceFingerprint) {
    throw new Error("evidence profile source fingerprint does not match the reconstructed replay profile manifest");
  }
  return profile;
}

function profileFromCandidate(
  candidate: ProfileExportCandidate,
  sourceText: string
): ReplayProfile {
  if (candidate.temperature === undefined || candidate.temperature === null) {
    throw new Error("Profile Export must set generation.temperature for a replay");
  }
  if (candidate.maxOutputTokens === undefined) {
    throw new Error("Profile Export must set generation.maxOutputTokens for a replay");
  }
  if (candidate.cachePolicy !== undefined && candidate.cachePolicy !== "off") {
    throw new Error("Gemma replay requires Profile Export generation.cachePolicy to be off");
  }
  const sampling: SamplingSettingsV2 = {
    ...EMPTY_SAMPLING_V2,
    ...(candidate.sampling ?? {})
  };
  if (sampling.seed !== null) {
    throw new Error("Gemma replay controls sampling.seed with its fixed replay seed set");
  }
  if (sampling.phraseBias.length > 0 || sampling.bannedStrings.length > 0) {
    throw new Error(
      "Gemma replay cannot verify phraseBias or bannedStrings after server-side tokenization"
    );
  }
  const sourceFingerprint = `sha256:${sha256(sourceText)}`;
  const preservedLogitBias = Object.keys(sampling.logitBias).length > 0;
  if (candidate.omittedCount !== undefined && candidate.omittedCount > 0) {
    throw new Error("Gemma replay rejects a Profile Export that omitted raw logitBias");
  }
  return {
    name: candidate.name,
    sourceFingerprint,
    temperature: candidate.temperature,
    maxOutputTokens: candidate.maxOutputTokens,
    effort: candidate.effort ?? "default",
    cachePolicy: candidate.cachePolicy ?? "off",
    tokenProbabilities: candidate.tokenProbabilities ?? null,
    sampling,
    timeouts: candidate.timeouts,
    logitBiasState: preservedLogitBias ? "present" : "empty"
  };
}

/** Construct the same runtime shape that the provider path reads in Settings.
 * Only the endpoint and model come from the command line; profile behavior is
 * copied, then `seed` is replaced by the caller for this one run. */
export function replaySettings(
  endpointBaseUrl: string,
  runtimeConfiguration: GemmaRuntimeConfiguration,
  profile: ReplayProfile,
  seed: number,
  optimization?: ContinuationPromptOptimizationV2
): GenerationSettings {
  const apiKeyEnv = process.env.GEMMA_API_KEY === undefined ? null : "GEMMA_API_KEY";
  const document = replaySettingsDocument(
    endpointBaseUrl,
    runtimeConfiguration,
    profile,
    seed,
    optimization,
    apiKeyEnv
  );
  return effectiveStandardGenerationRuntime(document).settings;
}

function replaySettingsDocument(
  endpointBaseUrl: string,
  runtimeConfiguration: GemmaRuntimeConfiguration,
  profile: ReplayProfile,
  seed: number,
  optimization: ContinuationPromptOptimizationV2 | undefined,
  apiKeyEnv: string | null
): SettingsDocumentV2 {
  const connectionId = "gemma-replay-connection";
  const modelId = "gemma-replay-model";
  const profileId = "gemma-replay-profile";
  const capabilities: ModelCapabilitiesV2 = {
    ...defaultModelCapabilities("openai-compatible"),
    assistantPrefill: "supported"
  };
  const generationProfile = {
    name: profile.name,
    modelId,
    temperature: profile.temperature,
    maxOutputTokens: profile.maxOutputTokens,
    effort: profile.effort,
    cachePolicy: "off" as const,
    sampling: { ...profile.sampling, seed },
    ...(profile.tokenProbabilities === null ? {} : { tokenProbabilities: profile.tokenProbabilities }),
    ...(optimization === undefined ? {} : { continuationPromptOptimization: optimization })
  };
  return {
    schemaVersion: 2,
    connections: {
      [connectionId]: {
        name: "Gemma replay endpoint",
        preset: "koboldcpp",
        protocol: "openai-chat-completions",
        baseUrl: endpointBaseUrl,
        auth: apiKeyEnv === null
          ? { type: "none" }
          : { type: "bearer-env", env: apiKeyEnv },
        headers: [],
        timeouts: profile.timeouts,
        ...(endpointBaseUrl.startsWith("http://") ? { allowInsecureHttp: true as const } : {})
      }
    },
    models: {
      [modelId]: {
        connectionId,
        remoteId: runtimeConfiguration.model.id,
        name: runtimeConfiguration.model.identity,
        discovered: { contextWindow: runtimeConfiguration.koboldCpp.contextWindow },
        overrides: {},
        capabilities
      }
    },
    profiles: { [profileId]: generationProfile },
    routing: { default: profileId },
    writing: { defaultAuthorBrief: "" }
  };
}

export type ProfileExportCandidate = {
  readonly name: string;
  readonly temperature?: number | null;
  readonly maxOutputTokens?: number;
  readonly effort?: GenerationEffortV2;
  readonly cachePolicy?: string;
  readonly tokenProbabilities?: number | null;
  readonly sampling?: Partial<SamplingSettingsV2>;
  readonly timeouts: ConnectionTimeoutsV2;
  readonly omittedCount?: number;
  readonly fidelity?: readonly string[];
};

function parseReplayTimeouts(value: unknown, label: string): ConnectionTimeoutsV2 {
  const timeouts = requireRecord(value, label);
  requireKeys(timeouts, ["responseHeaderMs", "firstTokenMs", "idleMs", "totalMs"], label);
  const responseHeaderMs = timeoutMs(timeouts.responseHeaderMs, `${label}.responseHeaderMs`);
  const firstTokenMs = timeoutMs(timeouts.firstTokenMs, `${label}.firstTokenMs`);
  const idleMs = timeoutMs(timeouts.idleMs, `${label}.idleMs`);
  const totalMs = timeoutMs(timeouts.totalMs, `${label}.totalMs`);
  if (responseHeaderMs > totalMs || firstTokenMs > totalMs || idleMs > totalMs) {
    throw new Error(`${label} cannot exceed totalMs`);
  }
  return { responseHeaderMs, firstTokenMs, idleMs, totalMs };
}

function timeoutMs(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1_000) {
    throw new Error(`${label} must be a safe integer of at least 1000`);
  }
  return value as number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalManifestText(value: unknown): string { return canonicalJson(value); }

function validateReplayLogitBias(value: unknown): Readonly<Record<string, number>> {
  try {
    return validateSamplingLogitBias(value, "Gemma replay profile manifest.profile.sampling.logitBias");
  } catch (error: unknown) {
    throw new Error(
      `Gemma replay profile manifest.profile.sampling.logitBias is invalid: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const received = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (received.length !== sorted.length || received.some((key, index) => key !== sorted[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
}

import { canonicalJson } from "./canonical-json.js";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";
import type { ProfileTransferCandidate } from "../shared/generation-profile-transfer.js";
import {
  CONTINUATION_PROMPT_OPTIMIZATION_V2_VALUES,
  type ContinuationPromptOptimizationV2
} from "../shared/continuation-prompt-optimization.js";
import {
  GENERATION_EFFORT_V2_VALUES,
  PROMPT_CACHE_POLICY_V2_VALUES,
  SAMPLING_KNOB_V2_VALUES,
  SAMPLING_SCALAR_KNOB_V2_VALUES,
  type SamplingSettingsV2,
  type SettingsDocumentV2
} from "../shared/settings-v2-types.js";
import { resolveSettingsProfile } from "../shared/settings-route.js";
import { samplingKnobValueIsSet } from "../shared/sampling-capabilities.js";
import {
  validateSamplingBannedStrings,
  validateSamplingDryBreakers,
  validateSamplingPhraseBias,
  validateSamplingScalarOrNull,
  validateSamplingStopSequences
} from "../shared/sampling-validation-policy.js";
import {
  requireFiniteTemperature,
  requirePositiveSettingsInteger
} from "./settings-v2-scalars.js";
import { hasUnpairedSurrogate } from "../shared/unicode.js";
import { MAX_ALTERNATIVE_TOKENS } from "../shared/token-probabilities.js";

export interface ProfileExport { readonly extension: ".profile.json"; readonly text: string; readonly fidelity: readonly string[]; }

export function exportGenerationProfile(document: SettingsDocumentV2, profileId: string): ProfileExport {
  const route = resolveSettingsProfile(document, profileId);
  const { profile } = route;
  const hasRawLogitBias = profile.sampling !== undefined
    && samplingKnobValueIsSet(profile.sampling, "logitBias");
  const sampling = profile.sampling === undefined ? {} : Object.fromEntries(
    SAMPLING_KNOB_V2_VALUES
      // Raw token IDs only have meaning for the source tokenizer. Profile
      // Exports deliberately omit route and model identity, so retaining
      // them would silently bias different tokens on import.
      .filter((knob) => knob !== "logitBias")
      .filter((knob) => samplingKnobValueIsSet(profile.sampling!, knob))
      .map((knob) => [knob, profile.sampling![knob]])
  );
  const exportVersion = profile.continuationPromptOptimization === undefined ? 1 : 2;
  return {
    extension: ".profile.json",
    text: `${canonicalJson({ profileExportVersion: exportVersion, name: profile.name, generation: { temperature: profile.temperature, maxOutputTokens: profile.maxOutputTokens, effort: profile.effort, cachePolicy: profile.cachePolicy, ...(profile.tokenProbabilities === undefined ? {} : { tokenProbabilities: profile.tokenProbabilities }), ...(profile.continuationPromptOptimization === undefined ? {} : { continuationPromptOptimization: profile.continuationPromptOptimization }) }, sampling })}\n`,
    fidelity: [
      "connection, credentials, and headers omitted; the file carries generation behavior only",
      ...(hasRawLogitBias ? ["raw logit bias omitted; token IDs require source tokenizer identity"] : [])
    ]
  };
}

export function importProfileExport(text: string): ProfileTransferCandidate {
  const raw = record(parseJsonRejectingDuplicateKeys(text, "Profile Export", { maxValues: 4_096 }));
  return importProfileExportRecord(raw);
}

/** Validate the data-bearing fields before a Profile Export can enter settings. */
export function importProfileExportRecord(raw: Record<string, unknown>): ProfileTransferCandidate {
  if (raw.profileExportVersion !== 1 && raw.profileExportVersion !== 2) throw new Error("file is not a NovelAI Sampler Preset or supported Profile Export");
  rejectUnknownFields(raw, ["profileExportVersion", "name", "route", "generation", "sampling"], "Profile Export");
  const generation = record(raw.generation);
  const sampling = raw.sampling === undefined ? {} : record(raw.sampling);
  if (typeof raw.name !== "string") throw new Error("Profile Export name must be a string");
  if (hasUnpairedSurrogate(raw.name)) throw new Error("Profile Export name has an unpaired Unicode surrogate");
  const hasContinuationPromptOptimization = Object.hasOwn(generation, "continuationPromptOptimization");
  const generationFields = ["temperature", "maxOutputTokens", "effort", "cachePolicy", "tokenProbabilities"];
  if (raw.profileExportVersion === 2) {
    // Version 2 is reserved for the one experimental field. This keeps a
    // closed version-1 reader safe and makes the version signal meaningful.
    if (!hasContinuationPromptOptimization) {
      throw new Error("Profile Export version 2 must set continuationPromptOptimization");
    }
    generationFields.push("continuationPromptOptimization");
  }
  rejectUnknownFields(generation, generationFields, "Profile Export generation");
  validateLegacyRoute(raw.route);
  const effort = generation.effort;
  const cachePolicy = generation.cachePolicy;
  if (effort !== undefined && !isGenerationEffort(effort)) {
    throw new Error("Profile Export has an invalid reasoning effort");
  }
  if (cachePolicy !== undefined && !isCachePolicy(cachePolicy)) {
    throw new Error("Profile Export has an invalid cache policy");
  }
  const temperature = generation.temperature === undefined
    ? undefined
    : requireFiniteTemperature(generation.temperature, "Profile Export generation.temperature");
  const maxOutputTokens = generation.maxOutputTokens === undefined
    ? undefined
    : requirePositiveSettingsInteger(
      generation.maxOutputTokens,
      "Profile Export generation.maxOutputTokens",
      1_000_000_000
    );
  const tokenProbabilities = generation.tokenProbabilities === undefined || generation.tokenProbabilities === null
    ? null
    : requirePositiveSettingsInteger(
      generation.tokenProbabilities,
      "Profile Export generation.tokenProbabilities",
      MAX_ALTERNATIVE_TOKENS
    );
  const continuationPromptOptimization = hasContinuationPromptOptimization
    ? parseContinuationPromptOptimization(generation.continuationPromptOptimization)
    : undefined;
  const parsedSampling = parseSampling(sampling);
  return {
    name: raw.name,
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(effort === undefined ? {} : { effort }),
    ...(cachePolicy === undefined ? {} : { cachePolicy }),
    tokenProbabilities,
    ...(continuationPromptOptimization === undefined ? {} : { continuationPromptOptimization }),
    sampling: parsedSampling.sampling,
    ...(parsedSampling.omittedCount === 0 ? {} : { omittedCount: parsedSampling.omittedCount }),
    ...(parsedSampling.fidelity.length === 0 ? {} : { fidelity: parsedSampling.fidelity })
  };
}

function parseContinuationPromptOptimization(value: unknown): ContinuationPromptOptimizationV2 {
  if (typeof value !== "string"
    || !CONTINUATION_PROMPT_OPTIMIZATION_V2_VALUES.includes(value as ContinuationPromptOptimizationV2)) {
    throw new Error("Profile Export has an invalid continuation prompt optimization");
  }
  return value as ContinuationPromptOptimizationV2;
}

function parseSampling(raw: Record<string, unknown>): {
  readonly sampling: Partial<SamplingSettingsV2>;
  readonly omittedCount: number;
  readonly fidelity: readonly string[];
} {
  rejectUnknownFields(raw, SAMPLING_KNOB_V2_VALUES, "Profile Export sampling");
  const sampling: { -readonly [Key in keyof SamplingSettingsV2]?: SamplingSettingsV2[Key] } = {};
  for (const knob of SAMPLING_SCALAR_KNOB_V2_VALUES) {
    if (raw[knob] === undefined) continue;
    const value = validateSamplingScalarOrNull(knob, raw[knob], `Profile Export sampling.${knob}`);
    if (value !== null) Object.assign(sampling, { [knob]: value });
  }
  if (raw.stop !== undefined) sampling.stop = validateSamplingStopSequences(raw.stop, "Profile Export sampling.stop");
  // Version 1 files can contain this field from before Profile Exports became
  // route-neutral. Do not validate or apply foreign token identifiers.
  if (raw.bannedStrings !== undefined) sampling.bannedStrings = validateSamplingBannedStrings(raw.bannedStrings, "Profile Export sampling.bannedStrings");
  if (raw.phraseBias !== undefined) sampling.phraseBias = validateSamplingPhraseBias(raw.phraseBias, "Profile Export sampling.phraseBias");
  if (raw.dryBreakers !== undefined) sampling.dryBreakers = validateSamplingDryBreakers(raw.dryBreakers, "Profile Export sampling.dryBreakers");
  return {
    sampling,
    omittedCount: Number(raw.logitBias !== undefined),
    fidelity: raw.logitBias === undefined
      ? []
      : ["raw logit bias not imported; token IDs require source tokenizer identity"]
  };
}

/** Version 1 exports once carried route data. Validate, then discard it. */
function validateLegacyRoute(value: unknown): void {
  if (value === undefined) return;
  const route = record(value);
  rejectUnknownFields(route, ["protocol", "preset", "remoteModelId"], "Profile Export route");
  for (const field of ["protocol", "preset", "remoteModelId"] as const) {
    if (route[field] !== undefined && typeof route[field] !== "string") {
      throw new Error(`Profile Export route.${field} must be a string`);
    }
  }
}

function rejectUnknownFields(raw: Record<string, unknown>, fields: readonly string[], label: string): void {
  const unknown = Object.keys(raw).filter((field) => !fields.includes(field)).sort();
  if (unknown.length > 0) throw new Error(`${label} has an unsupported field: ${unknown[0]}`);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Profile Export has an invalid object");
  }
  return value as Record<string, unknown>;
}

function isGenerationEffort(value: unknown): value is (typeof GENERATION_EFFORT_V2_VALUES)[number] {
  return typeof value === "string" && GENERATION_EFFORT_V2_VALUES.includes(value as (typeof GENERATION_EFFORT_V2_VALUES)[number]);
}

function isCachePolicy(value: unknown): value is (typeof PROMPT_CACHE_POLICY_V2_VALUES)[number] {
  return typeof value === "string" && PROMPT_CACHE_POLICY_V2_VALUES.includes(value as (typeof PROMPT_CACHE_POLICY_V2_VALUES)[number]);
}

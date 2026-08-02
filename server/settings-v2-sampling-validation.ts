import {
  SAMPLING_KNOB_V2_ADDITIVE_VALUES,
  SAMPLING_KNOB_V2_VALUES,
  type GenerationProfileV2,
  type ModelConnectionV2,
  type ModelDefinitionV2,
  type SamplingKnobV2,
  type SamplingSettingsV2
} from "../shared/settings-v2-types.js";
import {
  promptBiasTokenizerEncoding,
  resolveConfiguredSamplingKnobs,
  samplingContextForRoute,
  samplingKnobValueIsSet,
  samplingKnobLabel
} from "../shared/sampling-capabilities.js";
import type { SamplingUnavailableReason } from "../shared/sampling-capabilities.js";
import type { SelectedSettingsRouteV2 } from "../shared/settings-route.js";
import {
  maxResolvedLogitBiasEntries,
  SamplingValidationError,
  validateSamplingBannedStrings,
  validateSamplingLogitBias,
  validateSamplingPhraseBias,
  validateSamplingScalarOrNull,
  validateSamplingStopSequences,
  type SamplingScalarKnob
} from "../shared/sampling-validation-policy.js";
import { closedRecord, closedShape } from "./story-wire-validation.js";
import { SettingsFormatError } from "./settings-v2-scalars.js";
import {
  samplingBiasEntryRejectionMessage,
  type SamplingBiasEntryResolution,
  type SamplingBiasResolutionResult
} from "../shared/sampling-capabilities.js";
import {
  isLogitBiasMergeKnob,
  resolveSamplingLogitBiasForEncoding
} from "./sampling-phrase-bias.js";

// SAMPLING_KNOB_V2_ADDITIVE_VALUES are optional on the wire: a settings
// document written before issue #282 has a `sampling` object without them,
// and it must still decode. Every field present before that change stays
// required, unchanged from the original schema.
const SAMPLING = closedShape(
  SAMPLING_KNOB_V2_VALUES.filter((knob) => !(SAMPLING_KNOB_V2_ADDITIVE_VALUES as readonly SamplingKnobV2[]).includes(knob)),
  [...SAMPLING_KNOB_V2_ADDITIVE_VALUES]
);

export function parseSampling(value: unknown, label: string): SamplingSettingsV2 | undefined {
  if (value === undefined) return undefined;
  const sampling = closedRecord(value, label, SAMPLING);
  const parsed: SamplingSettingsV2 = samplingPolicy(() => ({
    topP: samplingScalarOrNull("topP", sampling.topP, `${label}.topP`),
    topK: samplingScalarOrNull("topK", sampling.topK, `${label}.topK`),
    minP: samplingScalarOrNull("minP", sampling.minP, `${label}.minP`),
    frequencyPenalty: samplingScalarOrNull(
      "frequencyPenalty",
      sampling.frequencyPenalty,
      `${label}.frequencyPenalty`
    ),
    presencePenalty: samplingScalarOrNull(
      "presencePenalty",
      sampling.presencePenalty,
      `${label}.presencePenalty`
    ),
    repeatPenalty: samplingScalarOrNull(
      "repeatPenalty",
      sampling.repeatPenalty,
      `${label}.repeatPenalty`
    ),
    seed: samplingScalarOrNull("seed", sampling.seed, `${label}.seed`),
    stop: validateSamplingStopSequences(sampling.stop, `${label}.stop`),
    logitBias: validateSamplingLogitBias(sampling.logitBias, `${label}.logitBias`),
    bannedStrings: validateSamplingBannedStrings(
      sampling.bannedStrings ?? [],
      `${label}.bannedStrings`
    ),
    phraseBias: validateSamplingPhraseBias(sampling.phraseBias ?? [], `${label}.phraseBias`)
  }));
  return SAMPLING_KNOB_V2_VALUES.some((knob) => samplingKnobValueIsSet(parsed, knob))
    ? parsed
    : undefined;
}

function samplingScalarOrNull(
  knob: SamplingScalarKnob,
  value: unknown,
  label: string
): number | null {
  return validateSamplingScalarOrNull(knob, value, label);
}

function samplingPolicy<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof SamplingValidationError) {
      throw new SettingsFormatError(error.message, { cause: error });
    }
    throw error;
  }
}

/**
 * Validates a profile's sampling route, including — whenever logitBias,
 * phraseBias, or bannedStrings is configured — that it resolves within the
 * preset-aware resolved-entry bound with no rejected or shadowed entry, so a
 * document that cannot serialize into a request never saves cleanly in the
 * first place (issue #282 review round 2, finding 6). Checked unconditionally,
 * even when only the raw numeric logitBias map is set: a raw map alone can
 * still carry more entries than a preset (KoboldCpp) documents.
 *
 * `precomputedResolution`, when supplied, is used as-is instead of resolving
 * again here. This function is otherwise synchronous — every other caller
 * (document decode: server/settings-v2-codec.ts, server/settings-v2-state-
 * validation.ts, tui/src/api-response-decoders.ts) runs far more often than
 * a save and must never make a network call — so it falls back to a local,
 * synchronous resolution when nothing is supplied. That local fallback
 * cannot check "llama-cpp": its tokenizer is a live probe
 * (server/context-probe.ts, probeLlamaCppTokenize), not a local allow-list,
 * so those callers still skip the bias check for it, same as before. The
 * save path (server/settings-v2-store.ts) is async already, so it is the one
 * caller that resolves llama-cpp for real and supplies the result here —
 * one enforcement point for the whole logit-bias family, on every preset,
 * instead of a synchronous check for one preset and a bypass for another.
 *
 * A resolution that comes back "tokenizer-unavailable" never blocks the
 * save: an unreachable llama.cpp server is indistinguishable here from
 * "briefly offline", and request-time application
 * (server/provider-sampling.ts) re-verifies against the live server and
 * enforces the resolved-count bound before every request regardless.
 */
export function validateSamplingRoute(
  profileId: string,
  profile: GenerationProfileV2,
  model: ModelDefinitionV2,
  connection: ModelConnectionV2,
  precomputedResolution?: SamplingBiasResolutionResult
): void {
  if (profile.sampling === undefined) return;
  const route: SelectedSettingsRouteV2 = { profileId, profile, model, connection };
  const context = samplingContextForRoute(route);
  const configured = resolveConfiguredSamplingKnobs(context, profile.sampling);
  for (const { knob, resolution } of configured) {
    if (resolution.kind === "unavailable") {
      throw new SettingsFormatError(samplingValidationMessage(profileId, knob, resolution.reason));
    }
  }
  if (context.protocol === "legacy-v1" || context.preset === "legacy-v1") return;
  if (!configured.some(({ knob }) => isLogitBiasMergeKnob(knob))) return;
  const preset = context.preset;
  const resolved = precomputedResolution ?? (
    preset === "llama-cpp"
      ? undefined
      : resolveSamplingLogitBiasForEncoding(profile.sampling, promptBiasTokenizerEncoding(context.remoteModelId))
  );
  if (resolved === undefined || resolved.kind !== "resolved") return;
  const rejected = firstRejectedEntry(resolved.phraseBias, resolved.bannedStrings);
  if (rejected !== undefined) {
    throw new SettingsFormatError(
      `profile ${profileId} cannot use ${JSON.stringify(rejected.phrase)} as configured: `
      + samplingBiasEntryRejectionMessage(rejected)
    );
  }
  const bound = maxResolvedLogitBiasEntries(preset);
  if (resolved.resolvedEntryCount > bound) {
    throw new SettingsFormatError(
      `profile ${profileId} resolves to ${resolved.resolvedEntryCount} logit-bias entries, `
      + `exceeding the ${bound}-entry limit for preset ${preset}`
    );
  }
}

function firstRejectedEntry(
  phraseBias: readonly SamplingBiasEntryResolution[],
  bannedStrings: readonly SamplingBiasEntryResolution[]
): Extract<SamplingBiasEntryResolution, { kind: "rejected" }> | undefined {
  for (const entry of [...phraseBias, ...bannedStrings]) {
    if (entry.kind === "rejected") return entry;
  }
  return undefined;
}

function samplingValidationMessage(
  profileId: string,
  knob: SamplingKnobV2,
  reason: SamplingUnavailableReason
): string {
  const details: Readonly<Record<SamplingUnavailableReason, string>> = {
    "legacy-v1": "for read-only format 1 settings",
    "dry-run": "for a dry-run connection",
    protocol: "for a protocol that does not document it",
    "preset-unsupported": "for a preset that does not document it",
    "preset-unknown": "for an endpoint with undocumented extension fields",
    "model-unsupported": "for a model that does not declare sampling support",
    "model-unknown": "for a model without a documented sampling contract",
    "no-exact-tokenizer": "for a model with no exact tokenizer to resolve text to token IDs",
    "reasoning-model": "for a reasoning model, which rejects logit bias"
  };
  return `profile ${profileId} sets ${samplingKnobLabel(knob)} ${details[reason]}`;
}

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
import { resolveSamplingLogitBias } from "./sampling-phrase-bias.js";

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

export function validateSamplingRoute(
  profileId: string,
  profile: GenerationProfileV2,
  model: ModelDefinitionV2,
  connection: ModelConnectionV2
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
  // Tokenize now, at save time, so a phrase list that would exceed the
  // resolved bound (shared/sampling-validation-policy.ts) is rejected with a
  // clear message instead of failing later mid-generation.
  const needsResolution = configured.some(({ knob }) => knob === "phraseBias" || knob === "bannedStrings");
  if (!needsResolution || context.protocol === "legacy-v1" || context.preset === "legacy-v1") return;
  const encoding = promptBiasTokenizerEncoding(context.remoteModelId);
  if (encoding === null) return; // already rejected above as "no-exact-tokenizer"
  const resolved = resolveSamplingLogitBias(profile.sampling, encoding);
  if (resolved === null) {
    throw new SettingsFormatError(`profile ${profileId} could not resolve phrase bias or banned strings: the tokenizer is unavailable`);
  }
  const bound = maxResolvedLogitBiasEntries(context.preset);
  if (resolved.resolvedEntryCount > bound) {
    throw new SettingsFormatError(
      `profile ${profileId} resolves to ${resolved.resolvedEntryCount} logit-bias entries after tokenizing `
      + `phrase bias and banned strings, exceeding the ${bound}-entry limit for preset ${context.preset}`
    );
  }
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
    "no-exact-tokenizer": "for a model with no exact tokenizer to resolve text to token IDs"
  };
  return `profile ${profileId} sets ${samplingKnobLabel(knob)} ${details[reason]}`;
}

import {
  SAMPLING_KNOB_V2_VALUES,
  type GenerationProfileV2,
  type ModelConnectionV2,
  type ModelDefinitionV2,
  type SamplingKnobV2,
  type SamplingSettingsV2
} from "../shared/settings-v2-types.js";
import {
  resolveConfiguredSamplingKnobs,
  samplingContextForRoute,
  samplingKnobValueIsSet,
  samplingKnobLabel
} from "../shared/sampling-capabilities.js";
import type { SamplingUnavailableReason } from "../shared/sampling-capabilities.js";
import type { SelectedSettingsRouteV2 } from "../shared/settings-route.js";
import {
  SamplingValidationError,
  validateSamplingLogitBias,
  validateSamplingScalarOrNull,
  validateSamplingStopSequences,
  type SamplingScalarKnob
} from "../shared/sampling-validation-policy.js";
import { closedRecord, closedShape } from "./story-wire-validation.js";
import { SettingsFormatError } from "./settings-v2-scalars.js";

const SAMPLING = closedShape(SAMPLING_KNOB_V2_VALUES);

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
    logitBias: validateSamplingLogitBias(sampling.logitBias, `${label}.logitBias`)
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
  for (const { knob, resolution } of resolveConfiguredSamplingKnobs(context, profile.sampling)) {
    if (resolution.kind === "unavailable") {
      throw new SettingsFormatError(samplingValidationMessage(profileId, knob, resolution.reason));
    }
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
    "model-unknown": "for a model without a documented sampling contract"
  };
  return `profile ${profileId} sets ${samplingKnobLabel(knob)} ${details[reason]}`;
}

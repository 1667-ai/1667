import {
  SAMPLING_KNOB_V2_VALUES,
  type GenerationProfileV2,
  type ModelConnectionV2,
  type ModelDefinitionV2,
  type SamplingKnobV2,
  type SamplingSettingsV2
} from "../shared/settings-v2-types.js";
import {
  resolveSamplingKnob,
  samplingContextForRoute,
  samplingKnobValueIsSet,
  samplingKnobWireName
} from "../shared/sampling-capabilities.js";
import type { SamplingUnavailableReason } from "../shared/sampling-capabilities.js";
import type { SelectedSettingsRouteV2 } from "../shared/settings-route.js";
import { closedRecord, closedShape } from "./story-wire-validation.js";
import {
  SettingsFormatError,
  requireSamplingLogitBias,
  requireSamplingNumber,
  requireSamplingStopSequences,
  requireSamplingTopK
} from "./settings-v2-scalars.js";

const SAMPLING = closedShape([
  "topP",
  "topK",
  "minP",
  "frequencyPenalty",
  "presencePenalty",
  "repeatPenalty",
  "stop",
  "logitBias"
]);

export function parseSampling(value: unknown, label: string): SamplingSettingsV2 | undefined {
  if (value === undefined) return undefined;
  const sampling = closedRecord(value, label, SAMPLING);
  const parsed: SamplingSettingsV2 = {
    topP: sampling.topP === null ? null : requireSamplingNumber(sampling.topP, `${label}.topP`, 0, 1),
    topK: sampling.topK === null ? null : requireSamplingTopK(sampling.topK, `${label}.topK`),
    minP: sampling.minP === null ? null : requireSamplingNumber(sampling.minP, `${label}.minP`, 0, 1),
    frequencyPenalty: sampling.frequencyPenalty === null
      ? null
      : requireSamplingNumber(sampling.frequencyPenalty, `${label}.frequencyPenalty`, -2, 2),
    presencePenalty: sampling.presencePenalty === null
      ? null
      : requireSamplingNumber(sampling.presencePenalty, `${label}.presencePenalty`, -2, 2),
    repeatPenalty: sampling.repeatPenalty === null
      ? null
      : requireSamplingNumber(sampling.repeatPenalty, `${label}.repeatPenalty`, 1, 10),
    stop: requireSamplingStopSequences(sampling.stop, `${label}.stop`),
    logitBias: requireSamplingLogitBias(sampling.logitBias, `${label}.logitBias`)
  };
  return SAMPLING_KNOB_V2_VALUES.some((knob) => samplingKnobValueIsSet(parsed, knob))
    ? parsed
    : undefined;
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
  for (const knob of SAMPLING_KNOB_V2_VALUES) {
    if (!samplingKnobValueIsSet(profile.sampling, knob)) continue;
    const resolution = resolveSamplingKnob(context, knob);
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
  return `profile ${profileId} sets ${samplingKnobWireName(knob)} ${details[reason]}`;
}

import {
  SAMPLING_KNOB_V2_ADDITIVE_VALUES,
  SAMPLING_KNOB_V2_REQUIRED_VALUES,
  SAMPLING_KNOB_V2_VALUES,
  SAMPLING_SCALAR_KNOB_V2_VALUES,
  type SamplingKnobV2,
  type SamplingSettingsV2
} from "./settings-v2-types.js";
import {
  samplingKnobValueIsSet
} from "./sampling-capabilities.js";
import {
  SamplingValidationError,
  validateSamplingBannedStrings,
  validateSamplingDryBreakers,
  validateSamplingLogitBias,
  validateSamplingPhraseBias,
  validateSamplingScalarOrNull,
  validateSamplingStopSequences,
  type SamplingScalarKnob
} from "./sampling-validation-policy.js";
import { closedRecord, closedShape } from "./settings-wire-validation.js";
import { SettingsFormatError } from "./settings-validation-scalars.js";

// SAMPLING_KNOB_V2_ADDITIVE_VALUES are optional on the wire: a settings
// document written before issue #282 has a `sampling` object without them,
// and it must still decode. SAMPLING_KNOB_V2_REQUIRED_VALUES is their
// complement, derived once in shared/settings-v2-types.ts so this required
// list and the schema definition (scripts/settings-v2-schema-definition.ts)
// cannot drift apart (issue #282 review round 5, finding 4).
const SAMPLING = closedShape(
  SAMPLING_KNOB_V2_REQUIRED_VALUES,
  [...SAMPLING_KNOB_V2_ADDITIVE_VALUES]
);

export function parseSampling(value: unknown, label: string): SamplingSettingsV2 | undefined {
  if (value === undefined) return undefined;
  const sampling = closedRecord(value, label, SAMPLING);
  const parsed: SamplingSettingsV2 = samplingPolicy(() => ({
    ...Object.fromEntries(
      SAMPLING_SCALAR_KNOB_V2_VALUES.map((knob) => [
        knob,
        samplingScalarOrNull(knob, sampling[knob], `${label}.${knob}`)
      ])
    ),
    stop: validateSamplingStopSequences(sampling.stop, `${label}.stop`),
    logitBias: validateSamplingLogitBias(sampling.logitBias, `${label}.logitBias`),
    bannedStrings: validateSamplingBannedStrings(
      sampling.bannedStrings ?? [],
      `${label}.bannedStrings`
    ),
    phraseBias: validateSamplingPhraseBias(sampling.phraseBias ?? [], `${label}.phraseBias`),
    dryBreakers: validateSamplingDryBreakers(sampling.dryBreakers, `${label}.dryBreakers`)
  } as SamplingSettingsV2));
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

export type { SamplingKnobV2 };

import {
  SAMPLING_SCALAR_KNOB_V2_VALUES,
  type SamplingScalarKnobV2,
  type SamplingSettingsV2
} from "./settings-v2-types.js";
import { hasUnpairedSurrogate, unicodeScalarLength } from "./unicode.js";

export type SamplingScalarKnob = SamplingScalarKnobV2;

export interface SamplingScalarDescriptor {
  readonly minimum: number;
  readonly maximum: number;
  readonly integer: boolean;
}

export const SAMPLING_SCALAR_KNOBS = SAMPLING_SCALAR_KNOB_V2_VALUES;

export const SAMPLING_SCALAR_DESCRIPTORS = {
  topP: { minimum: 0, maximum: 1, integer: false },
  topK: { minimum: 0, maximum: 100_000, integer: true },
  minP: { minimum: 0, maximum: 1, integer: false },
  frequencyPenalty: { minimum: -2, maximum: 2, integer: false },
  presencePenalty: { minimum: -2, maximum: 2, integer: false },
  repeatPenalty: { minimum: 1, maximum: 10, integer: false },
  seed: { minimum: 1, maximum: 999_999, integer: true }
} as const satisfies Readonly<Record<SamplingScalarKnob, SamplingScalarDescriptor>>;

export const SAMPLING_STOP_POLICY = {
  maxSequences: 4,
  maxScalars: 64
} as const;

export const SAMPLING_LOGIT_BIAS_POLICY = {
  maxEntries: 16,
  keyPatternSource: "(0|[1-9][0-9]{0,6})",
  minimum: -100,
  maximum: 100
} as const;

export const SAMPLING_LOGIT_BIAS_KEY_PATTERN_SOURCE =
  SAMPLING_LOGIT_BIAS_POLICY.keyPatternSource;
export const SAMPLING_LOGIT_BIAS_KEY_PATTERN = new RegExp(
  `^(?:${SAMPLING_LOGIT_BIAS_KEY_PATTERN_SOURCE})$`,
  "u"
);

// Compatibility names for server/schema callers. The policy above remains the
// only owner of these values.
export const MAX_SAMPLING_TOP_K = SAMPLING_SCALAR_DESCRIPTORS.topK.maximum;
export const MAX_SAMPLING_STOP_SEQUENCES = SAMPLING_STOP_POLICY.maxSequences;
export const MAX_SAMPLING_STOP_SCALARS = SAMPLING_STOP_POLICY.maxScalars;
export const MAX_SAMPLING_LOGIT_BIAS_ENTRIES = SAMPLING_LOGIT_BIAS_POLICY.maxEntries;

export class SamplingValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SamplingValidationError";
  }
}

export function validateSamplingScalar(
  knob: SamplingScalarKnob,
  value: unknown,
  label: string
): number {
  return validateSamplingNumber(value, label, SAMPLING_SCALAR_DESCRIPTORS[knob]);
}

export function validateSamplingScalarOrNull(
  knob: SamplingScalarKnob,
  value: unknown,
  label: string
): number | null {
  return value === null ? null : validateSamplingScalar(knob, value, label);
}

export function validateSamplingNumber(
  value: unknown,
  label: string,
  descriptor: SamplingScalarDescriptor
): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || Object.is(value, -0)
    || (descriptor.integer && !Number.isSafeInteger(value))
    || value < descriptor.minimum
    || value > descriptor.maximum
  ) {
    const kind = descriptor.integer ? "an integer" : "a finite number";
    throw new SamplingValidationError(
      `${label} must be ${kind} in ${descriptor.minimum}..${descriptor.maximum}`
    );
  }
  return value;
}

export function validateSamplingStopSequences(
  value: unknown,
  label: string
): readonly string[] {
  if (!Array.isArray(value)) throw new SamplingValidationError(`${label} must be an array`);
  if (value.length > SAMPLING_STOP_POLICY.maxSequences) {
    throw new SamplingValidationError(
      `${label} exceeds the ${SAMPLING_STOP_POLICY.maxSequences}-item limit`
    );
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (typeof entry !== "string" || hasUnpairedSurrogate(entry)) {
      throw new SamplingValidationError(
        `${label}[${index}] must be a well-formed NFC string`
      );
    }
    if (entry.normalize("NFC") !== entry) {
      throw new SamplingValidationError(`${label}[${index}] must be NFC-normalized`);
    }
    const scalarLength = unicodeScalarLength(entry, SAMPLING_STOP_POLICY.maxScalars);
    if (scalarLength < 1 || scalarLength > SAMPLING_STOP_POLICY.maxScalars) {
      throw new SamplingValidationError(
        `${label}[${index}] must contain 1..${SAMPLING_STOP_POLICY.maxScalars} Unicode scalars`
      );
    }
    if (seen.has(entry)) {
      throw new SamplingValidationError(`${label} repeats ${JSON.stringify(entry)}`);
    }
    seen.add(entry);
    return entry;
  });
}

export function validateSamplingLogitBias(
  value: unknown,
  label: string
): Readonly<Record<string, number>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SamplingValidationError(`${label} must be an object`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > SAMPLING_LOGIT_BIAS_POLICY.maxEntries) {
    throw new SamplingValidationError(
      `${label} exceeds the ${SAMPLING_LOGIT_BIAS_POLICY.maxEntries}-entry limit`
    );
  }
  const sorted = entries.map(([key, entry]) => {
    const weight = validateSamplingLogitBiasEntry(key, entry, label);
    return [key, weight] as const;
  });
  sorted.sort((left, right) => Number(left[0]) - Number(right[0]));
  return Object.fromEntries(sorted);
}

export function validateSamplingLogitBiasEntry(
  token: string,
  weight: unknown,
  label: string
): number {
  if (!SAMPLING_LOGIT_BIAS_KEY_PATTERN.test(token)) {
    throw new SamplingValidationError(`${label} key ${JSON.stringify(token)} is invalid`);
  }
  return validateSamplingNumber(
    weight,
    `${label}.${token}`,
    {
      minimum: SAMPLING_LOGIT_BIAS_POLICY.minimum,
      maximum: SAMPLING_LOGIT_BIAS_POLICY.maximum,
      integer: true
    }
  );
}

export function validateSamplingSettings(
  sampling: SamplingSettingsV2,
  label = "sampling"
): SamplingSettingsV2 {
  return {
    topP: validateSamplingScalarOrNull("topP", sampling.topP, `${label}.topP`),
    topK: validateSamplingScalarOrNull("topK", sampling.topK, `${label}.topK`),
    minP: validateSamplingScalarOrNull("minP", sampling.minP, `${label}.minP`),
    frequencyPenalty: validateSamplingScalarOrNull("frequencyPenalty", sampling.frequencyPenalty, `${label}.frequencyPenalty`),
    presencePenalty: validateSamplingScalarOrNull("presencePenalty", sampling.presencePenalty, `${label}.presencePenalty`),
    repeatPenalty: validateSamplingScalarOrNull("repeatPenalty", sampling.repeatPenalty, `${label}.repeatPenalty`),
    seed: validateSamplingScalarOrNull("seed", sampling.seed, `${label}.seed`),
    stop: validateSamplingStopSequences(sampling.stop, `${label}.stop`),
    logitBias: validateSamplingLogitBias(sampling.logitBias, `${label}.logitBias`)
  };
}

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
  seed: { minimum: 1, maximum: 999_999, integer: true },
  dryMultiplier: { minimum: 0, maximum: 5, integer: false },
  dryBase: { minimum: 1, maximum: 4, integer: false },
  dryRange: { minimum: 0, maximum: 131_072, integer: true },
  xtcThreshold: { minimum: 0, maximum: 0.5, integer: false },
  xtcProbability: { minimum: 0, maximum: 1, integer: false },
  dynatempRange: { minimum: 0, maximum: 2, integer: false },
  mirostat: { minimum: 1, maximum: 2, integer: true },
  mirostatTau: { minimum: 0, maximum: 10, integer: false },
  mirostatEta: { minimum: 0, maximum: 1, integer: false }
} as const satisfies Readonly<Record<SamplingScalarKnob, SamplingScalarDescriptor>>;

export const SAMPLING_STOP_POLICY = {
  maxSequences: 4,
  maxScalars: 64
} as const;

// llama.cpp server README and the KoboldCpp API doc (see shared/sampling-capabilities.ts
// for the exact URLs) document `dry_sequence_breakers` with the same shape as a stop
// sequence list: a bounded array of short strings.
//
// The 40-byte cap mirrors the sampler itself, not just the wire doc. llama.cpp's
// `llama_sampler_init_dry` (src/llama-sampler.cpp:3202-3228) declares
// `const int MAX_CHAR_LEN = 40` and does `sequence_break.resize(MAX_CHAR_LEN)` on the
// `std::string`, a byte-level truncation that can land inside a UTF-8 sequence.
// KoboldCpp is a llama.cpp fork and links the same sampler, so both presets share the
// bound. A breaker longer than 40 bytes would be saved and sent as written, then
// silently truncated into a different breaker by the sampler, so the byte bound is
// checked here rather than left to the provider.
export const SAMPLING_DRY_BREAKERS_POLICY = {
  maxSequences: 16,
  maxScalars: 40,
  maxBytes: 40
} as const;

interface SamplingStringListPolicy {
  readonly maxSequences: number;
  readonly maxScalars: number;
  readonly maxBytes?: number;
}

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

function validateSamplingStringList(
  value: unknown,
  label: string,
  policy: SamplingStringListPolicy
): readonly string[] {
  if (!Array.isArray(value)) throw new SamplingValidationError(`${label} must be an array`);
  if (value.length > policy.maxSequences) {
    throw new SamplingValidationError(
      `${label} exceeds the ${policy.maxSequences}-item limit`
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
    const scalarLength = unicodeScalarLength(entry, policy.maxScalars);
    if (scalarLength < 1 || scalarLength > policy.maxScalars) {
      throw new SamplingValidationError(
        `${label}[${index}] must contain 1..${policy.maxScalars} Unicode scalars`
      );
    }
    if (policy.maxBytes !== undefined) {
      const byteLength = new TextEncoder().encode(entry).length;
      if (byteLength < 1 || byteLength > policy.maxBytes) {
        throw new SamplingValidationError(
          `${label}[${index}] must be 1..${policy.maxBytes} UTF-8 bytes`
        );
      }
    }
    if (seen.has(entry)) {
      throw new SamplingValidationError(`${label} repeats ${JSON.stringify(entry)}`);
    }
    seen.add(entry);
    return entry;
  });
}

export function validateSamplingStopSequences(
  value: unknown,
  label: string
): readonly string[] {
  return validateSamplingStringList(value, label, SAMPLING_STOP_POLICY);
}

export function validateSamplingDryBreakers(
  value: unknown,
  label: string
): readonly string[] {
  return validateSamplingStringList(value, label, SAMPLING_DRY_BREAKERS_POLICY);
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
  const scalars = Object.fromEntries(
    SAMPLING_SCALAR_KNOB_V2_VALUES.map((knob) => [
      knob,
      validateSamplingScalarOrNull(knob, sampling[knob], `${label}.${knob}`)
    ])
  ) as Record<SamplingScalarKnobV2, number | null>;
  return {
    ...scalars,
    stop: validateSamplingStopSequences(sampling.stop, `${label}.stop`),
    logitBias: validateSamplingLogitBias(sampling.logitBias, `${label}.logitBias`),
    dryBreakers: validateSamplingDryBreakers(sampling.dryBreakers, `${label}.dryBreakers`)
  };
}

import {
  SAMPLING_SCALAR_KNOB_V2_VALUES,
  type SamplingPhraseBiasEntryV2,
  type SamplingScalarKnobV2,
  type SamplingSettingsV2
} from "./settings-v2-types.js";
import type { SettingsPresetV2 } from "./settings-v2-types.js";
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
  repeatPenalty: { minimum: 1, maximum: 10, integer: false }
} as const satisfies Readonly<Record<SamplingScalarKnob, SamplingScalarDescriptor>>;

export const SAMPLING_STOP_POLICY = {
  maxSequences: 4,
  maxScalars: 64
} as const;

// 16 used to be an unsourced, self-imposed number. The endpoints 1667 speaks
// to document very different ceilings for the *raw* logit_bias map:
//  - OpenAI documents only the per-entry range, no count limit:
//    "Accepts a JSON object that maps tokens ... to an associated bias value
//    from -100 to 100." (CreateChatCompletionRequest.logit_bias)
//    https://github.com/openai/openai-openapi/blob/master/openapi.yaml
//  - llama.cpp's server documents the same shape with no count limit:
//    https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
//  - KoboldCpp is the one exception. Its own docs state a specific number:
//    "An dictionary of key-value pairs, which indicate the token IDs (int)
//    and logit bias (float) to apply for that token. Up to 16 value can be
//    provided." https://github.com/LostRuins/koboldcpp/blob/concedo/embd_res/kcpp_docs.embd
// 200 below is 1667's own operational ceiling for every preset except
// KoboldCpp — generous headroom over a hand-curated list while keeping the
// request body and the editor list bounded. KoboldCpp's tighter, documented
// 16-entry cap is enforced per preset in
// server/settings-v2-sampling-validation.ts (SAMPLING_RESOLVED_LOGIT_BIAS_PRESET_OVERRIDES
// below), because a JSON-schema constant here cannot see which preset saved
// the document.
export const SAMPLING_LOGIT_BIAS_POLICY = {
  maxEntries: 200,
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

/** A phrase can expand to several token IDs at resolution time (issue #282),
 * so the list itself can stay generous: writers asked for sets "far larger"
 * than the old 16-entry logit-bias cap. `maxPhraseScalars` reuses the stop
 * -sequence sizing precedent (`SAMPLING_STOP_POLICY.maxScalars`) — a phrase is
 * text a writer types by hand, not a passage. The weight range matches
 * OpenAI's documented per-token logit_bias range, because each resolved
 * token receives this same weight. */
export const SAMPLING_PHRASE_BIAS_POLICY = {
  maxEntries: 256,
  maxPhraseScalars: 64,
  minimum: -100,
  maximum: 100
} as const;

/** Banned strings are a negative-bias shortcut (see the field comment on
 * `SamplingSettingsV2.bannedStrings`), not a native provider field — see the
 * research note next to `SAMPLING_RESOLVED_LOGIT_BIAS_PRESET_OVERRIDES` in
 * server/settings-v2-sampling-validation.ts for why. Sizing mirrors
 * SAMPLING_PHRASE_BIAS_POLICY for the same reason. */
export const SAMPLING_BANNED_STRINGS_POLICY = {
  maxEntries: 256,
  maxScalars: 64
} as const;

/** The bound that actually protects a provider request: phrase-bias and
 * banned-string entries tokenize to zero or more IDs each and merge with the
 * raw `logitBias` map into one `logit_bias` object
 * (shared/sampling-capabilities.ts documents the merge order). This is the
 * cap on that merged object's size, checked server-side once tokenization is
 * available — see `resolveSamplingLogitBias` in server/sampling-phrase-bias.ts. */
export const SAMPLING_RESOLVED_LOGIT_BIAS_POLICY = {
  maxEntries: 200
} as const;

/** KoboldCpp's documented 16-entry logit_bias cap (quoted above) is the only
 * one of 1667's supported endpoints with a specific documented number. Every
 * other preset uses SAMPLING_RESOLVED_LOGIT_BIAS_POLICY.maxEntries. */
export const SAMPLING_RESOLVED_LOGIT_BIAS_PRESET_OVERRIDES: Readonly<
  Partial<Record<SettingsPresetV2, number>>
> = {
  koboldcpp: 16
};

export function maxResolvedLogitBiasEntries(preset: SettingsPresetV2): number {
  return SAMPLING_RESOLVED_LOGIT_BIAS_PRESET_OVERRIDES[preset]
    ?? SAMPLING_RESOLVED_LOGIT_BIAS_POLICY.maxEntries;
}

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
  return validateSamplingTextList(value, label, SAMPLING_STOP_POLICY.maxSequences, SAMPLING_STOP_POLICY.maxScalars);
}

/** Shared shape behind `stop`, `bannedStrings`, and each `phraseBias.phrase`:
 * a bounded list of unique, well-formed NFC strings a writer typed by hand. */
function validateSamplingTextList(
  value: unknown,
  label: string,
  maxItems: number,
  maxScalars: number
): readonly string[] {
  if (!Array.isArray(value)) throw new SamplingValidationError(`${label} must be an array`);
  if (value.length > maxItems) {
    throw new SamplingValidationError(`${label} exceeds the ${maxItems}-item limit`);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const text = validateSamplingText(entry, `${label}[${index}]`, maxScalars);
    if (seen.has(text)) {
      throw new SamplingValidationError(`${label} repeats ${JSON.stringify(text)}`);
    }
    seen.add(text);
    return text;
  });
}

function validateSamplingText(value: unknown, label: string, maxScalars: number): string {
  if (typeof value !== "string" || hasUnpairedSurrogate(value)) {
    throw new SamplingValidationError(`${label} must be a well-formed NFC string`);
  }
  if (value.normalize("NFC") !== value) {
    throw new SamplingValidationError(`${label} must be NFC-normalized`);
  }
  const scalarLength = unicodeScalarLength(value, maxScalars);
  if (scalarLength < 1 || scalarLength > maxScalars) {
    throw new SamplingValidationError(`${label} must contain 1..${maxScalars} Unicode scalars`);
  }
  return value;
}

export function validateSamplingBannedStrings(
  value: unknown,
  label: string
): readonly string[] {
  return validateSamplingTextList(
    value,
    label,
    SAMPLING_BANNED_STRINGS_POLICY.maxEntries,
    SAMPLING_BANNED_STRINGS_POLICY.maxScalars
  );
}

export function validateSamplingPhraseBias(
  value: unknown,
  label: string
): readonly SamplingPhraseBiasEntryV2[] {
  if (!Array.isArray(value)) throw new SamplingValidationError(`${label} must be an array`);
  if (value.length > SAMPLING_PHRASE_BIAS_POLICY.maxEntries) {
    throw new SamplingValidationError(
      `${label} exceeds the ${SAMPLING_PHRASE_BIAS_POLICY.maxEntries}-item limit`
    );
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new SamplingValidationError(`${label}[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const parsed = validateSamplingPhraseBiasEntry(record.phrase, record.weight, `${label}[${index}]`);
    if (seen.has(parsed.phrase)) {
      throw new SamplingValidationError(`${label} repeats ${JSON.stringify(parsed.phrase)}`);
    }
    seen.add(parsed.phrase);
    return parsed;
  });
}

/** Single-entry validator, exported for the editor's inline phrase:weight
 * form — the same split the whole-list `validateSamplingPhraseBias` and
 * `validateSamplingLogitBiasEntry` (the token-ID equivalent) both use. */
export function validateSamplingPhraseBiasEntry(
  phrase: unknown,
  weight: unknown,
  label: string
): SamplingPhraseBiasEntryV2 {
  const validPhrase = validateSamplingText(phrase, `${label}.phrase`, SAMPLING_PHRASE_BIAS_POLICY.maxPhraseScalars);
  const validWeight = validateSamplingNumber(weight, `${label}.weight`, {
    minimum: SAMPLING_PHRASE_BIAS_POLICY.minimum,
    maximum: SAMPLING_PHRASE_BIAS_POLICY.maximum,
    integer: true
  });
  return { phrase: validPhrase, weight: validWeight };
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
    stop: validateSamplingStopSequences(sampling.stop, `${label}.stop`),
    logitBias: validateSamplingLogitBias(sampling.logitBias, `${label}.logitBias`),
    bannedStrings: validateSamplingBannedStrings(sampling.bannedStrings, `${label}.bannedStrings`),
    phraseBias: validateSamplingPhraseBias(sampling.phraseBias, `${label}.phraseBias`)
  };
}

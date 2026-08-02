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
// to document very different ceilings for the logit_bias map:
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
//
// There is one cap, on one object: the *resolved* logit_bias the provider
// request actually sends, after phraseBias and bannedStrings are tokenized
// and merged with the raw numeric map (shared/sampling-capabilities.ts
// documents that merge). It is preset-aware because only KoboldCpp
// documents a number smaller than 1667's own operational ceiling; every
// other preset gets that same 200 headroom. Enforced unconditionally —
// server/provider-sampling.ts and server/settings-v2-sampling-validation.ts
// both run it even when phraseBias and bannedStrings are empty and the
// object is just the raw numeric map sorted, because a raw map alone can
// still carry more entries than a preset documents.
export const SAMPLING_RESOLVED_LOGIT_BIAS_POLICY = {
  maxEntries: 200
} as const;

export const SAMPLING_RESOLVED_LOGIT_BIAS_PRESET_OVERRIDES: Readonly<
  Partial<Record<SettingsPresetV2, number>>
> = {
  koboldcpp: 16
};

export function maxResolvedLogitBiasEntries(preset: SettingsPresetV2): number {
  return SAMPLING_RESOLVED_LOGIT_BIAS_PRESET_OVERRIDES[preset]
    ?? SAMPLING_RESOLVED_LOGIT_BIAS_POLICY.maxEntries;
}

// The JSON schema still needs a structural, preset-agnostic ceiling on the
// raw wire object — ajv has no way to see which preset a document targets.
// Reuses SAMPLING_RESOLVED_LOGIT_BIAS_POLICY.maxEntries as that ceiling
// rather than a second literal 200, but it is a cheap structural bound
// only: the resolved, preset-aware cap above is what actually protects a
// request, and it is checked separately even when this one is satisfied.
export const SAMPLING_LOGIT_BIAS_POLICY = {
  maxEntries: SAMPLING_RESOLVED_LOGIT_BIAS_POLICY.maxEntries,
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
 * token receives this same weight. The list length itself is rarely the
 * binding constraint — SAMPLING_RESOLVED_LOGIT_BIAS_POLICY almost always
 * binds first, since each entry expands to one or more resolved tokens. */
export const SAMPLING_PHRASE_BIAS_POLICY = {
  maxEntries: 256,
  maxPhraseScalars: 64,
  minimum: -100,
  maximum: 100
} as const;

/** Banned strings are a negative-bias shortcut (see the field comment on
 * `SamplingSettingsV2.bannedStrings`), not a native provider field — none of
 * the endpoints 1667 calls documents one (checked against the llama.cpp
 * server README, the KoboldCpp API doc, LM Studio, and Ollama — the same
 * sources cited in shared/sampling-capabilities.ts). Sizing mirrors
 * SAMPLING_PHRASE_BIAS_POLICY for the same reason: the resolved bound binds
 * before the list length does. */
export const SAMPLING_BANNED_STRINGS_POLICY = {
  maxEntries: 256,
  maxScalars: 64
} as const;

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
    const record = closedPhraseBiasEntryShape(entry, `${label}[${index}]`);
    const parsed = validateSamplingPhraseBiasEntry(record.phrase, record.weight, `${label}[${index}]`);
    if (seen.has(parsed.phrase)) {
      throw new SamplingValidationError(`${label} repeats ${JSON.stringify(parsed.phrase)}`);
    }
    seen.add(parsed.phrase);
    return parsed;
  });
}

const PHRASE_BIAS_ENTRY_KEYS: ReadonlySet<string> = new Set(["phrase", "weight"]);

/** The generated JSON schema declares PhraseBiasEntry with
 * `additionalProperties: false` (scripts/settings-v2-schema-definition.ts);
 * this decoder has to agree, or a document the schema rejects can still be
 * accepted here and silently lose the extra key on the next round trip. */
function closedPhraseBiasEntryShape(entry: unknown, label: string): Record<string, unknown> {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new SamplingValidationError(`${label} must be an object`);
  }
  const record = entry as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!PHRASE_BIAS_ENTRY_KEYS.has(key)) {
      throw new SamplingValidationError(`${label} contains unknown key: ${key}`);
    }
  }
  return record;
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

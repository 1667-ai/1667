import type { PromptBiasEncoding } from "../shared/sampling-capabilities.js";
import {
  maxResolvedLogitBiasEntries,
  SAMPLING_BANNED_STRINGS_POLICY,
  SAMPLING_LOGIT_BIAS_POLICY,
  SAMPLING_PHRASE_BIAS_POLICY
} from "../shared/sampling-validation-policy.js";
import type {
  SamplingSettingsV2,
  SettingsPresetV2
} from "../shared/settings-v2-types.js";
import { hasUnpairedSurrogate, unicodeScalarLength } from "../shared/unicode.js";
import { ServiceError } from "./errors.js";
import { tokenizePhraseTokenIds } from "./openai-prompt-tokenizer.js";

const PROMPT_BIAS_ENCODINGS: ReadonlySet<string> = new Set(["o200k_base", "cl100k_base"]);

export interface TokenizeSamplingPhraseInput {
  readonly phrase: string;
  readonly encoding: PromptBiasEncoding;
}

/** Validates the `tokenizeSamplingPhrase` worker method's input (a pure local
 * tokenization — see shared/worker-protocol.ts for why it still crosses the
 * worker boundary). The phrase bound matches the longer of
 * SAMPLING_PHRASE_BIAS_POLICY.maxPhraseScalars and
 * SAMPLING_BANNED_STRINGS_POLICY.maxScalars, since a caller resolving either
 * field type uses this same method. */
export function parseTokenizeSamplingPhraseInput(value: unknown): TokenizeSamplingPhraseInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError(400, "tokenizeSamplingPhrase input must be an object");
  }
  const record = value as Record<string, unknown>;
  const phrase = record.phrase;
  if (typeof phrase !== "string" || hasUnpairedSurrogate(phrase)) {
    throw new ServiceError(400, "phrase must be a well-formed string");
  }
  const maxScalars = Math.max(
    SAMPLING_PHRASE_BIAS_POLICY.maxPhraseScalars,
    SAMPLING_BANNED_STRINGS_POLICY.maxScalars
  );
  const scalarLength = unicodeScalarLength(phrase, maxScalars);
  if (scalarLength < 1 || scalarLength > maxScalars) {
    throw new ServiceError(400, `phrase must contain 1..${maxScalars} Unicode scalars`);
  }
  if (typeof record.encoding !== "string" || !PROMPT_BIAS_ENCODINGS.has(record.encoding)) {
    throw new ServiceError(400, "encoding must be o200k_base or cl100k_base");
  }
  return { phrase, encoding: record.encoding as PromptBiasEncoding };
}

export interface ResolvedPhraseTokens {
  readonly phrase: string;
  /** null means the WASM tokenizer failed to load, not that the phrase is empty. */
  readonly tokenIds: readonly number[] | null;
}

export interface ResolvedSamplingLogitBias {
  readonly logitBias: Readonly<Record<string, number>>;
  readonly phraseBias: readonly ResolvedPhraseTokens[];
  readonly bannedStrings: readonly ResolvedPhraseTokens[];
  readonly resolvedEntryCount: number;
}

/**
 * Tokenize phraseBias and bannedStrings and merge them with the raw numeric
 * logitBias map into one logit_bias object, for both the actual provider
 * request (server/provider-sampling.ts) and the editor's token-ID preview
 * (the tokenizeSamplingPhrase worker method).
 *
 * Merge order, least to most authoritative: phraseBias, then bannedStrings,
 * then the explicit numeric logitBias map. A later source overwrites an
 * earlier one's bias for the same token ID — bannedStrings intentionally
 * outranks phraseBias (a stronger "exclude this" signal), and an explicit
 * numeric logitBias entry always wins over anything derived from text,
 * because the writer typed that exact token ID. Banned strings only make a
 * string unlikely, never impossible — see the field comment on
 * `SamplingSettingsV2.bannedStrings` for why.
 *
 * Returns null when the tokenizer itself is unavailable (WASM failed to
 * load), which is systemic and not specific to any one phrase.
 */
export function resolveSamplingLogitBias(
  sampling: Pick<SamplingSettingsV2, "logitBias" | "phraseBias" | "bannedStrings">,
  encoding: PromptBiasEncoding
): ResolvedSamplingLogitBias | null {
  const merged: Record<string, number> = {};
  const phraseBias: ResolvedPhraseTokens[] = [];
  for (const entry of sampling.phraseBias) {
    const tokenIds = tokenizePhraseTokenIds(entry.phrase, encoding);
    phraseBias.push({ phrase: entry.phrase, tokenIds });
    if (tokenIds === null) return null;
    for (const id of tokenIds) merged[String(id)] = entry.weight;
  }
  const bannedStrings: ResolvedPhraseTokens[] = [];
  for (const phrase of sampling.bannedStrings) {
    const tokenIds = tokenizePhraseTokenIds(phrase, encoding);
    bannedStrings.push({ phrase, tokenIds });
    if (tokenIds === null) return null;
    for (const id of tokenIds) merged[String(id)] = SAMPLING_LOGIT_BIAS_POLICY.minimum;
  }
  for (const [token, weight] of Object.entries(sampling.logitBias)) merged[token] = weight;

  return {
    logitBias: merged,
    phraseBias,
    bannedStrings,
    resolvedEntryCount: Object.keys(merged).length
  };
}

/** The bound that actually protects a provider request — see
 * SAMPLING_RESOLVED_LOGIT_BIAS_POLICY in shared/sampling-validation-policy.ts. */
export function resolvedLogitBiasExceedsBound(
  resolvedEntryCount: number,
  preset: SettingsPresetV2
): boolean {
  return resolvedEntryCount > maxResolvedLogitBiasEntries(preset);
}

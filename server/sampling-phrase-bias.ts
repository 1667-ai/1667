import {
  isPromptBiasEncoding,
  type PromptBiasEncoding,
  type ResolvedPhraseTokens,
  type SamplingBiasResolutionResult
} from "../shared/sampling-capabilities.js";
import {
  SAMPLING_BANNED_STRINGS_POLICY,
  SAMPLING_LOGIT_BIAS_POLICY,
  SAMPLING_PHRASE_BIAS_POLICY
} from "../shared/sampling-validation-policy.js";
import type { SamplingKnobV2, SamplingSettingsV2 } from "../shared/settings-v2-types.js";
import { hasUnpairedSurrogate, unicodeScalarLength } from "../shared/unicode.js";
import { ServiceError } from "./errors.js";
import { tokenizePhraseTokenIds } from "./openai-prompt-tokenizer.js";

export function isLogitBiasMergeKnob(
  knob: SamplingKnobV2
): knob is "logitBias" | "phraseBias" | "bannedStrings" {
  return knob === "logitBias" || knob === "phraseBias" || knob === "bannedStrings";
}

/**
 * Tokenize phraseBias and bannedStrings and merge them with the raw numeric
 * logitBias map into one logit_bias object — the one computation shared by
 * the actual provider request (server/provider-sampling.ts), save-time
 * validation (server/settings-v2-sampling-validation.ts), and the editor's
 * token-ID preview (the resolveSamplingBias worker method). Always run this
 * when any of the three knobs is configured, even when phraseBias and
 * bannedStrings are both empty: a raw numeric logitBias map alone can still
 * carry more entries than a preset documents, and the resolved-size bound
 * (shared/sampling-validation-policy.ts) is preset-aware in a way the JSON
 * schema's structural cap cannot be.
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
 * `encoding` is null when the routed model has no exact tokenizer
 * (`promptBiasTokenizerEncoding` in shared/sampling-capabilities.ts). That
 * is only a problem when phraseBias or bannedStrings actually need
 * tokenizing — availability gating (resolveSamplingKnob) already refuses to
 * reach here with either non-empty and no encoding, so a null encoding with
 * empty lists still resolves successfully: the loops below never run.
 */
export function resolveSamplingLogitBias(
  sampling: Pick<SamplingSettingsV2, "logitBias" | "phraseBias" | "bannedStrings">,
  encoding: PromptBiasEncoding | null
): SamplingBiasResolutionResult {
  const merged: Record<string, number> = {};
  const phraseBias: ResolvedPhraseTokens[] = [];
  for (const entry of sampling.phraseBias) {
    const outcome = tokenize(entry.phrase, encoding);
    if (outcome.kind !== "resolved") return outcome;
    phraseBias.push({ phrase: entry.phrase, tokenIds: outcome.tokenIds });
    for (const id of outcome.tokenIds) merged[String(id)] = entry.weight;
  }
  const bannedStrings: ResolvedPhraseTokens[] = [];
  for (const phrase of sampling.bannedStrings) {
    const outcome = tokenize(phrase, encoding);
    if (outcome.kind !== "resolved") return outcome;
    bannedStrings.push({ phrase, tokenIds: outcome.tokenIds });
    for (const id of outcome.tokenIds) merged[String(id)] = SAMPLING_LOGIT_BIAS_POLICY.minimum;
  }
  for (const [token, weight] of Object.entries(sampling.logitBias)) merged[token] = weight;

  return {
    kind: "resolved",
    logitBias: merged,
    phraseBias,
    bannedStrings,
    resolvedEntryCount: Object.keys(merged).length
  };
}

function tokenize(
  phrase: string,
  encoding: PromptBiasEncoding | null
): ReturnType<typeof tokenizePhraseTokenIds> {
  if (encoding === null) return { kind: "tokenizer-unavailable" };
  return tokenizePhraseTokenIds(phrase, encoding);
}

/** Converts a resolution failure into the phrase-unencodable/tokenizer
 * -unavailable message a caller shows a writer. Only called for the two
 * failure variants — a "resolved" result has nothing to report. */
export function samplingBiasResolutionFailureMessage(
  result: Extract<SamplingBiasResolutionResult, { kind: "tokenizer-unavailable" | "phrase-unencodable" }>
): string {
  return result.kind === "tokenizer-unavailable"
    ? "the tokenizer needed to resolve phrase bias or banned strings is unavailable"
    : `the phrase ${JSON.stringify(result.phrase)} could not be tokenized`;
}

export interface ResolveSamplingBiasInput {
  readonly logitBias: Readonly<Record<string, number>>;
  readonly phraseBias: readonly { readonly phrase: string; readonly weight: number }[];
  readonly bannedStrings: readonly string[];
  readonly encoding: PromptBiasEncoding;
}

const MAX_PHRASE_SCALARS = Math.max(
  SAMPLING_PHRASE_BIAS_POLICY.maxPhraseScalars,
  SAMPLING_BANNED_STRINGS_POLICY.maxScalars
);

/** Validates the `resolveSamplingBias` worker method's input (a pure local
 * tokenization — see shared/worker-protocol.ts for why it still crosses the
 * worker boundary). Structural bounds only, matching the shared validation
 * policy's own list and phrase-length caps — this is the editor's preview
 * path, not the save-time boundary, so it stays permissive about content it
 * cannot fully validate without the rest of the sampling document (e.g.
 * duplicate phrases), leaving that to save-time validation. */
export function parseResolveSamplingBiasInput(value: unknown): ResolveSamplingBiasInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError(400, "resolveSamplingBias input must be an object");
  }
  const record = value as Record<string, unknown>;
  if (!isPromptBiasEncoding(record.encoding)) {
    throw new ServiceError(400, "encoding must be a supported tokenizer encoding");
  }
  return {
    logitBias: parseLogitBiasField(record.logitBias),
    phraseBias: parsePhraseBiasField(record.phraseBias),
    bannedStrings: parseBannedStringsField(record.bannedStrings),
    encoding: record.encoding
  };
}

function parseLogitBiasField(value: unknown): Readonly<Record<string, number>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError(400, "logitBias must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const weight of Object.values(record)) {
    if (typeof weight !== "number" || !Number.isFinite(weight)) {
      throw new ServiceError(400, "logitBias values must be finite numbers");
    }
  }
  return record as Readonly<Record<string, number>>;
}

function parsePhraseBiasField(
  value: unknown
): readonly { readonly phrase: string; readonly weight: number }[] {
  if (!Array.isArray(value) || value.length > SAMPLING_PHRASE_BIAS_POLICY.maxEntries) {
    throw new ServiceError(400, "phraseBias must be a bounded array");
  }
  return value.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ServiceError(400, "phraseBias entries must be objects");
    }
    const record = entry as Record<string, unknown>;
    const weight = record.weight;
    if (typeof weight !== "number" || !Number.isFinite(weight)) {
      throw new ServiceError(400, "phraseBias.weight must be a finite number");
    }
    return { phrase: boundedPhrase(record.phrase), weight };
  });
}

function parseBannedStringsField(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > SAMPLING_BANNED_STRINGS_POLICY.maxEntries) {
    throw new ServiceError(400, "bannedStrings must be a bounded array");
  }
  return value.map((phrase) => boundedPhrase(phrase));
}

function boundedPhrase(phrase: unknown): string {
  if (typeof phrase !== "string" || hasUnpairedSurrogate(phrase)) {
    throw new ServiceError(400, "phrase must be a well-formed string");
  }
  const scalarLength = unicodeScalarLength(phrase, MAX_PHRASE_SCALARS);
  if (scalarLength < 1 || scalarLength > MAX_PHRASE_SCALARS) {
    throw new ServiceError(400, `phrase must contain 1..${MAX_PHRASE_SCALARS} Unicode scalars`);
  }
  return phrase;
}

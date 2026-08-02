import {
  isLogitBiasFamilyKnob,
  promptBiasTokenizerEncoding,
  samplingBiasVariantText,
  SAMPLING_BIAS_VARIANT_VALUES,
  type PromptBiasEncoding,
  type SamplingBiasEntryResolution,
  type SamplingBiasResolutionResult,
  type SamplingBiasVariantOutcome,
  type SamplingBiasVariantResolution
} from "../shared/sampling-capabilities.js";
import {
  SAMPLING_BANNED_STRINGS_POLICY,
  SAMPLING_LOGIT_BIAS_POLICY,
  SAMPLING_PHRASE_BIAS_POLICY
} from "../shared/sampling-validation-policy.js";
import type { SamplingSettingsV2 } from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";
import { hasUnpairedSurrogate, unicodeScalarLength } from "../shared/unicode.js";
import { ServiceError } from "./errors.js";
import { tokenizePhraseTokenIds } from "./openai-prompt-tokenizer.js";
import { probeLlamaCppTokenize } from "./context-probe.js";
import { providerRuntimeFor } from "./provider-runtime.js";

export { isLogitBiasFamilyKnob as isLogitBiasMergeKnob };

/** Resolves one surface variant's text to a token-count outcome. Always
 * synchronous: the two real sources (the local WASM tiktoken encoder, and a
 * pre-fetched map of a llama.cpp tokenize probe's results — see
 * `resolveSamplingBiasForSettings` below) both have their answer in hand by
 * the time this runs. Keeping the core resolution algorithm synchronous is
 * deliberate: it is also the fast path settings save-time validation calls
 * directly (server/settings-v2-sampling-validation.ts), and that call site
 * must never become async — see its own comment for why. */
type SyncVariantTokenizer = (text: string) => SamplingBiasVariantOutcome;

/**
 * Tokenize phraseBias and bannedStrings and merge them with the raw numeric
 * logitBias map into one logit_bias object — the one computation shared by
 * the actual provider request (server/provider-sampling.ts), save-time
 * validation (server/settings-v2-sampling-validation.ts), and the editor's
 * token-ID preview (the resolveSamplingBias worker method), so the request
 * and the editor can never compute different token IDs for the same draft.
 *
 * Each entry expands to four surface variants (typed, leading-space,
 * capitalized, leading-space-capitalized — shared/sampling-capabilities.ts)
 * and only counts as resolved when every variant is exactly one token: a
 * multi-token variant is never approximated by biasing each of its tokens,
 * because that would also bias every other context those tokens appear in.
 * An entry that fails is "rejected", not dropped — see
 * SamplingBiasEntryResolution — so the editor can show the writer why.
 *
 * Merge order, least to most authoritative: phraseBias, then bannedStrings,
 * then the explicit numeric logitBias map. A later source overwrites an
 * earlier one's bias for the same token ID — bannedStrings intentionally
 * outranks phraseBias (a stronger "exclude this" signal), and an explicit
 * numeric logitBias entry always wins over anything derived from text,
 * because the writer typed that exact token ID. Only resolved entries
 * contribute — a rejected entry biases nothing, silently or otherwise.
 * Banned strings only make a string unlikely, never impossible — see the
 * field comment on `SamplingSettingsV2.bannedStrings` for why.
 */
export function resolveSamplingLogitBias(
  sampling: Pick<SamplingSettingsV2, "logitBias" | "phraseBias" | "bannedStrings">,
  tokenizeVariant: SyncVariantTokenizer
): SamplingBiasResolutionResult {
  const merged: Record<string, number> = {};
  const phraseBias = sampling.phraseBias.map((entry) => {
    const resolution = resolveEntry(entry.phrase, tokenizeVariant);
    if (resolution.kind === "resolved") {
      for (const id of resolution.tokenIds) merged[String(id)] = entry.weight;
    }
    return resolution;
  });
  const bannedStrings = sampling.bannedStrings.map((phrase) => {
    const resolution = resolveEntry(phrase, tokenizeVariant);
    if (resolution.kind === "resolved") {
      for (const id of resolution.tokenIds) merged[String(id)] = SAMPLING_LOGIT_BIAS_POLICY.minimum;
    }
    return resolution;
  });
  for (const [token, weight] of Object.entries(sampling.logitBias)) merged[token] = weight;

  return {
    kind: "resolved",
    logitBias: merged,
    phraseBias,
    bannedStrings,
    resolvedEntryCount: Object.keys(merged).length
  };
}

function resolveEntry(
  phrase: string,
  tokenizeVariant: SyncVariantTokenizer
): SamplingBiasEntryResolution {
  // A phrase that already starts with a capital and needs no leading space
  // can make two or more variants share the same text (e.g. "Hello" typed:
  // "typed" and "capitalized" are both "Hello"). Tokenize each distinct
  // text once and reuse the outcome for every variant that shares it.
  const outcomeByText = new Map<string, SamplingBiasVariantOutcome>();
  const variants: SamplingBiasVariantResolution[] = SAMPLING_BIAS_VARIANT_VALUES.map((variant) => {
    const text = samplingBiasVariantText(phrase, variant);
    let outcome = outcomeByText.get(text);
    if (outcome === undefined) {
      outcome = tokenizeVariant(text);
      outcomeByText.set(text, outcome);
    }
    return { variant, text, outcome };
  });
  if (variants.every((entry) => entry.outcome.kind === "single-token")) {
    const tokenIds = [...new Set(
      variants.map((entry) => (entry.outcome as { kind: "single-token"; tokenId: number }).tokenId)
    )];
    return { kind: "resolved", phrase, variants, tokenIds };
  }
  return { kind: "rejected", phrase, variants };
}

/** The tiktoken-backed tokenizer for the "openai" preset — the only preset
 * whose reported model ID is trustworthy enough to key the tiktoken
 * allow-list (shared/sampling-capabilities.ts). Synchronous: the WASM
 * encoder never leaves the process. */
function openAiVariantTokenizer(encoding: PromptBiasEncoding): SyncVariantTokenizer {
  return (text) => {
    const outcome = tokenizePhraseTokenIds(text, encoding);
    if (outcome.kind === "resolved") {
      return outcome.tokenIds.length === 1
        ? { kind: "single-token", tokenId: outcome.tokenIds[0]! }
        : { kind: "multi-token", tokenIds: outcome.tokenIds };
    }
    return { kind: "unencodable" };
  };
}

/** Resolves phraseBias/bannedStrings using the local tiktoken encoder only —
 * the synchronous path settings save-time validation calls directly
 * (server/settings-v2-sampling-validation.ts). `encoding` is null when the
 * routed model has no exact tokenizer (`promptBiasTokenizerEncoding`); that
 * is only a problem when phraseBias or bannedStrings is actually non-empty —
 * availability gating (resolveSamplingKnob) already refuses to reach here
 * otherwise, but an empty pair of lists still resolves cleanly on a raw
 * logitBias map alone. */
export function resolveSamplingLogitBiasForEncoding(
  sampling: Pick<SamplingSettingsV2, "logitBias" | "phraseBias" | "bannedStrings">,
  encoding: PromptBiasEncoding | null
): SamplingBiasResolutionResult {
  if (encoding === null) {
    if (sampling.phraseBias.length === 0 && sampling.bannedStrings.length === 0) {
      return resolveSamplingLogitBias(sampling, neverCalledTokenizer);
    }
    return { kind: "tokenizer-unavailable" };
  }
  return resolveSamplingLogitBias(sampling, openAiVariantTokenizer(encoding));
}

function neverCalledTokenizer(): SamplingBiasVariantOutcome {
  throw new Error("tokenizeVariant called with no configured phraseBias or bannedStrings");
}

/**
 * Resolves phraseBias/bannedStrings for a concrete routed connection,
 * choosing the right tokenizer strategy for its preset — the one entry
 * point request-time application (server/provider-sampling.ts) and the
 * editor's live preview (the resolveSamplingBias worker method) both call,
 * so they can never disagree about what a draft resolves to.
 *
 * "openai" resolves locally against the tiktoken allow-list, synchronously
 * fast. "llama-cpp" has no such allow-list to trust (server/context-probe.ts,
 * probeLlamaCppTokenize) — instead every distinct surface-variant text the
 * draft needs is tokenized by asking that server directly, once each, before
 * the (still synchronous) merge runs. Every other preset has no tokenizer
 * strategy at all: "tokenizer-unavailable" whenever phraseBias or
 * bannedStrings is non-empty, matching what resolveSamplingKnob already
 * reports as unavailable for those presets ahead of reaching here.
 */
export async function resolveSamplingBiasForSettings(
  sampling: Pick<SamplingSettingsV2, "logitBias" | "phraseBias" | "bannedStrings">,
  settings: GenerationSettings,
  signal?: AbortSignal
): Promise<SamplingBiasResolutionResult> {
  const needsTokenizer = sampling.phraseBias.length > 0 || sampling.bannedStrings.length > 0;
  if (settings.provider !== "openai-compatible") {
    return needsTokenizer
      ? { kind: "tokenizer-unavailable" }
      : resolveSamplingLogitBias(sampling, neverCalledTokenizer);
  }
  const runtime = providerRuntimeFor(settings);
  if (runtime.preset === "openai") {
    return resolveSamplingLogitBiasForEncoding(sampling, promptBiasTokenizerEncoding(settings.model));
  }
  if (runtime.preset === "llama-cpp") {
    if (!needsTokenizer) return resolveSamplingLogitBias(sampling, neverCalledTokenizer);
    const tokenizer = await llamaCppVariantTokenizer(sampling, settings, signal);
    return tokenizer === null
      ? { kind: "tokenizer-unavailable" }
      : resolveSamplingLogitBias(sampling, tokenizer);
  }
  return needsTokenizer
    ? { kind: "tokenizer-unavailable" }
    : resolveSamplingLogitBias(sampling, neverCalledTokenizer);
}

/** A local server answering a handful of small POSTs in parallel is normal;
 * an unbounded burst against it (a full 256-entry list times four variants)
 * is not a request 1667 should make in one breath. */
const LLAMA_CPP_TOKENIZE_CONCURRENCY = 8;

/** Pre-fetches every distinct surface-variant text the draft needs from the
 * llama.cpp server's own /tokenize endpoint, then returns a plain
 * synchronous lookup over the results — reusing the exact same merge/reject
 * core (resolveSamplingLogitBias) the local-tokenizer path uses. Returns
 * null when any probe call fails outright: a network or server failure is
 * systemic (the tokenizer is unavailable), not a fact about any one phrase,
 * the same distinction the local WASM tokenizer's load failure already
 * draws. */
async function llamaCppVariantTokenizer(
  sampling: Pick<SamplingSettingsV2, "phraseBias" | "bannedStrings">,
  settings: GenerationSettings,
  signal?: AbortSignal
): Promise<SyncVariantTokenizer | null> {
  const texts = new Set<string>();
  for (const entry of sampling.phraseBias) {
    for (const variant of SAMPLING_BIAS_VARIANT_VALUES) texts.add(samplingBiasVariantText(entry.phrase, variant));
  }
  for (const phrase of sampling.bannedStrings) {
    for (const variant of SAMPLING_BIAS_VARIANT_VALUES) texts.add(samplingBiasVariantText(phrase, variant));
  }
  const queue = [...texts];
  const outcomes = new Map<string, SamplingBiasVariantOutcome>();
  let failed = false;
  async function worker(): Promise<void> {
    for (;;) {
      const text = queue.pop();
      if (text === undefined || failed) return;
      const tokenIds = await probeLlamaCppTokenize(settings, text, signal);
      if (tokenIds === null) {
        failed = true;
        return;
      }
      outcomes.set(
        text,
        tokenIds.length === 1
          ? { kind: "single-token", tokenId: tokenIds[0]! }
          : { kind: "multi-token", tokenIds }
      );
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(LLAMA_CPP_TOKENIZE_CONCURRENCY, queue.length) }, worker)
  );
  if (failed) return null;
  return (text) => outcomes.get(text) ?? { kind: "unencodable" };
}

export interface ResolveSamplingBiasInput {
  readonly logitBias: Readonly<Record<string, number>>;
  readonly phraseBias: readonly { readonly phrase: string; readonly weight: number }[];
  readonly bannedStrings: readonly string[];
}

const MAX_PHRASE_SCALARS = Math.max(
  SAMPLING_PHRASE_BIAS_POLICY.maxPhraseScalars,
  SAMPLING_BANNED_STRINGS_POLICY.maxScalars
);

/** Validates the `resolveSamplingBias` worker method's phraseBias/
 * bannedStrings/logitBias input (its `settings` field is a separate
 * provider-probe target, parsed and resolved by the caller — see
 * server/story-service.ts). Structural bounds only, matching the shared
 * validation policy's own list and phrase-length caps — this is the
 * editor's preview path, not the save-time boundary, so it stays permissive
 * about content it cannot fully validate without the rest of the sampling
 * document (e.g. duplicate phrases), leaving that to save-time validation. */
export function parseResolveSamplingBiasInput(value: unknown): ResolveSamplingBiasInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError(400, "resolveSamplingBias input must be an object");
  }
  const record = value as Record<string, unknown>;
  return {
    logitBias: parseLogitBiasField(record.logitBias),
    phraseBias: parsePhraseBiasField(record.phraseBias),
    bannedStrings: parseBannedStringsField(record.bannedStrings)
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

import type { SamplingKnobV2 } from "./settings-v2-types.js";

/**
 * Resolving text to token IDs for phraseBias and bannedStrings — split out
 * of shared/sampling-capabilities.ts to keep that file under the
 * repository's file-size guideline. That file answers "is this knob
 * available for this route"; this one answers "what does this text resolve
 * to, and under what tokenizer authority."
 */

/**
 * Tokenizer encodings 1667 can resolve a text phrase against. tiktoken ships
 * several named encodings; these are the two relevant to the OpenAI model
 * families 1667 routes to. Closed, `as const`-derived list (not a
 * hand-written union) so a new encoding is added in exactly one place and a
 * caller that only checks a hand-written type can't silently drift from it.
 */
export const PROMPT_BIAS_ENCODING_VALUES = ["o200k_base", "cl100k_base"] as const;
export type PromptBiasEncoding = (typeof PROMPT_BIAS_ENCODING_VALUES)[number];

export function isPromptBiasEncoding(value: unknown): value is PromptBiasEncoding {
  return typeof value === "string"
    && (PROMPT_BIAS_ENCODING_VALUES as readonly string[]).includes(value);
}

// The authoritative source for which encoding an OpenAI model uses is
// tiktoken's own table: https://github.com/openai/tiktoken/blob/main/tiktoken/model.py
// (MODEL_TO_ENCODING / MODEL_PREFIX_TO_ENCODING, fetched from the main
// branch). Kept here as a closed allow-list of exact model IDs rather than a
// prefix match: an unlisted model resolves to "no exact tokenizer" instead of
// a guessed encoding, because a wrong token ID would silently bias the wrong
// token. Dated snapshot IDs (e.g. "gpt-4o-2024-08-06") are intentionally
// omitted until individually confirmed against that table; add them as
// needed rather than guessing. "gpt-5.1" and "gpt-5.2" are omitted for the
// same reason — tiktoken's prefix match only covers "gpt-5-", which does not
// match a dotted point release, and no exact entry for them exists yet.
const OPENAI_PROMPT_BIAS_ENCODING: ReadonlyMap<string, PromptBiasEncoding> = new Map([
  ["gpt-4o", "o200k_base"],
  ["gpt-4o-mini", "o200k_base"],
  ["chatgpt-4o-latest", "o200k_base"],
  ["gpt-4.1", "o200k_base"],
  ["gpt-4.1-mini", "o200k_base"],
  ["gpt-4.1-nano", "o200k_base"],
  ["gpt-4.5-preview", "o200k_base"],
  ["gpt-5", "o200k_base"],
  ["gpt-5-mini", "o200k_base"],
  ["gpt-5-nano", "o200k_base"],
  ["o1", "o200k_base"],
  ["o1-mini", "o200k_base"],
  ["o1-preview", "o200k_base"],
  ["o3", "o200k_base"],
  ["o3-mini", "o200k_base"],
  ["o4-mini", "o200k_base"],
  ["gpt-4", "cl100k_base"],
  ["gpt-4-turbo", "cl100k_base"],
  ["gpt-4-32k", "cl100k_base"],
  ["gpt-3.5-turbo", "cl100k_base"],
  ["gpt-3.5-turbo-16k", "cl100k_base"]
]);

/** The exact tokenizer encoding for a routed model, or null when it is not on
 * the closed allow-list above. Resolution logic (shared/sampling-capabilities.ts)
 * turns null into the "no-exact-tokenizer" unavailable reason rather than
 * guessing. */
export function promptBiasTokenizerEncoding(remoteModelId: string): PromptBiasEncoding | null {
  return OPENAI_PROMPT_BIAS_ENCODING.get(remoteModelId) ?? null;
}

// OpenAI's reasoning-family models reject `logit_bias` outright — a 400, not
// a partial application. OpenAI's own current API reference
// (https://platform.openai.com/docs/api-reference/chat/create) flags
// `max_tokens` and `stop` by name for reasoning models but does not call out
// `logit_bias` there specifically. Microsoft's Azure OpenAI docs, which
// mirror OpenAI's own model capabilities, do state it explicitly:
// "The following are currently unsupported with reasoning models:
// `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`,
// `logprobs`, `top_logprobs`, `logit_bias`, `max_tokens`"
// (https://github.com/MicrosoftDocs/azure-ai-docs/blob/main/articles/foundry/openai/how-to/reasoning.md).
// That matches real-world 400s reported against OpenAI's own API for other
// reasoning-only-unsupported parameters. Closed allow-list of exact model
// IDs, the reasoning-family subset of OPENAI_PROMPT_BIAS_ENCODING above —
// this gates logitBias too, not only phraseBias/bannedStrings, because a raw
// token ID hits the same wire field and the same rejection.
export const OPENAI_REASONING_FAMILY_MODELS: ReadonlySet<string> = new Set([
  "o1", "o1-mini", "o1-preview", "o3", "o3-mini", "o4-mini",
  "gpt-5", "gpt-5-mini", "gpt-5-nano"
]);

/** True for the three knobs that ride the same `logit_bias` wire field
 * (server/provider-sampling.ts merges them into one object) — exported so
 * server/sampling-phrase-bias.ts does not keep a second copy of this list. */
export function isLogitBiasFamilyKnob(
  knob: SamplingKnobV2
): knob is "logitBias" | "phraseBias" | "bannedStrings" {
  return knob === "logitBias" || knob === "phraseBias" || knob === "bannedStrings";
}

/** A single surface form 1667 resolves a phrase or banned string against.
 * Writers type the bare word, but a model's tokenizer often assigns a
 * different token to the same word with a leading space (mid-sentence) or a
 * capital letter (sentence-initial) — biasing only the typed form misses
 * every other place the word actually appears. */
export const SAMPLING_BIAS_VARIANT_VALUES = [
  "typed",
  "leading-space",
  "capitalized",
  "leading-space-capitalized"
] as const;
export type SamplingBiasVariant = (typeof SAMPLING_BIAS_VARIANT_VALUES)[number];

const SAMPLING_BIAS_VARIANT_LABELS: Readonly<Record<SamplingBiasVariant, string>> = {
  typed: "as typed",
  "leading-space": "with a leading space",
  capitalized: "capitalized",
  "leading-space-capitalized": "capitalized with a leading space"
};

export function samplingBiasVariantLabel(variant: SamplingBiasVariant): string {
  return SAMPLING_BIAS_VARIANT_LABELS[variant];
}

/** The literal text 1667 tokenizes for one surface variant of `phrase`. */
export function samplingBiasVariantText(phrase: string, variant: SamplingBiasVariant): string {
  switch (variant) {
    case "typed": return phrase;
    case "leading-space": return ` ${phrase}`;
    case "capitalized": return capitalizeFirstScalar(phrase);
    case "leading-space-capitalized": return ` ${capitalizeFirstScalar(phrase)}`;
  }
}

/** Capitalizes the first Unicode scalar only — `phrase.slice(0, 1)` would cut
 * a surrogate pair in half for a phrase that starts outside the BMP. */
function capitalizeFirstScalar(phrase: string): string {
  const first = [...phrase][0];
  if (first === undefined) return phrase;
  return first.toLocaleUpperCase() + phrase.slice(first.length);
}

/** What tokenizing one surface variant found. "single-token" is the only
 * outcome 1667 ever biases — see the field comment on
 * SamplingPhraseBiasEntryV2 for why a multi-token phrase is rejected rather
 * than approximated by biasing each of its tokens individually. */
export type SamplingBiasVariantOutcome =
  | { readonly kind: "single-token"; readonly tokenId: number }
  | { readonly kind: "multi-token"; readonly tokenIds: readonly number[] }
  | { readonly kind: "unencodable" };

export interface SamplingBiasVariantResolution {
  readonly variant: SamplingBiasVariant;
  readonly text: string;
  readonly outcome: SamplingBiasVariantOutcome;
}

/** One phraseBias or bannedStrings entry, resolved against all four surface
 * variants. "resolved" only when every variant is single-token — a phrase
 * counts as usable exactly when 1667 can honestly bias every form the writer
 * means, never a subset. `variants` is always populated on every outcome, so
 * the editor can show the per-variant breakdown either way (issue #282,
 * stage 1: "the editor must show the resolved IDs per variant, not one list
 * per phrase").
 *
 * "shadowed" is the third outcome (issue #282 review round 2, finding 1):
 * every variant tokenized to exactly one token, the same bar "resolved"
 * clears, but every one of those tokens is already owned by a
 * higher-priority entry (server/sampling-phrase-bias.ts documents merge
 * priority) — so this entry's own weight would never actually reach the
 * wire. Naming the entry that took its tokens is what tells a writer their
 * two entries are not the independent pair they look like. */
export type SamplingBiasEntryResolution =
  | {
      readonly kind: "resolved";
      readonly phrase: string;
      readonly variants: readonly SamplingBiasVariantResolution[];
      readonly tokenIds: readonly number[];
    }
  | {
      readonly kind: "rejected";
      readonly phrase: string;
      readonly variants: readonly SamplingBiasVariantResolution[];
    }
  | {
      readonly kind: "shadowed";
      readonly phrase: string;
      readonly variants: readonly SamplingBiasVariantResolution[];
      readonly tokenIds: readonly number[];
      readonly shadowedBy: {
        readonly source: "phraseBias" | "bannedStrings";
        readonly phrase: string;
      };
    };

/** Why "tokenizer-unavailable" — three materially different situations a
 * writer must be able to tell apart (issue #282 review round 2, finding 6b):
 * - "encoder-unavailable": the bundled WASM tiktoken encoder itself failed
 *   to load, for a model that is otherwise on the allow-list.
 * - "model-unknown": there is no tokenizer strategy for this model or
 *   preset at all — not on the tiktoken allow-list, and no live-probe
 *   preset either.
 * - "probe-failed": a live-tokenize preset's own server (llama.cpp's
 *   POST /tokenize, server/context-probe.ts) did not answer — a network or
 *   server failure, not a fact about any phrase. */
export const TOKENIZER_UNAVAILABLE_CAUSE_VALUES = [
  "encoder-unavailable",
  "model-unknown",
  "probe-failed"
] as const;
export type TokenizerUnavailableCause = (typeof TOKENIZER_UNAVAILABLE_CAUSE_VALUES)[number];

/**
 * The result of tokenizing and merging phraseBias and bannedStrings — the
 * one computation shared by the actual provider request
 * (server/provider-sampling.ts), save-time validation
 * (server/settings-v2-sampling-validation.ts), and the editor's token-ID
 * preview (the resolveSamplingBias worker method), so the request and the
 * editor can never compute different token IDs for the same draft.
 *
 * "tokenizer-unavailable" means there is no way at all to resolve text to
 * token IDs for this route — systemic, not specific to any phrase; `cause`
 * says which systemic reason (see TokenizerUnavailableCause above). A single
 * unresolvable phrase is not systemic: it lands as a "rejected" entry inside
 * `phraseBias` or `bannedStrings` instead, alongside every entry that did
 * resolve, so one bad entry never hides the good ones.
 */
export type SamplingBiasResolutionResult =
  | {
      readonly kind: "resolved";
      readonly logitBias: Readonly<Record<string, number>>;
      readonly phraseBias: readonly SamplingBiasEntryResolution[];
      readonly bannedStrings: readonly SamplingBiasEntryResolution[];
      readonly resolvedEntryCount: number;
    }
  | { readonly kind: "tokenizer-unavailable"; readonly cause: TokenizerUnavailableCause };

/** True when every phraseBias/bannedStrings entry in `result` resolved — the
 * condition a caller that must never send a rejected entry checks before
 * trusting `logitBias` (server/provider-sampling.ts throws instead of
 * sending a partial request; the editor shows each rejection inline). A
 * "shadowed" entry (issue #282 review round 2, finding 1) does not count as
 * resolved either: its own weight never reaches `logitBias`. */
export function samplingBiasResolutionFullySucceeded(
  result: Extract<SamplingBiasResolutionResult, { kind: "resolved" }>
): boolean {
  return [...result.phraseBias, ...result.bannedStrings].every((entry) => entry.kind === "resolved");
}

const TOKENIZER_UNAVAILABLE_CAUSE_TEXT: Readonly<Record<TokenizerUnavailableCause, string>> = {
  "encoder-unavailable": "the bundled tokenizer failed to load",
  "model-unknown": "1667 has no exact tokenizer for this model",
  "probe-failed": "the llama.cpp tokenize probe did not answer"
};

export function samplingBiasResolutionFailureMessage(
  result: Extract<SamplingBiasResolutionResult, { kind: "tokenizer-unavailable" }>
): string {
  return TOKENIZER_UNAVAILABLE_CAUSE_TEXT[result.cause];
}

/** A short, honest reason a single entry was kept off the wire — either it
 * never resolved to one token per surface variant ("rejected"), or every
 * variant did but another, higher-priority entry already owns those tokens
 * ("shadowed" — issue #282 review round 2, finding 1). Never claims either
 * kind did something it did not. */
export function samplingBiasEntryRejectionMessage(
  entry: Exclude<SamplingBiasEntryResolution, { kind: "resolved" }>
): string {
  if (entry.kind === "shadowed") {
    const owner = entry.shadowedBy.source === "bannedStrings" ? "banned string" : "phrase bias";
    return `${JSON.stringify(entry.phrase)} shares every token with ${owner} `
      + `${JSON.stringify(entry.shadowedBy.phrase)}, which takes precedence`;
  }
  const failing = entry.variants.find((variant) => variant.outcome.kind !== "single-token");
  if (failing === undefined) {
    return `${JSON.stringify(entry.phrase)} could not be resolved to single tokens`;
  }
  const where = failing.variant === "typed" ? "" : ` (${samplingBiasVariantLabel(failing.variant)})`;
  if (failing.outcome.kind === "multi-token") {
    return `${JSON.stringify(failing.text)}${where} is ${failing.outcome.tokenIds.length} tokens `
      + `(${failing.outcome.tokenIds.join(",")}), not one`;
  }
  return `${JSON.stringify(failing.text)}${where} has no exact token`;
}

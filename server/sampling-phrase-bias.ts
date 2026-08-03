import {
  promptBiasTokenizerEncoding,
  samplingBiasVariantText,
  SAMPLING_BIAS_VARIANT_VALUES,
  type PromptBiasEncoding,
  type SamplingBiasEntryResolution,
  type SamplingBiasResolutionResult,
  type SamplingBiasShadowConflict,
  type SamplingBiasShadowOwner,
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
import { promptBiasEncoderAvailable, tokenizePhraseTokenIds } from "./openai-prompt-tokenizer.js";
import { probeLlamaCppTokenize } from "./context-probe.js";
import { providerRuntimeFor } from "./provider-runtime.js";

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
 * then the explicit numeric logitBias map. bannedStrings intentionally
 * outranks phraseBias (a stronger "exclude this" signal), and an explicit
 * numeric logitBias entry always wins over anything derived from text,
 * because the writer typed that exact token ID.
 *
 * Two entries can resolve to overlapping token IDs even though the writer
 * never named a token twice — variant expansion makes that unavoidable, not
 * exotic: every variant of "Hello" is also a variant of "hello". The merged
 * map below is built from every resolved entry unconditionally, in that
 * same priority order, a later write always overwriting an earlier one for
 * a shared token — nothing is ever left out of it because of what it later
 * turns out to share (issue #282 review round 3, findings 1 and 4: an
 * earlier version decided per-entry ownership in a separate pass, using a
 * comparison that did not agree with this merge order, which silently
 * dropped an earlier entry's *exclusive* tokens whenever it shared even one
 * token with a later entry — and separately let the numeric map override a
 * phrase without ever reporting it). Only afterward does
 * `settleTokenOwnership` classify each entry against this one already-built
 * map: "shadowed" only when the map disagrees with the entry about a token's
 * weight, never merely because another entry also names that token. Banned
 * strings only make a string unlikely, never impossible — see the field
 * comment on `SamplingSettingsV2.bannedStrings` for why.
 */
export function resolveSamplingLogitBias(
  sampling: Pick<SamplingSettingsV2, "logitBias" | "phraseBias" | "bannedStrings">,
  tokenizeVariant: SyncVariantTokenizer
): SamplingBiasResolutionResult {
  const phraseResolutions = sampling.phraseBias.map((entry) => resolveEntry(entry.phrase, tokenizeVariant));
  const bannedResolutions = sampling.bannedStrings.map((phrase) => resolveEntry(phrase, tokenizeVariant));

  // Built once, from every resolved entry, before any shadow is decided —
  // this object is both the wire value and the yardstick every entry below
  // is measured against. `tokenOwner` rides along only to *name* whichever
  // entry wrote a token's final weight, for the message; it plays no part in
  // deciding whether a shadow exists.
  const merged: Record<string, number> = {};
  const tokenOwner = new Map<number, SamplingBiasTokenOwner>();
  phraseResolutions.forEach((resolution, index) => {
    if (resolution.kind !== "resolved") return;
    const weight = sampling.phraseBias[index]!.weight;
    for (const id of resolution.tokenIds) {
      merged[String(id)] = weight;
      tokenOwner.set(id, { source: "phraseBias", index });
    }
  });
  bannedResolutions.forEach((resolution, index) => {
    if (resolution.kind !== "resolved") return;
    for (const id of resolution.tokenIds) {
      merged[String(id)] = SAMPLING_LOGIT_BIAS_POLICY.minimum;
      tokenOwner.set(id, { source: "bannedStrings", index });
    }
  });
  for (const [token, weight] of Object.entries(sampling.logitBias)) {
    merged[token] = weight;
    tokenOwner.set(Number(token), { source: "logitBias" });
  }

  const phraseBias = phraseResolutions.map((resolution, index) =>
    settleTokenOwnership(resolution, sampling.phraseBias[index]!.weight, merged, tokenOwner, sampling));
  const bannedStrings = bannedResolutions.map((resolution) =>
    settleTokenOwnership(resolution, SAMPLING_LOGIT_BIAS_POLICY.minimum, merged, tokenOwner, sampling));

  return {
    kind: "resolved",
    logitBias: merged,
    phraseBias,
    bannedStrings,
    resolvedEntryCount: Object.keys(merged).length
  };
}

type SamplingBiasTokenOwner =
  | { readonly source: "phraseBias" | "bannedStrings"; readonly index: number }
  | { readonly source: "logitBias" };

/** Downgrades a "resolved" entry to "shadowed" when the already-built merged
 * map disagrees with it about at least one of its own tokens — i.e. some
 * other entry's weight, not this one's, is what the map actually carries for
 * that token id. Two entries that both resolve to a shared token and both
 * write it the same weight never trigger this (issue #282 review round 3,
 * finding 1): there is no weight for either of them to lose, so a banned
 * string that overlaps an earlier banned string, or a phrase-bias entry that
 * happens to share a later entry's exact weight, stays "resolved" — the
 * outcome no longer depends on which of the two was typed first.
 * `rejected` entries pass through unchanged: they never held any tokens to
 * lose.
 *
 * Every one of `resolution.tokenIds` that lost is paired with the entry that
 * actually wrote its weight — a `SamplingBiasShadowConflict` per lost token,
 * not one `shadowedBy` for the whole entry (issue #282 review round 4,
 * finding 1): a shadow can split its lost tokens across two different
 * owners (one taken by an explicit numeric `logitBias` entry, another by a
 * different phrase), and picking only the first token's owner to represent
 * all of them blamed the wrong entry for the rest. */
function settleTokenOwnership(
  resolution: SamplingBiasEntryResolution,
  ownWeight: number,
  merged: Readonly<Record<string, number>>,
  tokenOwner: ReadonlyMap<number, SamplingBiasTokenOwner>,
  sampling: Pick<SamplingSettingsV2, "phraseBias" | "bannedStrings">
): SamplingBiasEntryResolution {
  if (resolution.kind !== "resolved") return resolution;
  const conflicts: SamplingBiasShadowConflict[] = [];
  for (const tokenId of resolution.tokenIds) {
    if (merged[String(tokenId)] === ownWeight) continue;
    conflicts.push({ tokenId, owner: shadowOwnerFor(tokenId, tokenOwner, sampling) });
  }
  if (conflicts.length === 0) return resolution;
  return {
    kind: "shadowed",
    phrase: resolution.phrase,
    variants: resolution.variants,
    tokenIds: resolution.tokenIds,
    conflicts
  };
}

/** Names the entry that owns `tokenId` in the already-built merged map. Every
 * token in a "resolved" entry's own `tokenIds` was written into `tokenOwner`
 * alongside `merged` in the same pass (`resolveSamplingLogitBias` above), so
 * a miss here is a real merge invariant violation, not a legitimate case to
 * paper over with a silent fallback owner. */
function shadowOwnerFor(
  tokenId: number,
  tokenOwner: ReadonlyMap<number, SamplingBiasTokenOwner>,
  sampling: Pick<SamplingSettingsV2, "phraseBias" | "bannedStrings">
): SamplingBiasShadowOwner {
  const owner = tokenOwner.get(tokenId);
  if (owner === undefined) {
    throw new Error(`sampling bias merge invariant violated: token ${tokenId} has no recorded owner`);
  }
  if (owner.source === "logitBias") return { source: "logitBias" };
  return {
    source: owner.source,
    phrase: owner.source === "phraseBias"
      ? sampling.phraseBias[owner.index]!.phrase
      : sampling.bannedStrings[owner.index]!
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
 * encoder never leaves the process. Callers only reach this once the encoder
 * is already known to have loaded (resolveSamplingLogitBiasForEncoding below
 * checks that first), so every failure this reports is a fact about the one
 * phrase being tokenized, never the tokenizer itself (issue #282 review
 * round 2, finding 6b) — that is what keeps the "unencodable" outcome here
 * honestly per-phrase. */
function openAiVariantTokenizer(encoding: PromptBiasEncoding): SyncVariantTokenizer {
  return (text) => {
    const tokenIds = tokenizePhraseTokenIds(text, encoding);
    if (tokenIds === null) return { kind: "unencodable" };
    return tokenIds.length === 1
      ? { kind: "single-token", tokenId: tokenIds[0]! }
      : { kind: "multi-token", tokenIds };
  };
}

/** Resolves phraseBias/bannedStrings using the local tiktoken encoder only —
 * the synchronous path settings save-time validation calls directly
 * (server/settings-v2-sampling-validation.ts). `encoding` is null when the
 * routed model has no exact tokenizer (`promptBiasTokenizerEncoding`); that
 * is only a problem when phraseBias or bannedStrings is actually non-empty —
 * availability gating (resolveSamplingKnob) already refuses to reach here
 * otherwise, but an empty pair of lists still resolves cleanly on a raw
 * logitBias map alone.
 *
 * Checks the encoder actually loaded *before* tokenizing anything (issue
 * #282 review round 2, finding 6b): `openAiVariantTokenizer` has no way to
 * report "the encoder itself failed to load" separately from "this one
 * phrase has no token" — its return type is a per-variant outcome, not a
 * systemic one — so without this check a load failure for a supported model
 * like gpt-4o would surface as every configured phrase being individually
 * rejected, which is false. */
export function resolveSamplingLogitBiasForEncoding(
  sampling: Pick<SamplingSettingsV2, "logitBias" | "phraseBias" | "bannedStrings">,
  encoding: PromptBiasEncoding | null
): SamplingBiasResolutionResult {
  const needsTokenizer = sampling.phraseBias.length > 0 || sampling.bannedStrings.length > 0;
  if (!needsTokenizer) return resolveSamplingLogitBias(sampling, neverCalledTokenizer);
  if (encoding === null) return { kind: "tokenizer-unavailable", cause: "model-unknown" };
  if (!promptBiasEncoderAvailable(encoding)) {
    return { kind: "tokenizer-unavailable", cause: "encoder-unavailable" };
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
 *
 * The "nothing to tokenize" guard is hoisted above every preset branch
 * (issue #282 review round 2, finding 7): a raw numeric logitBias map alone
 * never needs a tokenizer at all, on any preset, so that case is handled
 * once instead of once per branch.
 */
export async function resolveSamplingBiasForSettings(
  sampling: Pick<SamplingSettingsV2, "logitBias" | "phraseBias" | "bannedStrings">,
  settings: GenerationSettings,
  signal?: AbortSignal
): Promise<SamplingBiasResolutionResult> {
  const needsTokenizer = sampling.phraseBias.length > 0 || sampling.bannedStrings.length > 0;
  if (!needsTokenizer) return resolveSamplingLogitBias(sampling, neverCalledTokenizer);
  if (settings.provider !== "openai-compatible") {
    return { kind: "tokenizer-unavailable", cause: "model-unknown" };
  }
  const runtime = providerRuntimeFor(settings);
  if (runtime.preset === "openai") {
    return resolveSamplingLogitBiasForEncoding(sampling, promptBiasTokenizerEncoding(settings.model));
  }
  if (runtime.preset === "llama-cpp") {
    const tokenizer = await llamaCppVariantTokenizer(sampling, settings, signal);
    return tokenizer === null
      ? { kind: "tokenizer-unavailable", cause: "probe-failed" }
      : resolveSamplingLogitBias(sampling, tokenizer);
  }
  return { kind: "tokenizer-unavailable", cause: "model-unknown" };
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
  // Every text queued above was either recorded in `outcomes` or caused
  // `failed` to short-circuit the whole probe (returning null before this
  // point) — so by construction, a lookup miss here can only mean the
  // resolver asked for a variant text it never queued. That is a real bug,
  // not a legitimate "unencodable" phrase (issue #282 review round 2,
  // finding 7): throwing surfaces it instead of silently misreporting why a
  // phrase was rejected.
  return (text) => {
    const outcome = outcomes.get(text);
    if (outcome === undefined) {
      throw new Error(`llama.cpp tokenize probe never queued ${JSON.stringify(text)}`);
    }
    return outcome;
  };
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

import type { SamplingKnobV2, SettingsPresetV2 } from "./settings-v2-types.js";

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

/** Where a phraseBias or bannedStrings entry was configured: the vault-wide
 * generation profile, or the one story currently generating. Both scopes
 * feed the same merge (`resolveSamplingLogitBias`, server/sampling-phrase-
 * bias.ts) — a story value adds to the profile value rather than replacing
 * it (issue #341). Scope is what turns a real weight conflict into either a
 * blocking "shadowed" (same scope: today's #282 rule, unchanged) or a
 * non-blocking "overridden" (different scope: the story's whole reason to
 * exist — see the "overridden" case on SamplingBiasEntryResolution). */
export const SAMPLING_BIAS_SCOPE_VALUES = ["profile", "story"] as const;
export type SamplingBiasScope = (typeof SAMPLING_BIAS_SCOPE_VALUES)[number];

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
 * means, never a subset. `variants` is always populated on every outcome that
 * carries it, so the editor can show the per-variant breakdown either way
 * (issue #282, stage 1: "the editor must show the resolved IDs per variant,
 * not one list per phrase").
 *
 * KoboldCpp's native anti-slop bannedStrings (issue #311) is deliberately
 * not a member of this union — see `SamplingBiasNativeBannedStringResolution`
 * and `SamplingBiasResolutionResult.nativeBannedStrings` below. An earlier
 * version of this change added a fifth "native" `kind` here instead; a
 * structural review (issue #311, second pass) found that nothing then
 * stopped a "native" entry from being constructed, or read, on a preset
 * other than KoboldCpp — `bannedStrings`' wire field falls back to
 * `logit_bias` on every preset that has no override
 * (`PRESET_WIRE_OVERRIDES`, shared/sampling-capabilities.ts), so a "native"
 * entry reaching the wire on any of them would have overwritten the token
 * map one statement earlier with an array of literal strings. Carrying
 * native texts on their own field instead, filled only by the KoboldCpp
 * resolver, makes a native `phraseBias` entry unrepresentable and a native
 * `bannedStrings` entry on any other preset a type error, not a runtime
 * accident.
 *
 * "shadowed" is the third outcome, and it never fires from overlap alone.
 * Two entries can share a token — variant expansion makes that unavoidable,
 * since every variant of "Hello" is also a variant of "hello" — without any
 * conflict, when both would write that token the same weight; two banned
 * strings always agree this way, because every banned string writes the
 * same fixed minimum. "shadowed" fires only when at least one of this
 * entry's own tokens ends up, in the final merged map, carrying a weight
 * this entry did NOT write — some, not necessarily every, token (issue #282
 * review round 3, finding 1 corrected this from an earlier, wrong "every"
 * reading that also made the outcome depend on typing order).
 * `conflicts` names each of `tokenIds` that lost this entry's own weight
 * together with the entry that actually wrote it — a token and its owner
 * joined in one record, not two separately-indexed arrays (issue #282
 * review round 4, finding 1): an earlier shape kept a bare
 * `conflictingTokenIds: readonly number[]` beside a single `shadowedBy`
 * naming only the owner of the first one, so a shadow that split its lost
 * tokens across two different owners — one taken by an explicit numeric
 * `logitBias` entry, another by a different phrase — reported every lost
 * form under whichever owner happened to take the first token, blaming the
 * wrong entry for the rest. An explicit numeric `logitBias` entry always
 * wins a real conflict on the token it names, and carries no phrase text of
 * its own (`SamplingBiasShadowOwner`). A "shadowed" entry always blocks a
 * save and a request, the same as "rejected" (issue #282 review round 3,
 * finding 2): a writer who configured two conflicting entries is told,
 * never shipped a weaker request than the one they typed.
 *
 * "overridden" is the fourth outcome (issue #341): the same real weight
 * conflict as "shadowed", structurally, but between two different scopes
 * (`SamplingBiasScope`) rather than within one. A story saying "bias this
 * differently from my vault default" is not a mistake — it is the feature —
 * so it must never block a save or a request the way "shadowed" does, and
 * must never be reported as an error. `settleTokenOwnership` (server/
 * sampling-phrase-bias.ts) is the one place that decides "shadowed" versus
 * "overridden": the token's winning owner sharing this entry's own scope is
 * "shadowed" (today's #282 rule, unchanged); a different scope is
 * "overridden". */
export type SamplingBiasEntryResolution =
  | {
      readonly kind: "resolved";
      readonly phrase: string;
      readonly scope: SamplingBiasScope;
      readonly variants: readonly SamplingBiasVariantResolution[];
      readonly tokenIds: readonly number[];
    }
  | {
      readonly kind: "rejected";
      readonly phrase: string;
      readonly scope: SamplingBiasScope;
      readonly variants: readonly SamplingBiasVariantResolution[];
    }
  | {
      readonly kind: "shadowed";
      readonly phrase: string;
      readonly scope: SamplingBiasScope;
      readonly variants: readonly SamplingBiasVariantResolution[];
      readonly tokenIds: readonly number[];
      readonly conflicts: readonly SamplingBiasShadowConflict[];
    }
  | {
      readonly kind: "overridden";
      readonly phrase: string;
      readonly scope: SamplingBiasScope;
      readonly variants: readonly SamplingBiasVariantResolution[];
      readonly tokenIds: readonly number[];
      readonly conflicts: readonly SamplingBiasShadowConflict[];
    };

/**
 * A KoboldCpp bannedStrings entry that resolved through the native
 * `banned_tokens` transport (issue #311) instead of the token-ID merge every
 * other preset, and every other preset's own bannedStrings, uses. Never a
 * member of `SamplingBiasEntryResolution` — see that type's own comment for
 * why keeping it structurally separate is the point, not an organizational
 * preference.
 *
 * "native" ships as literal text, unconditionally — KoboldCpp's anti-slop
 * `banned_tokens` field takes the phrase itself and backtracks the generated
 * stream when it appears (field description quoted in
 * shared/sampling-capabilities.ts), so it needs no tokenizer and is never
 * rejected for being multi-token the way a token-ID bias would be.
 *
 * "blocked" (issue #311, second pass) is the one way a native banned string
 * still refuses: when its phrase, or any of its four surface variants,
 * textually matches a `phraseBias` phrase in the same scope — a writer who
 * configured a direct self-contradiction (boost "ember", ban "ember") is
 * refused on every other preset already, because the two entries fight over
 * the same resolved token there (`settleTokenOwnership` marks the phraseBias
 * entry "shadowed"). A native banned string never resolves a token to
 * compare, so it cannot reuse that token-ownership machinery honestly; this
 * checks the same contradiction the only way available to it — the literal
 * text both entries would act on — and blocks on it the same as "rejected"
 * or "shadowed" does for the other four (`firstBlockedNativeBannedString`).
 * `conflictingPhrase` names the phraseBias phrase it collided with, for the
 * message the caller builds around it (`samplingBiasNativeBlockedMessage`).
 */
export type SamplingBiasNativeBannedStringResolution =
  | { readonly kind: "native"; readonly phrase: string; readonly scope: SamplingBiasScope }
  | {
      readonly kind: "blocked";
      readonly phrase: string;
      readonly scope: SamplingBiasScope;
      readonly conflictingPhrase: string;
    };

/** Reads the way `resolveSamplingLogitBias` decides a preset's bannedStrings
 * transport (server/sampling-phrase-bias.ts) — a pure function of preset, so
 * every caller that has a preset in hand (a real request, save-time
 * validation, and the TUI's demo-mode preview alike, issue #311 review
 * finding C) computes the identical decision the shared merge itself acts
 * on, instead of each caller guessing or hard-coding "koboldcpp" by hand.
 * "token": every configured bannedStrings phrase is tokenized and merged
 * into `logit_bias`, exactly like phraseBias. "native": KoboldCpp only —
 * see `SamplingBiasNativeBannedStringResolution` above. */
export function bannedStringsTransportForPreset(
  preset: SettingsPresetV2 | "legacy-v1"
): "token" | "native" {
  return preset === "koboldcpp" ? "native" : "token";
}

/** One of a "shadowed" or "overridden" entry's own tokens, joined to the
 * entry that actually wrote its final weight — see
 * `SamplingBiasEntryResolution` for why this must be one record and not two
 * correlated arrays. */
export interface SamplingBiasShadowConflict {
  readonly tokenId: number;
  readonly owner: SamplingBiasShadowOwner;
}

/** Names the entry whose weight won a real conflict on at least one token
 * (`SamplingBiasEntryResolution`, "shadowed" or "overridden"). An explicit
 * numeric `logitBias` entry has no phrase text of its own — a raw token ID,
 * not text — so it is the one source with no `phrase` to report, and it is
 * always profile-scoped (`logitBias` is a profile-only field, issue #341). */
export type SamplingBiasShadowOwner =
  | {
      readonly source: "phraseBias" | "bannedStrings";
      readonly scope: SamplingBiasScope;
      readonly phrase: string;
    }
  | { readonly source: "logitBias" };

/** Why "tokenizer-unavailable" — three materially different situations a
 * writer must be able to tell apart (issue #282 review round 2, finding 6b):
 * - "encoder-unavailable": the bundled WASM tiktoken encoder itself failed
 *   to load, for a model that is otherwise on the allow-list.
 * - "model-unknown": there is no tokenizer strategy for this model or
 *   preset at all — not on the tiktoken allow-list, and no live-probe
 *   preset either.
 * - "probe-failed": a live-tokenize preset's own server (llama.cpp's
 *   POST /tokenize or KoboldCpp's POST /api/extra/tokencount,
 *   server/context-probe.ts — issue #311 added the second) did not answer —
 *   a network or server failure, not a fact about any phrase. Shared by both
 *   presets rather than split per preset (issue #282 review round 2, finding
 *   6b already settled this cause list as "materially different situations",
 *   not "one entry per preset"): the message text
 *   (TOKENIZER_UNAVAILABLE_CAUSE_TEXT below) names the transport generically
 *   for the same reason.
 * - "no-token-ids": the server answered, but its response carried no token
 *   IDs at all — it did not fail to answer, so blaming its network the way
 *   "probe-failed" does would be a different, false claim (issue #311 review,
 *   second pass, finding E). The known case is a KoboldCpp release old
 *   enough to answer `/api/extra/tokencount` with only `value`, never `ids`
 *   — `countKoboldCpp` (server/tokenize-probe.ts) already reasons about that
 *   same generation gap for prompt counting. Kept preset-neutral, like
 *   "probe-failed", in case a future live-tokenize preset shares the same
 *   old-build gap. */
export const TOKENIZER_UNAVAILABLE_CAUSE_VALUES = [
  "encoder-unavailable",
  "model-unknown",
  "probe-failed",
  "no-token-ids"
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
 *
 * `nativeBannedStrings` (issue #311, second pass) is empty on every route
 * but a KoboldCpp one with bannedStrings configured — `bannedStrings` itself
 * stays empty on exactly that route, since `resolveSamplingLogitBias`
 * (server/sampling-phrase-bias.ts) never tokenizes a native-transport entry
 * in the first place. See `bannedStringsTransportForPreset` and
 * `SamplingBiasNativeBannedStringResolution` above for why this is a
 * separate field rather than a fifth kind inside `bannedStrings`.
 */
export type SamplingBiasResolutionResult =
  | {
      readonly kind: "resolved";
      readonly logitBias: Readonly<Record<string, number>>;
      readonly phraseBias: readonly SamplingBiasEntryResolution[];
      readonly bannedStrings: readonly SamplingBiasEntryResolution[];
      readonly nativeBannedStrings: readonly SamplingBiasNativeBannedStringResolution[];
      readonly resolvedEntryCount: number;
    }
  | { readonly kind: "tokenizer-unavailable"; readonly cause: TokenizerUnavailableCause };

// "probe-failed" names the transport generically rather than a specific
// preset (issue #311): llama.cpp and KoboldCpp both reach this cause through
// their own live tokenize probe (see the comment on TokenizerUnavailableCause
// above), and naming one of the two by name here would misname the other's
// failure — a KoboldCpp server that did not answer is not a fact about
// llama.cpp.
const TOKENIZER_UNAVAILABLE_CAUSE_TEXT: Readonly<Record<TokenizerUnavailableCause, string>> = {
  "encoder-unavailable": "the bundled tokenizer failed to load",
  "model-unknown": "1667 has no exact tokenizer for this model",
  "probe-failed": "the live tokenize probe did not answer",
  "no-token-ids": "the live tokenize probe's server answered, but did not report token IDs"
};

export function samplingBiasResolutionFailureMessage(
  result: Extract<SamplingBiasResolutionResult, { kind: "tokenizer-unavailable" }>
): string {
  return TOKENIZER_UNAVAILABLE_CAUSE_TEXT[result.cause];
}

/** The distinct owners across a "shadowed" entry's conflicts, in the order
 * their first token appears in `entry.variants` — a shadow that lost tokens
 * to the same owner twice (e.g. both the typed and the capitalized form)
 * must name that owner once, not once per token. Exported so a caller that
 * only needs a short summary (the sampling-bias panel's row text) does not
 * re-derive this from `conflicts` itself.
 *
 * Typed to "shadowed" only, not "overridden" too, even though both kinds
 * share the exact fields this reads (`variants`, `conflicts`). An
 * "overridden" entry has no caller that needs this today: the sampling-bias
 * panel's row builder throws on one rather than producing it, because the
 * settings overlay it renders never combines a story into the merge (issue
 * #341 left that story-overlay panel unbuilt). Widen back to
 * `Extract<SamplingBiasEntryResolution, { kind: "shadowed" | "overridden" }>`
 * if that panel gets built and needs this same summary — don't widen it on
 * spec alone. */
export function samplingBiasShadowOwners(
  entry: Extract<SamplingBiasEntryResolution, { kind: "shadowed" }>
): readonly SamplingBiasShadowOwner[] {
  const owners: SamplingBiasShadowOwner[] = [];
  for (const variant of entry.variants) {
    if (variant.outcome.kind !== "single-token") continue;
    const tokenId = variant.outcome.tokenId;
    const conflict = entry.conflicts.find((candidate) => candidate.tokenId === tokenId);
    if (conflict === undefined) continue;
    if (!owners.some((owner) => sameShadowOwner(owner, conflict.owner))) owners.push(conflict.owner);
  }
  return owners;
}

/** The reader-facing name for one shadow owner — "an explicit numeric
 * logit-bias entry" has no phrase of its own to quote. Names the story
 * explicitly when the owner is story-scoped (issue #341): a writer telling
 * two same-named phrases apart ("delve" the profile's, "delve" the story's)
 * needs the scope, not just the text, to know which one actually won. A
 * profile owner keeps the unprefixed #282 wording — the profile has been the
 * only scope for this message since before a story could own an entry, and
 * every existing "shadowed" message (a same-scope conflict, since scope only
 * ever differs on the non-blocking "overridden" outcome) still reads exactly
 * as it did before this scope existed. */
export function samplingBiasShadowOwnerText(owner: SamplingBiasShadowOwner): string {
  if (owner.source === "logitBias") return "an explicit numeric logit-bias entry";
  const ownerKind = owner.source === "bannedStrings" ? "banned string" : "phrase bias";
  const scopeText = owner.scope === "story" ? "this story's " : "";
  return `${scopeText}${ownerKind} ${JSON.stringify(owner.phrase)}`;
}

function sameShadowOwner(a: SamplingBiasShadowOwner, b: SamplingBiasShadowOwner): boolean {
  if (a.source === "logitBias" || b.source === "logitBias") return a.source === b.source;
  return a.source === b.source && a.scope === b.scope && a.phrase === b.phrase;
}

/** A short, honest reason a single entry was kept off the wire — either it
 * never resolved to one token per surface variant ("rejected"), or at least
 * one of its tokens ended up carrying a different entry's weight
 * ("shadowed" — issue #282 review round 3, finding 1). Names exactly which
 * surface forms lost this entry's own bias, not the whole entry, since a
 * shadow can be partial — and groups those forms under the owner that
 * actually took each one, one clause per owner, so a shadow split across
 * two different owners (issue #282 review round 4, finding 1) is reported
 * accurately instead of blaming every lost form on a single owner. Never
 * claims either kind did something it did not.
 *
 * Takes only "rejected" and "shadowed" (issue #341 narrowed this from every
 * non-"resolved" kind): those two are the ones that block, and they are the
 * only two `firstBlockingSamplingBiasEntry` below ever returns. "overridden"
 * is not a rejection — it must never be reported as an error, and has no
 * caller that needs a message for it at all. */
export function samplingBiasEntryRejectionMessage(
  entry: Extract<SamplingBiasEntryResolution, { kind: "rejected" | "shadowed" }>
): string {
  if (entry.kind === "shadowed") {
    const singleTokenVariants = entry.variants.flatMap((variant) =>
      variant.outcome.kind === "single-token"
        ? [{ text: variant.text, tokenId: variant.outcome.tokenId }]
        : []);
    const clauses = samplingBiasShadowOwners(entry).map((owner) => {
      const forms = [...new Set(
        singleTokenVariants
          .filter(({ tokenId }) => entry.conflicts.some((conflict) =>
            conflict.tokenId === tokenId && sameShadowOwner(conflict.owner, owner)))
          .map(({ text }) => JSON.stringify(text))
      )].join(", ");
      return `${forms} to ${samplingBiasShadowOwnerText(owner)}, which takes precedence there`;
    });
    return `${JSON.stringify(entry.phrase)} loses its bias on ${clauses.join("; and on ")}`;
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

/** The first phraseBias or bannedStrings entry, in list order (phraseBias
 * before bannedStrings), that must block a save or a request: one that never
 * resolved to a single token in every surface variant ("rejected"), or one
 * whose resolution lost a real weight conflict to another entry ("shadowed"
 * — issue #282 review round 3, finding 2 made this outcome block, like
 * "rejected", instead of passing silently). Shared by
 * server/provider-sampling.ts (request-time application) and
 * server/settings-v2-sampling-validation.ts (save-time validation), which
 * used to each keep a byte-identical private copy of this walk (finding
 * 6). "overridden" passes through unblocked: it is a deliberate story
 * value, not a fact about a phrase 1667 failed to resolve. A native
 * bannedStrings entry is never a member of this union at all — see
 * `firstBlockedNativeBannedString` below for its own, differently-shaped
 * blocking check. */
export function firstBlockingSamplingBiasEntry(
  phraseBias: readonly SamplingBiasEntryResolution[],
  bannedStrings: readonly SamplingBiasEntryResolution[]
): Extract<SamplingBiasEntryResolution, { kind: "rejected" | "shadowed" }> | undefined {
  for (const entry of [...phraseBias, ...bannedStrings]) {
    if (entry.kind === "rejected" || entry.kind === "shadowed") return entry;
  }
  return undefined;
}

/** The one blocked native bannedStrings entry, if any — the
 * `SamplingBiasNativeBannedStringResolution` counterpart to
 * `firstBlockingSamplingBiasEntry` above, checked alongside it by every
 * caller that enforces blocking (server/provider-sampling.ts,
 * server/settings-v2-sampling-validation.ts): a native entry is never a
 * `SamplingBiasEntryResolution`, so it cannot ride the same list, but it
 * must block a save or a request the same honest way (issue #311, second
 * pass, finding B) — a writer who configured a direct self-contradiction is
 * told on every preset, KoboldCpp included, not silently shipped there
 * while every other preset refuses it. */
export function firstBlockedNativeBannedString(
  nativeBannedStrings: readonly SamplingBiasNativeBannedStringResolution[]
): Extract<SamplingBiasNativeBannedStringResolution, { kind: "blocked" }> | undefined {
  return nativeBannedStrings.find(
    (entry): entry is Extract<SamplingBiasNativeBannedStringResolution, { kind: "blocked" }> =>
      entry.kind === "blocked"
  );
}

/** The message for a blocked native bannedStrings entry — the
 * `SamplingBiasNativeBannedStringResolution` counterpart to
 * `samplingBiasEntryRejectionMessage`, in the same shape: names the literal
 * text conflict a native entry can detect (it has no token IDs to name the
 * way a "shadowed" phraseBias entry's message does). */
export function samplingBiasNativeBlockedMessage(
  entry: Extract<SamplingBiasNativeBannedStringResolution, { kind: "blocked" }>
): string {
  return `${JSON.stringify(entry.phrase)} conflicts with phrase bias `
    + `${JSON.stringify(entry.conflictingPhrase)} in the same scope`;
}

import {
  promptBiasTokenizerEncoding,
  samplingBiasVariantText,
  SAMPLING_BIAS_VARIANT_VALUES,
  type PromptBiasEncoding,
  type SamplingBiasEntryResolution,
  type SamplingBiasResolutionResult,
  type SamplingBiasScope,
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
import type { SamplingPhraseBiasEntryV2, SamplingSettingsV2 } from "../shared/settings-v2-types.js";
import type { GenerationSettings, Story } from "../shared/types.js";
import { hasUnpairedSurrogate, unicodeScalarLength } from "../shared/unicode.js";
import { ServiceError } from "./errors.js";
import { promptBiasEncoderAvailable, tokenizePhraseTokenIds } from "./openai-prompt-tokenizer.js";
import { probeLlamaCppTokenize } from "./context-probe.js";
import { providerRuntimeFor } from "./provider-runtime.js";

/** One phraseBias entry or bannedStrings phrase, tagged with the scope
 * (profile or story) it was configured in — the unit `resolveSamplingLogitBias`
 * actually merges over (issue #341). Built once, by `combineSamplingBiasSources`
 * below, from the profile's own sampling plus an optional story overlay; every
 * caller downstream of that point works in scoped entries, never raw
 * `SamplingSettingsV2` fields, so scope can never quietly go missing partway
 * through the merge. */
export interface ScopedSamplingBiasEntry {
  readonly phrase: string;
  readonly weight: number;
  readonly scope: SamplingBiasScope;
}

/** The already-scoped input `resolveSamplingLogitBias` merges — every entry
 * knows which scope it came from, so a real weight conflict can be told
 * apart as "shadowed" (same scope) or "overridden" (different scope).
 * `bannedStrings` carries no weight of its own on the wire (every banned
 * string writes the fixed minimum), but `combineSamplingBiasSources` below
 * stamps that fixed weight onto each entry when it builds this list, so both
 * fields share one entry shape — no second type, no cast, no per-source
 * ternary anywhere this is read. */
export interface SamplingBiasMergeInput {
  readonly logitBias: Readonly<Record<string, number>>;
  readonly phraseBias: readonly ScopedSamplingBiasEntry[];
  readonly bannedStrings: readonly ScopedSamplingBiasEntry[];
}

/** A story's own phraseBias/bannedStrings overlay — the shape
 * `Story`/`StoryPayload` carry (shared/types.ts), read here without a
 * dependency on either: this module only needs the two lists, not the rest
 * of a story. */
export interface StorySamplingBias {
  readonly phraseBias: readonly SamplingPhraseBiasEntryV2[];
  readonly bannedStrings: readonly string[];
}

/** Normalizes a pair of independently-optional phraseBias/bannedStrings
 * lists into one `StorySamplingBias`, or `undefined` when the story truly
 * contributes nothing (issue #341 finding 5/6). `{phraseBias:[],
 * bannedStrings:[]}` and `undefined` both mean "this story adds nothing to
 * the profile", and leaving them as two live encodings is what forced
 * `applySamplingFields` to keep a `storyHasBias` boolean whose only job was
 * re-deriving the distinction this function now settles once. Every caller
 * that used to write its own `?? []` pair over two optional fields —
 * `storySamplingBias` below (a real `Story`'s own fields), the
 * `resolveSamplingBias` worker method (server/story-service.ts), and its
 * demo-mode counterpart (tui/src/demo-token-ids.ts) — shares this one
 * defaulting instead. */
export function normalizeStorySamplingBias(
  phraseBias: readonly SamplingPhraseBiasEntryV2[] | undefined,
  bannedStrings: readonly string[] | undefined
): StorySamplingBias | undefined {
  const resolvedPhraseBias = phraseBias ?? [];
  const resolvedBannedStrings = bannedStrings ?? [];
  if (resolvedPhraseBias.length === 0 && resolvedBannedStrings.length === 0) return undefined;
  return { phraseBias: resolvedPhraseBias, bannedStrings: resolvedBannedStrings };
}

/** Reads a story's phraseBias/bannedStrings overlay into `StorySamplingBias`
 * — the one place every request-path caller (server/generation-http.ts)
 * turns a loaded `Story` into the shape `streamCompletion`'s `storySampling`
 * option and `resolveSamplingBiasForSettings` both expect, the same way
 * `resolveAuthorBrief` is the one place every caller reads a story's
 * author-brief override. `undefined` when the story has neither list set —
 * matching `combineSamplingBiasSources`'s own "omitted, not merely empty"
 * contract for a caller with no story in play at all. */
export function storySamplingBias(story: Pick<Story, "phraseBias" | "bannedStrings">): StorySamplingBias | undefined {
  return normalizeStorySamplingBias(story.phraseBias, story.bannedStrings);
}

/** `signal` and `storySampling` travel everywhere together, from a real
 * request down to `resolveSamplingBiasForSettings` below — every layer in
 * between (`provider-request-body.ts`'s two body builders,
 * `applySamplingFields`, `mergedLogitBiasValue`) reads neither itself, only
 * passes both on to the next. Issue #341 finding 5: keeping them as two
 * separate trailing optionals let any one of those layers grow one without
 * the other; bundled into a single value, that is no longer possible
 * structurally, and a layer that has to touch this at all touches the whole
 * thing. `signal` stays meaningful with no story in play at all — the
 * llama-cpp tokenize probe below needs it for a profile-only phraseBias or
 * bannedStrings value exactly as it did before issue #341 — so bundling the
 * two does not imply either depends on the other. */
export interface StorySamplingRequest {
  readonly signal?: AbortSignal;
  readonly storySampling?: StorySamplingBias;
}

/** Builds the one merge input every caller resolves against: the profile's
 * phraseBias and bannedStrings (scope "profile"), then the story's, if any
 * (scope "story") — the array order here is cosmetic, kept profile-then-
 * story for readability only. `resolveSamplingLogitBias` does not trust this
 * array's position to establish authority (issue #341 finding 1: a merge
 * that trusted array position was *source*-major — every phraseBias entry,
 * then every bannedStrings entry, then the raw numeric map — which let a
 * profile bannedStrings or logitBias entry beat a story phraseBias entry
 * even though the story is supposed to have the last word). It re-derives
 * scope-major order from each entry's own `scope` tag instead, so this
 * function's only job is tagging, not ordering. `story` is omitted entirely
 * (not just empty) by every caller that has no story in play (settings-save
 * validation, the profile editor's own preview) — omitting it must produce
 * the exact byte-identical merge #282 already shipped, which the scope tag
 * alone accomplishes: every entry bottoms out "profile", so no shadow can
 * ever become an "overridden". */
export function combineSamplingBiasSources(
  profile: Pick<SamplingSettingsV2, "logitBias" | "phraseBias" | "bannedStrings">,
  story?: StorySamplingBias
): SamplingBiasMergeInput {
  return {
    logitBias: profile.logitBias,
    phraseBias: [
      ...profile.phraseBias.map((entry): ScopedSamplingBiasEntry => ({ ...entry, scope: "profile" })),
      ...(story?.phraseBias ?? []).map((entry): ScopedSamplingBiasEntry => ({ ...entry, scope: "story" }))
    ],
    bannedStrings: [
      ...profile.bannedStrings.map((phrase): ScopedSamplingBiasEntry => (
        { phrase, weight: SAMPLING_LOGIT_BIAS_POLICY.minimum, scope: "profile" }
      )),
      ...(story?.bannedStrings ?? []).map((phrase): ScopedSamplingBiasEntry => (
        { phrase, weight: SAMPLING_LOGIT_BIAS_POLICY.minimum, scope: "story" }
      ))
    ]
  };
}

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
 * Merge order, least to most authoritative: **scope first** — every profile
 * entry, then every story entry (issue #341 finding 1) — and, within one
 * scope, phraseBias, then bannedStrings, then (profile only) the explicit
 * numeric logitBias map, exactly as before. Scope has to be the primary
 * split, not source kind: a merge that applied every phraseBias entry, then
 * every bannedStrings entry, then the numeric map, regardless of scope, let
 * a profile bannedStrings or logitBias entry beat a story phraseBias entry —
 * the story losing to the profile it is supposed to override, silently
 * reported as a non-blocking "override" in the other direction. Within a
 * scope, bannedStrings intentionally outranks phraseBias (a stronger
 * "exclude this" signal), and an explicit numeric logitBias entry always
 * wins over anything derived from text, because the writer typed that exact
 * token ID — both unchanged from before scope existed at all.
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
 *
 * Every entry arrives already scoped (`ScopedSamplingBiasEntry` — issue #341,
 * `combineSamplingBiasSources` builds this from a profile and an optional
 * story overlay). `settleTokenOwnership` decides "shadowed" versus
 * "overridden" by asking a per-scope partition of the same write list first
 * — restricted to only this entry's own scope (issue #341 finding 1b) — and
 * only falls back to the cross-scope map when that per-scope answer is
 * clean. It cannot ask the cross-scope map first: a third entry from the
 * other scope can end up as a token's final, overall owner and hide a real
 * same-scope disagreement underneath it. See `settleTokenOwnership` for why
 * that ordering is load-bearing.
 */
export function resolveSamplingLogitBias(
  sampling: SamplingBiasMergeInput,
  tokenizeVariant: SyncVariantTokenizer
): SamplingBiasResolutionResult {
  const phraseResolutions = sampling.phraseBias.map((entry) =>
    resolveEntry(entry.phrase, entry.scope, tokenizeVariant));
  const bannedResolutions = sampling.bannedStrings.map((entry) =>
    resolveEntry(entry.phrase, entry.scope, tokenizeVariant));

  // One ordered write list, scope-major then source-major within a scope
  // (issue #341 finding 1) — built once from every resolved entry's own
  // `scope` tag, never from the input arrays' position, so a caller cannot
  // accidentally restore the old, wrong source-major order by handing the
  // entries in a different sequence. One pass below partitions it into two
  // `SamplingBiasOwnershipView`s, not two separate reductions: `combined`
  // (last write wins across every scope) decides what ships and, when an
  // entry loses, who is named for it; `byScope` (issue #341 finding 1b)
  // answers the same two questions restricted to one scope's own writes —
  // see `settleTokenOwnership`, which asks `byScope` first.
  const writes: readonly SamplingBiasWrite[] = [
    ...scopedWrites("profile", "phraseBias", sampling.phraseBias, phraseResolutions),
    ...scopedWrites("profile", "bannedStrings", sampling.bannedStrings, bannedResolutions),
    ...Object.entries(sampling.logitBias).map(([token, weight]): SamplingBiasWrite => ({
      tokenId: Number(token),
      weight,
      scope: "profile",
      owner: { source: "logitBias" }
    })),
    ...scopedWrites("story", "phraseBias", sampling.phraseBias, phraseResolutions),
    ...scopedWrites("story", "bannedStrings", sampling.bannedStrings, bannedResolutions)
  ];

  // Built through the views themselves, not as four loose maps paired up
  // afterwards: a hand-written pairing compiles just as happily when a
  // scope's weights are matched with another scope's owners, which is the
  // one mistake this shape exists to rule out.
  const views = collectOwnership(writes);

  const phraseBias = phraseResolutions.map((resolution, index) =>
    settleTokenOwnership(resolution, sampling.phraseBias[index]!.weight, views));
  const bannedStrings = bannedResolutions.map((resolution, index) =>
    settleTokenOwnership(resolution, sampling.bannedStrings[index]!.weight, views));

  return {
    kind: "resolved",
    logitBias: views.combined.weightByToken,
    phraseBias,
    bannedStrings,
    resolvedEntryCount: Object.keys(views.combined.weightByToken).length
  };
}

interface SamplingBiasWrite {
  readonly tokenId: number;
  readonly weight: number;
  readonly scope: SamplingBiasScope;
  readonly owner: SamplingBiasShadowOwner;
}

/** One pass over the ordered writes, filling the combined view and the
 * writing scope's view together. Every view is filled by the same loop, so a
 * weight and its owner can never come from different maps. */
function collectOwnership(writes: readonly SamplingBiasWrite[]): SamplingBiasOwnershipViews {
  interface OwnershipBuilder {
    readonly weightByToken: Record<string, number>;
    readonly ownerByToken: Map<number, SamplingBiasShadowOwner>;
  }
  const view = (): OwnershipBuilder => ({ weightByToken: {}, ownerByToken: new Map() });
  const combined = view();
  const byScope: Record<SamplingBiasScope, OwnershipBuilder> = { profile: view(), story: view() };
  for (const write of writes) {
    for (const target of [combined, byScope[write.scope]]) {
      target.weightByToken[String(write.tokenId)] = write.weight;
      target.ownerByToken.set(write.tokenId, write.owner);
    }
  }
  return { combined, byScope };
}

/** A token's current weight and who owns it, read together — every place
 * this file asks "what does this token carry" also needs "who put it there"
 * if the answer turns out to disagree with an entry's own weight, so the two
 * travel as one matched pair instead of two separately-indexed maps that
 * could, in principle, drift out of sync with each other. */
interface SamplingBiasOwnershipView {
  readonly weightByToken: Readonly<Record<string, number>>;
  readonly ownerByToken: ReadonlyMap<number, SamplingBiasShadowOwner>;
}

/** The two views `settleTokenOwnership` classifies every entry against:
 * `combined` (every scope's writes, last one wins) and `byScope` (the same
 * writes, partitioned by scope — issue #341 finding 1b). Bundled into one
 * value so the function that reads both takes one parameter instead of the
 * four separately-threaded maps `resolveSamplingLogitBias` used to build and
 * pass down by hand. See `settleTokenOwnership`'s own comment for why
 * `byScope` is asked before `combined`. */
interface SamplingBiasOwnershipViews {
  readonly combined: SamplingBiasOwnershipView;
  readonly byScope: Readonly<Record<SamplingBiasScope, SamplingBiasOwnershipView>>;
}

/** Every write a phraseBias or bannedStrings entry of exactly `scope` makes,
 * in the entries' own array order (issue #341 finding 1: filtering by scope
 * here, rather than trusting the array's overall position, is what makes the
 * merge order scope-major regardless of how `combineSamplingBiasSources`
 * happened to interleave profile and story entries in its own arrays).
 * `entries`/`resolutions` are index-aligned, exactly as every other walk in
 * this file assumes.
 *
 * Each write's owner carries `entry.phrase` directly, not an index into
 * `entries`: this loop already has the entry in hand, so recording its
 * phrase here costs nothing, and it means `shadowOwnerFor` below never needs
 * a second lookup back into the original `sampling` input just to report
 * which phrase actually won a token. */
function scopedWrites(
  scope: SamplingBiasScope,
  source: "phraseBias" | "bannedStrings",
  entries: readonly ScopedSamplingBiasEntry[],
  resolutions: readonly SamplingBiasEntryResolution[]
): SamplingBiasWrite[] {
  const writes: SamplingBiasWrite[] = [];
  resolutions.forEach((resolution, index) => {
    if (resolution.kind !== "resolved") return;
    const entry = entries[index]!;
    if (entry.scope !== scope) return;
    for (const tokenId of resolution.tokenIds) {
      writes.push({ tokenId, weight: entry.weight, scope, owner: { source, scope, phrase: entry.phrase } });
    }
  });
  return writes;
}

/** Downgrades a "resolved" entry once it lost at least one of its own tokens
 * to a different write — i.e. some other entry's weight, not this one's, is
 * what the relevant map actually carries for that token id. Two entries that
 * both resolve to a shared token and both write it the same weight never
 * trigger this (issue #282 review round 3, finding 1): there is no weight
 * for either of them to lose, so a banned string that overlaps an earlier
 * banned string, or a phrase-bias entry that happens to share a later
 * entry's exact weight, stays "resolved" — the outcome no longer depends on
 * which of the two was typed first. `rejected` entries pass through
 * unchanged: they never held any tokens to lose.
 *
 * Every one of `resolution.tokenIds` that lost is paired with the entry that
 * actually wrote its weight — a `SamplingBiasShadowConflict` per lost token,
 * not one `shadowedBy` for the whole entry (issue #282 review round 4,
 * finding 1): a shadow can split its lost tokens across two different
 * owners (one taken by an explicit numeric `logitBias` entry, another by a
 * different phrase), and picking only the first token's owner to represent
 * all of them blamed the wrong entry for the rest.
 *
 * "shadowed" versus "overridden" (issue #341 finding 1b) asks `views.byScope`
 * first, before ever looking at `views.combined` — the answer cannot come
 * from whichever view happens to be checked, because the two disagree
 * exactly in the case that matters. Asking `combined` first, gating on
 * whether *any* cross-scope loss occurred, and only then consulting
 * `byScope` to classify it is wrong whenever a *third* entry, from the scope
 * neither this entry nor its real rival belongs to, writes the same weight
 * this entry lost to within its own scope: two profile entries can
 * genuinely conflict with each other, one shadowing the other exactly as
 * #282 requires, and then an unrelated story entry that writes the same
 * final weight makes `combined` agree with `ownWeight` again — at which
 * point a cross-scope-first gate sees no loss at all and never reports the
 * real same-scope conflict underneath it. Asking `byScope` first has no such
 * blind spot: it is a partition of the very same write loop that built
 * `combined` (issue #341 finding 4 — not a second, independent reduction
 * that could ever disagree with it), so a same-scope loss is visible here
 * regardless of what any other scope later writes to the same token.
 *
 * A "shadowed" entry's `conflicts` are sourced from `views.byScope`, not
 * `views.combined` — this is deliberate, not incidental (issue #341 finding
 * 1, required fix): `views.combined` names whichever entry is the token's
 * final, cross-scope owner, which for a blocking same-scope conflict is very
 * often a different scope's entry that overwrote the wire value afterward.
 * Naming that entry as the rival is actively misleading — profile `hello@5`
 * versus `Hello@9` plus story `hello@99` would tell the writer `hello` lost
 * to *this story's* phrase bias, so deleting the story entry looks like the
 * fix, when it only reveals the real profile-vs-profile conflict underneath.
 * `views.byScope`, restricted to this entry's own scope, always names the
 * real rival. An "overridden" entry's `conflicts` keep sourcing from
 * `views.combined` — a cross-scope loss is a legitimate override, and the
 * entry that actually won the wire value is exactly who should be named for
 * it. */
function settleTokenOwnership(
  resolution: SamplingBiasEntryResolution,
  ownWeight: number,
  views: SamplingBiasOwnershipViews
): SamplingBiasEntryResolution {
  if (resolution.kind !== "resolved") return resolution;

  const ownScope = views.byScope[resolution.scope];
  const lostInScope = resolution.tokenIds.filter(
    (tokenId) => ownScope.weightByToken[String(tokenId)] !== ownWeight
  );
  if (lostInScope.length > 0) {
    return {
      kind: "shadowed",
      phrase: resolution.phrase,
      scope: resolution.scope,
      variants: resolution.variants,
      tokenIds: resolution.tokenIds,
      conflicts: lostInScope.map((tokenId) => ({
        tokenId,
        owner: shadowOwnerFor(tokenId, ownScope.ownerByToken)
      }))
    };
  }

  const lostOverall = resolution.tokenIds.filter(
    (tokenId) => views.combined.weightByToken[String(tokenId)] !== ownWeight
  );
  if (lostOverall.length === 0) return resolution;
  return {
    kind: "overridden",
    phrase: resolution.phrase,
    scope: resolution.scope,
    variants: resolution.variants,
    tokenIds: resolution.tokenIds,
    conflicts: lostOverall.map((tokenId) => (
      { tokenId, owner: shadowOwnerFor(tokenId, views.combined.ownerByToken) }
    ))
  };
}

/** Names the entry that owns `tokenId` in `ownerByToken` — either
 * `views.combined.ownerByToken`, or one scope's own restriction of it
 * (`views.byScope[scope].ownerByToken`), depending on which view decided the
 * outcome (see `settleTokenOwnership`). Every token in a "resolved" entry's
 * own `tokenIds` was written into both the combined and the matching
 * per-scope owner map in the same pass that built the matching weight maps
 * (`resolveSamplingLogitBias` above), so a miss here is a real merge
 * invariant violation, not a legitimate case to paper over with a silent
 * fallback owner. The map already stores the finished `SamplingBiasShadowOwner`
 * — phrase and all (`scopedWrites` records it directly) — so this is a read
 * plus its invariant check, nothing more. */
function shadowOwnerFor(
  tokenId: number,
  ownerByToken: ReadonlyMap<number, SamplingBiasShadowOwner>
): SamplingBiasShadowOwner {
  const owner = ownerByToken.get(tokenId);
  if (owner === undefined) {
    throw new Error(`sampling bias merge invariant violated: token ${tokenId} has no recorded owner`);
  }
  return owner;
}

function resolveEntry(
  phrase: string,
  scope: SamplingBiasScope,
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
    return { kind: "resolved", phrase, scope, variants, tokenIds };
  }
  return { kind: "rejected", phrase, scope, variants };
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
  sampling: SamplingBiasMergeInput,
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
 *
 * `request.storySampling`, when supplied, adds one story's own phraseBias/
 * bannedStrings on top of `sampling`'s (issue #341) — combined once, here,
 * via `combineSamplingBiasSources`, into the single scoped set every branch
 * below resolves. Every caller that has no story in play (settings-save
 * validation, none of which reaches this function at all — see
 * `resolveSamplingLogitBiasForEncoding`'s own callers) or omits it gets the
 * exact `sampling`-only resolution #282 already shipped. `request.signal`
 * travels alongside it — see `StorySamplingRequest` for why the two are one
 * parameter, not two.
 */
export async function resolveSamplingBiasForSettings(
  sampling: Pick<SamplingSettingsV2, "logitBias" | "phraseBias" | "bannedStrings">,
  settings: GenerationSettings,
  request: StorySamplingRequest = {}
): Promise<SamplingBiasResolutionResult> {
  const { signal, storySampling } = request;
  const combined = combineSamplingBiasSources(sampling, storySampling);
  const needsTokenizer = combined.phraseBias.length > 0 || combined.bannedStrings.length > 0;
  if (!needsTokenizer) return resolveSamplingLogitBias(combined, neverCalledTokenizer);
  if (settings.provider !== "openai-compatible") {
    return { kind: "tokenizer-unavailable", cause: "model-unknown" };
  }
  const runtime = providerRuntimeFor(settings);
  if (runtime.preset === "openai") {
    return resolveSamplingLogitBiasForEncoding(combined, promptBiasTokenizerEncoding(settings.model));
  }
  if (runtime.preset === "llama-cpp") {
    const tokenizer = await llamaCppVariantTokenizer(combined, settings, signal);
    return tokenizer === null
      ? { kind: "tokenizer-unavailable", cause: "probe-failed" }
      : resolveSamplingLogitBias(combined, tokenizer);
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
  sampling: Pick<SamplingBiasMergeInput, "phraseBias" | "bannedStrings">,
  settings: GenerationSettings,
  signal?: AbortSignal
): Promise<SyncVariantTokenizer | null> {
  const texts = new Set<string>();
  for (const entry of sampling.phraseBias) {
    for (const variant of SAMPLING_BIAS_VARIANT_VALUES) texts.add(samplingBiasVariantText(entry.phrase, variant));
  }
  for (const entry of sampling.bannedStrings) {
    for (const variant of SAMPLING_BIAS_VARIANT_VALUES) texts.add(samplingBiasVariantText(entry.phrase, variant));
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
  /** The one story's own overlay, previewed the same way the request will
   * combine it (issue #341) — absent (not merely empty) when the caller is
   * the profile editor, which has no story in play at all. Optional on the
   * wire so an older TUI build that has never heard of a story overlay still
   * calls this method exactly as it always has. */
  readonly storyPhraseBias?: readonly { readonly phrase: string; readonly weight: number }[];
  readonly storyBannedStrings?: readonly string[];
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
    bannedStrings: parseBannedStringsField(record.bannedStrings),
    ...(record.storyPhraseBias === undefined ? {} : { storyPhraseBias: parsePhraseBiasField(record.storyPhraseBias) }),
    ...(record.storyBannedStrings === undefined
      ? {}
      : { storyBannedStrings: parseBannedStringsField(record.storyBannedStrings) })
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

/** Structural-only phraseBias parsing, shared by `parseResolveSamplingBiasInput`
 * above and the `setPhraseBias` worker mutation (server/worker-mutations.ts)
 * — both are wire boundaries that hand off to a precise, save-time-strength
 * validator afterward (`shared/sampling-validation-policy.ts`'s
 * `validateSamplingPhraseBias`, run by server/story-sampling.ts for the
 * mutation and by save-time validation for a profile), so staying permissive
 * here is deliberate, not a gap. */
export function parsePhraseBiasField(
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

export function parseBannedStringsField(value: unknown): readonly string[] {
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

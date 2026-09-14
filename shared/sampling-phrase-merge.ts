import {
  samplingBiasPresetRules,
  samplingBiasVariantText,
  SAMPLING_BIAS_VARIANT_VALUES,
  type SamplingBiasEntryResolution,
  type SamplingBiasNativeBannedStringResolution,
  type SamplingBiasPresetRules,
  type SamplingBiasResolutionResult,
  type SamplingBiasScope,
  type SamplingBiasShadowConflict,
  type SamplingBiasShadowOwner,
  type SamplingBiasVariantOutcome,
  type SamplingBiasVariantResolution
} from "./sampling-capabilities.js";
import {
  SAMPLING_LOGIT_BIAS_POLICY
} from "./sampling-validation-policy.js";
import type { SamplingPhraseBiasEntryV2, SamplingSettingsV2 } from "./settings-v2-types.js";
import type { Story } from "./types.js";
import type { ResolvedReasoningPolicy } from "./reasoning-capabilities.js";

const SPECIAL_TOKEN_SYNTAX = /<\|?\/?[A-Za-z0-9_]+\|?>|\[\/?(?:inst|system_prompt)\]/i;
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

/** Wire shape accepted by the editor's sampling-bias preview. */
export interface ResolveSamplingBiasInput {
  readonly logitBias: Readonly<Record<string, number>>;
  readonly phraseBias: readonly { readonly phrase: string; readonly weight: number }[];
  readonly bannedStrings: readonly string[];
  readonly storyPhraseBias?: readonly { readonly phrase: string; readonly weight: number }[];
  readonly storyBannedStrings?: readonly string[];
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
  /** Canonical schema-4 reasoning/sampling result. */
  readonly reasoningPolicy?: ResolvedReasoningPolicy;
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
 *
 * `bannedStringsTransport` (issue #311, second pass) is the one decision
 * that used to live outside this function, applied to its output instead of
 * pushed into its input — `resolveKoboldCppSamplingBias` deleted
 * `bannedStrings` before calling this, then spread a hand-built "native"
 * array onto the result afterward, breaking the index-alignment postcondition
 * every other array here keeps with its own input. "token" (the default)
 * tokenizes bannedStrings exactly like phraseBias, unchanged from before this
 * parameter existed — every caller that predates it keeps its exact prior
 * behavior. "native" — KoboldCpp only, decided by `samplingBiasPresetRules`
 * (shared/sampling-phrase-resolution.ts) — never tokenizes bannedStrings at
 * all: `bannedStrings` on the result is empty, and every configured banned
 * string resolves instead into `nativeBannedStrings`
 * (`classifyNativeBannedStrings` below, the one place that can produce it),
 * so a native `phraseBias` entry is unrepresentable and this is the only
 * function that ever fills the field — pushing the decision here, rather
 * than leaving each preset's own caller to reassemble it, is what lets
 * every caller with a preset in hand — a real request, save-time validation,
 * and the TUI's demo-mode preview alike — get the identical decision for
 * free (issue #311 review, second pass, finding C).
 */
export function resolveSamplingLogitBias(
  sampling: SamplingBiasMergeInput,
  tokenizeVariant: SyncVariantTokenizer,
  rules: SamplingBiasPresetRules = samplingBiasPresetRules("legacy-v1")
): SamplingBiasResolutionResult {
  const isNative = rules.bannedStringsTransport === "native";
  // `rules.rejectSpecialTokenSyntax` (issue #311 review, third pass, finding
  // M): enforced here, in the one merge function every caller with a preset
  // in hand shares — a real request, save-time validation, and the TUI's
  // demo-mode preview alike (`demoResolveSamplingBias`,
  // tui/src/demo-token-ids.ts) — rather than inside the live-probe layer
  // demo never goes through. That was the actual defect: the guard, added
  // two rounds ago, lived inside `liveProbeVariantTokenizer`
  // (server/sampling-phrase-bias.ts), which only the real KoboldCpp request
  // path calls; demo supplies its own synchronous fake tokenizer straight to
  // this function, so it never saw the guard at all. This is the third time
  // this exact class of gap has opened on this path (#282 round 4, this
  // issue's first pass, and now this rule) — see `SPECIAL_TOKEN_SYNTAX`'s
  // own doc comment for what it catches and why.
  const guardedTokenizeVariant: SyncVariantTokenizer = rules.rejectSpecialTokenSyntax
    ? (text) => (SPECIAL_TOKEN_SYNTAX.test(text) ? { kind: "unencodable" } : tokenizeVariant(text))
    : tokenizeVariant;
  // Collapsed from five separate `isNative` branches to two (issue #311
  // review, third pass, finding J): a native banned string never tokenizes
  // of its own accord, so an empty list here — not a ternary at every step
  // below — is what "native" means to the resolutions map, the
  // `settleTokenOwnership` map, and the final `bannedStrings` output alike;
  // all three now run unconditionally, empty in, empty out. The write-slot
  // choices two paragraphs down are the two branches that cannot collapse
  // the same way: a native banned string's writes are real, just borrowed
  // rather than its own (see `nativeBannedStringWrites` below).
  const tokenBannedStrings = isNative ? [] : sampling.bannedStrings;

  const phraseResolutions = sampling.phraseBias.map((entry) =>
    resolveEntry(entry.phrase, entry.scope, guardedTokenizeVariant));
  const bannedResolutions = tokenBannedStrings.map((entry) =>
    resolveEntry(entry.phrase, entry.scope, guardedTokenizeVariant));

  // A native banned string never resolves a token of its own, but a
  // colliding phraseBias entry's own tokens are real — borrowing them here
  // (issue #311 review, third pass, findings G/H) is what lets the ordinary
  // scope-major write list below decide "who wins" through the same
  // already-tested mechanism every other collision goes through, instead of
  // a second, hand-rolled copy that could quietly disagree with the first
  // (which is exactly what happened: an earlier version's own copy silently
  // skipped every cross-scope case). `phraseCandidates` bundles each
  // phraseBias entry's own resolved tokens and surface-variant texts, and
  // `bannedStringCollisions` runs the collision scan itself exactly once
  // per banned string — both computed here and passed as plain values into
  // `nativeBannedStringWrites` and `classifyNativeBannedStrings` below
  // (issue #311 review, third pass, finding N; round four found that fix
  // incomplete — see `collidingPhraseBiasTokens`'s own comment for why the
  // scan itself, not only the variant-set allocations, was still doubled).
  const phraseCandidates: readonly SamplingBiasPhraseCandidate[] = isNative
    ? sampling.phraseBias.map((entry, index): SamplingBiasPhraseCandidate => {
        const resolution = phraseResolutions[index]!;
        const tokenIdByVariantText = new Map<string, number>();
        if (resolution.kind === "resolved") {
          for (const variant of resolution.variants) {
            if (variant.outcome.kind === "single-token") tokenIdByVariantText.set(variant.text, variant.outcome.tokenId);
          }
        }
        return { entry, tokenIdByVariantText };
      })
    : [];
  const bannedStringCollisions: readonly (readonly (readonly number[])[])[] = isNative
    ? sampling.bannedStrings.map((entry) => collidingPhraseBiasTokens(entry, phraseCandidates))
    : [];
  const nativeWrites = isNative
    ? nativeBannedStringWrites(sampling.bannedStrings, bannedStringCollisions)
    : [];

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
  const profilePhraseWrites = scopedWrites("profile", "phraseBias", sampling.phraseBias, phraseResolutions);
  const storyPhraseWrites = scopedWrites("story", "phraseBias", sampling.phraseBias, phraseResolutions);
  const rawLogitBiasWrites: readonly SamplingBiasWrite[] = Object.entries(sampling.logitBias).map(
    ([token, weight]): SamplingBiasWrite => ({ tokenId: Number(token), weight, scope: "profile", owner: { source: "logitBias" } })
  );
  const profileBannedWrites = isNative
    ? nativeWrites.filter((write) => write.scope === "profile")
    : scopedWrites("profile", "bannedStrings", tokenBannedStrings, bannedResolutions);
  const storyBannedWrites = isNative
    ? nativeWrites.filter((write) => write.scope === "story")
    : scopedWrites("story", "bannedStrings", tokenBannedStrings, bannedResolutions);

  // Built through the views themselves, not as four loose maps paired up
  // afterwards: a hand-written pairing compiles just as happily when a
  // scope's weights are matched with another scope's owners, which is the
  // one mistake this shape exists to rule out.
  const views = collectOwnership([
    ...profilePhraseWrites, ...profileBannedWrites, ...rawLogitBiasWrites, ...storyPhraseWrites, ...storyBannedWrites
  ]);

  const phraseBias = phraseResolutions.map((resolution, index) =>
    settleTokenOwnership(resolution, sampling.phraseBias[index]!.weight, views));
  const bannedStrings = bannedResolutions.map((resolution, index) =>
    settleTokenOwnership(resolution, tokenBannedStrings[index]!.weight, views));
  const nativeBannedStrings = isNative
    ? classifyNativeBannedStrings(sampling.bannedStrings, bannedStringCollisions, views)
    : [];

  // A native banned string's borrowed writes exist only to decide who wins
  // — they must never actually reach `logit_bias` on their own account:
  // KoboldCpp's `banned_tokens` is a separate wire field, so a losing
  // phraseBias entry's token simply drops out of the merged map here
  // (nothing replaces it — there is no real numeric bias a native banned
  // string ever wanted to write), the same way `banned_tokens` itself drops
  // a losing banned string below (issue #311 review, third pass, finding
  // G). But a token must not be dropped merely because a borrowed write
  // happens to be its *final* owner (finding L): a real, non-borrowed write
  // — a different phraseBias entry, in either scope, or an explicit numeric
  // `logitBias` entry — can independently want the exact same weight there,
  // and that entry's own row already reports itself "resolved" on the
  // strength of it. `realOnlyViews`, the same ownership computation over
  // every write *except* the borrowed ones, answers "what would this token
  // carry without any native banned string's involvement at all" — a token
  // is dropped only when removing the native writes would have changed its
  // value, i.e. its current value is backed *solely* by a synthetic write.
  const realOnlyViews = isNative
    ? collectOwnership([...profilePhraseWrites, ...rawLogitBiasWrites, ...storyPhraseWrites])
    : views;
  const logitBias = isNative
    ? Object.fromEntries(
        Object.entries(views.combined.weightByToken).filter(([token, weight]) =>
          realOnlyViews.combined.weightByToken[token] === weight)
      )
    : views.combined.weightByToken;

  return {
    kind: "resolved",
    logitBias,
    phraseBias,
    bannedStrings,
    nativeBannedStrings,
    resolvedEntryCount: Object.keys(logitBias).length
  };
}

/** One phraseBias entry's own resolved tokens, keyed by the exact
 * surface-variant text each one belongs to — everything
 * `collidingPhraseBiasTokens` below needs about a candidate, bundled into
 * one value, index-aligned with `sampling.phraseBias`, and built exactly
 * once by `resolveSamplingLogitBias` above. Empty for a "rejected" entry,
 * which never tokenized at all and so has nothing to lend a colliding
 * native banned string.
 *
 * Keyed by text, not a flat `tokenIds` array (issue #311 review, round
 * seven, over-borrowing bug — two independent structural reviews found the
 * same defect): `collidingPhraseBiasTokens` needs to know *which* of this
 * candidate's tokens belong to the specific variant text that actually
 * collides with the other entry, not merely that some collision exists
 * somewhere across all four variants. A flat token set could not answer
 * that, and wrongly answered "all four" for a partial, case-specific
 * collision — see that function's own comment for the failing case this
 * shape exists to rule out. */
interface SamplingBiasPhraseCandidate {
  readonly entry: ScopedSamplingBiasEntry;
  readonly tokenIdByVariantText: ReadonlyMap<string, number>;
}

/**
 * Every real token id a native banned string is contesting, borrowed from
 * whichever phraseBias candidates it textually collides with — the one
 * predicate `nativeBannedStringWrites` and `classifyNativeBannedStrings`
 * below both derive from (issue #311 review, third pass, finding N): the
 * two used to each carry their own copy of this exact loop, and nothing
 * tied them together — precisely the "second hand-rolled copy that can
 * quietly disagree with the first" this round's whole rework exists to
 * eliminate; a same-scope-only earlier version of this predicate is exactly
 * what shipped the round-two cross-scope bug.
 *
 * `resolveSamplingLogitBias` above calls this once per banned string and
 * passes the result — index-aligned with `sampling.bannedStrings` — to both
 * callers, rather than each caller calling this once per banned string on
 * its own (issue #311 review, round four, finding N found the first fix
 * incomplete): finding N's original pass hoisted `candidateVariants` and
 * `resolvedTokens` out of the inner loop so neither caller rebuilt a
 * phraseBias entry's four surface-variant strings per banned string, but
 * `nativeBannedStringWrites` and `classifyNativeBannedStrings` still each
 * called this function once per banned string independently — the
 * collision *scan* itself, not only the string allocations it used to
 * repeat, was still doubled. Also dropped the returned `candidate` field an
 * earlier shape carried alongside `tokenIds` — neither caller ever read it,
 * only `tokenIds`, so returning bare token-id arrays here removes a field
 * that existed for no reader.
 *
 * A collision is literal-text overlap between both entries' own four
 * surface variants — the only identity a native banned string has to
 * compare with, since it never resolves a token of its own. Restricted to
 * phraseBias entries that actually resolved to real tokens: a phrase that
 * never tokenized (`rejected`) already blocks the resolution on its own
 * account and contests no real token here to collide over. Skips a pair
 * whose weights already agree (finding H): both bannedStrings' fixed
 * minimum weight and a phraseBias entry's own configured weight happening
 * to coincide is not a contradiction — `settleTokenOwnership` never flags
 * mere agreement as a conflict, and writing an identical weight again would
 * decide nothing it would not already leave alone; refusing a save every
 * other preset accepts, over two entries that agree, would be user-hostile.
 *
 * Borrows only the token belonging to *each specific overlapping variant
 * text*, not a colliding candidate's whole token set (issue #311 review,
 * round seven, over-borrowing bug — found independently by two structural
 * reviews in the same round; a version between finding N and this fix
 * pushed `candidate.tokenIds` whole once any overlap existed at all).
 * Failing case: profile `phraseBias: ["ember"@5]`, story
 * `bannedStrings: ["Ember"]`. `"ember"`'s own four variants resolve to four
 * distinct tokens (typed, leading-space, capitalized, leading-space-
 * capitalized); `"Ember"`'s own four variants collapse to two distinct
 * texts, `"Ember"` and `" Ember"` (it is already capitalized, so its own
 * "capitalized" and "leading-space-capitalized" variants repeat the
 * "typed"/"leading-space" text). The two entries share exactly those two
 * texts — the lowercase `"ember"`/`" ember"` tokens are never named by the
 * banned string at all. Pushing the candidate's whole token set claimed all
 * four; `realOnlyViews` (`resolveSamplingLogitBias` above) then saw every
 * one of them as backed partly by a synthetic write and dropped all four
 * from `logit_bias`, silently deleting the writer's lowercase-form bias
 * that the banned string never contested. Intersecting on the shared texts
 * and reading each one's own token off `tokenIdByVariantText` keeps the fix
 * to exactly the tokens actually named.
 */
function collidingPhraseBiasTokens(
  entry: ScopedSamplingBiasEntry,
  candidates: readonly SamplingBiasPhraseCandidate[]
): readonly (readonly number[])[] {
  const entryVariants = surfaceVariantTexts(entry.phrase);
  const collisions: (readonly number[])[] = [];
  for (const candidate of candidates) {
    if (candidate.entry.weight === entry.weight) continue;
    const sharedTokenIds = [...new Set(entryVariants.flatMap((text) => {
      const tokenId = candidate.tokenIdByVariantText.get(text);
      return tokenId === undefined ? [] : [tokenId];
    }))];
    if (sharedTokenIds.length > 0) collisions.push(sharedTokenIds);
  }
  return collisions;
}

/**
 * Builds a `SamplingBiasWrite` for every real token a native banned string
 * (issue #311) is contesting — issue #311 review, third pass, findings G/H.
 * A native banned string never tokenizes, so it has no real token of its
 * own; borrowing a colliding phraseBias entry's own resolved tokens
 * (`collidingPhraseBiasTokens`'s precomputed result, `collisionsByBannedString`,
 * index-aligned with `bannedStrings`) is what lets
 * `collectOwnership`/`settleTokenOwnership` — already exhaustively tested
 * for scope-major precedence, same-scope-versus-cross-scope, and weight
 * *agreement* never being a conflict — decide who wins exactly the way they
 * already decide it for every other collision, instead of a second,
 * hand-rolled copy of that logic that could quietly disagree with the
 * first. That is exactly what happened the first time: the same-scope half
 * of that hand-rolled copy worked, but its cross-scope half was silently
 * absent, so a profile phraseBias entry and a story bannedStrings entry
 * over the same word both shipped, unflagged, on KoboldCpp, while every
 * other preset already refuses (or, cross-scope, overrides) the identical
 * pair.
 */
function nativeBannedStringWrites(
  bannedStrings: readonly ScopedSamplingBiasEntry[],
  collisionsByBannedString: readonly (readonly (readonly number[])[])[]
): readonly SamplingBiasWrite[] {
  const writes: SamplingBiasWrite[] = [];
  bannedStrings.forEach((entry, index) => {
    for (const tokenIds of collisionsByBannedString[index]!) {
      for (const tokenId of tokenIds) {
        writes.push({
          tokenId,
          weight: entry.weight,
          scope: entry.scope,
          owner: { source: "bannedStrings", scope: entry.scope, phrase: entry.phrase }
        });
      }
    }
  });
  return writes;
}

/**
 * Classifies every native banned string against the same ownership views
 * its own borrowed writes (`nativeBannedStringWrites` above) already fed
 * into `collectOwnership` — by asking `tokenOwnershipVerdict` the exact
 * question it already answers for a real, tokenized entry, rather than a
 * parallel re-implementation of "who wins" (issue #311 review, third pass,
 * findings G/H, and O for `tokenOwnershipVerdict` itself). A banned string
 * with no collision borrows no tokens at all and stays "native" by
 * construction, with no verdict call needed. One that does collide is
 * scored over its borrowed tokens, and the real verdict is translated into
 * this type's own vocabulary: "kept" (this banned string is the sole or
 * winning claim on every token it borrowed) becomes "native" — it ships as
 * literal text; "shadowed" (same-scope disagreement) becomes "blocked" —
 * refuses the whole resolution, the same as a real shadowed entry does, via
 * `firstBlockedNativeBannedString`; "overridden" (cross-scope loss) stays
 * "overridden" — non-blocking, excluded from `banned_tokens` the same way a
 * losing phraseBias entry's own token is excluded from `logit_bias`
 * (`resolveSamplingLogitBias` above). The verdict's own `conflicts[0]` names
 * the actual winner via `SamplingBiasShadowOwner` — not necessarily the
 * first phraseBias candidate `collidingPhraseBiasTokens` happened to scan —
 * which can be a different banned string, or an explicit numeric
 * `logitBias` entry, exactly as for a real "shadowed"/"overridden" entry;
 * always present when the verdict is not "kept" (`tokenOwnershipVerdict`
 * only returns "shadowed"/"overridden" with at least one lost token).
 */
function classifyNativeBannedStrings(
  bannedStrings: readonly ScopedSamplingBiasEntry[],
  collisionsByBannedString: readonly (readonly (readonly number[])[])[],
  views: SamplingBiasOwnershipViews
): readonly SamplingBiasNativeBannedStringResolution[] {
  return bannedStrings.map((entry, index): SamplingBiasNativeBannedStringResolution => {
    const borrowedTokens = new Set<number>();
    for (const tokenIds of collisionsByBannedString[index]!) {
      for (const tokenId of tokenIds) borrowedTokens.add(tokenId);
    }
    if (borrowedTokens.size === 0) return { kind: "native", phrase: entry.phrase, scope: entry.scope };
    const verdict = tokenOwnershipVerdict([...borrowedTokens], entry.scope, entry.weight, views);
    if (verdict.kind === "kept") return { kind: "native", phrase: entry.phrase, scope: entry.scope };
    const conflict = verdict.conflicts[0]!.owner;
    return verdict.kind === "shadowed"
      ? { kind: "blocked", phrase: entry.phrase, scope: entry.scope, conflict }
      : { kind: "overridden", phrase: entry.phrase, scope: entry.scope, conflict };
  });
}

function surfaceVariantTexts(phrase: string): readonly string[] {
  return SAMPLING_BIAS_VARIANT_VALUES.map((variant) => samplingBiasVariantText(phrase, variant));
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
  const verdict = tokenOwnershipVerdict(resolution.tokenIds, resolution.scope, ownWeight, views);
  if (verdict.kind === "kept") return resolution;
  return {
    kind: verdict.kind,
    phrase: resolution.phrase,
    scope: resolution.scope,
    variants: resolution.variants,
    tokenIds: resolution.tokenIds,
    conflicts: verdict.conflicts
  };
}

/** Whether a set of real tokens, all claimed at `ownWeight` by one scoped
 * entry, kept that weight in the merged map, or lost it — and, when it
 * lost, to whom (issue #311 review, third pass, finding O). This is the
 * actual decision `settleTokenOwnership` above makes; that function is now
 * a thin wrapper pasting the verdict back onto a `SamplingBiasEntryResolution`,
 * because it has one, real, tokenized caller. `classifyNativeBannedStrings`
 * below is a second, honest caller that has no `SamplingBiasEntryResolution`
 * of its own to paste onto — a native banned string's borrowed tokens never
 * went through `resolveEntry`, so it has no `variants` to carry and no
 * business constructing a fake "resolved" one just to satisfy
 * `settleTokenOwnership`'s parameter type. Calling this directly instead
 * removes that fabrication, along with the two guards it forced
 * `classifyNativeBannedStrings` to carry for a "rejected" outcome this
 * function can never actually produce from a "resolved"-shaped input. */
type SamplingBiasTokenVerdict =
  | { readonly kind: "kept" }
  | { readonly kind: "shadowed"; readonly conflicts: readonly SamplingBiasShadowConflict[] }
  | { readonly kind: "overridden"; readonly conflicts: readonly SamplingBiasShadowConflict[] };

function tokenOwnershipVerdict(
  tokenIds: readonly number[],
  scope: SamplingBiasScope,
  ownWeight: number,
  views: SamplingBiasOwnershipViews
): SamplingBiasTokenVerdict {
  const ownScope = views.byScope[scope];
  const lostInScope = tokenIds.filter((tokenId) => ownScope.weightByToken[String(tokenId)] !== ownWeight);
  if (lostInScope.length > 0) {
    return {
      kind: "shadowed",
      conflicts: lostInScope.map((tokenId) => ({ tokenId, owner: shadowOwnerFor(tokenId, ownScope.ownerByToken) }))
    };
  }
  const lostOverall = tokenIds.filter((tokenId) => views.combined.weightByToken[String(tokenId)] !== ownWeight);
  if (lostOverall.length === 0) return { kind: "kept" };
  return {
    kind: "overridden",
    conflicts: lostOverall.map((tokenId) => ({ tokenId, owner: shadowOwnerFor(tokenId, views.combined.ownerByToken) }))
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

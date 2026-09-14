import {
  promptBiasTokenizerEncoding,
  samplingBiasPresetRules,
  samplingBiasVariantText,
  SAMPLING_BIAS_VARIANT_VALUES,
  type PromptBiasEncoding,
  type SamplingBiasPresetRules,
  type SamplingBiasResolutionResult,
  type SamplingBiasVariantOutcome
} from "../shared/sampling-capabilities.js";
import {
  SAMPLING_BANNED_STRINGS_POLICY,
  SAMPLING_PHRASE_BIAS_POLICY
} from "../shared/sampling-validation-policy.js";
import type { SamplingSettingsV2 } from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";
import { hasUnpairedSurrogate, unicodeScalarLength } from "../shared/unicode.js";
import {
  combineSamplingBiasSources,
  resolveSamplingLogitBias,
  type SamplingBiasMergeInput,
  type StorySamplingRequest
} from "../shared/sampling-phrase-merge.js";
export {
  combineSamplingBiasSources,
  normalizeStorySamplingBias,
  resolveSamplingLogitBias,
  storySamplingBias
} from "../shared/sampling-phrase-merge.js";
export type {
  ScopedSamplingBiasEntry,
  SamplingBiasMergeInput,
  StorySamplingBias,
  StorySamplingRequest
} from "../shared/sampling-phrase-merge.js";
import { ServiceError } from "./errors.js";
import { promptBiasEncoderAvailable, tokenizePhraseTokenIds } from "./openai-prompt-tokenizer.js";
import { probeKoboldCppTokenize, probeLlamaCppTokenize, stripKoboldCppBosPrefix } from "./context-probe.js";
import { providerRuntimeFor } from "./provider-runtime.js";

type SyncVariantTokenizer = (text: string) => SamplingBiasVariantOutcome;
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
 * fast. "llama-cpp" and "koboldcpp" share one live-probe branch below
 * (`resolveWithLiveProbe` — issue #311, second pass, finding D unified what
 * used to be two branches: llama-cpp inline here, koboldcpp through its own
 * copy three functions down, duplicating the exact shape
 * `liveProbeVariantTokenizer` was generalized over `probe` to avoid). Every
 * other preset has no tokenizer strategy at all: "tokenizer-unavailable"
 * whenever phraseBias or bannedStrings is non-empty, matching what
 * resolveSamplingKnob already reports as unavailable for those presets
 * ahead of reaching here.
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
  if (
    settings.provider !== "openai-compatible"
    && settings.provider !== "text-completion"
  ) {
    return { kind: "tokenizer-unavailable", cause: "model-unknown" };
  }
  const runtime = providerRuntimeFor(settings);
  if (runtime.preset === "openai") {
    return resolveSamplingLogitBiasForEncoding(combined, promptBiasTokenizerEncoding(settings.model));
  }
  if (runtime.preset === "llama-cpp" || runtime.preset === "koboldcpp") {
    return await resolveWithLiveProbe(combined, runtime.preset, settings, signal);
  }
  return { kind: "tokenizer-unavailable", cause: "model-unknown" };
}

/**
 * llama.cpp and KoboldCpp both resolve phraseBias by asking that server to
 * tokenize, live, once per distinct surface-variant text
 * (`liveProbeVariantTokenizer` below) instead of trusting a reported model
 * name — the one thing that makes them a shared branch at all. `rules`
 * (`samplingBiasPresetRules`, shared/sampling-phrase-resolution.ts) is where
 * every *flat-value* respect they differ in is captured, computed once here
 * from `preset` and read wherever this function or `resolveSamplingLogitBias`
 * needs one of those differences, rather than duplicated:
 *
 * - `rules.bannedStringsTransport`: llama.cpp documents no native
 *   banned-string field, so its bannedStrings resolves through the exact
 *   same token-ID merge phraseBias does ("token"). KoboldCpp's
 *   `banned_tokens` takes literal phrase text and needs no tokenizer at all
 *   ("native") — pushed into `resolveSamplingLogitBias` itself (issue #311,
 *   second pass, finding D), not applied to its output the way an earlier
 *   version of this function did, so `probeInput` below only has to decide
 *   what to *probe*, never what to report.
 * - `rules.rejectSpecialTokenSyntax`: KoboldCpp only — see
 *   `SPECIAL_TOKEN_SYNTAX`'s own comment for why llama.cpp needs no
 *   equivalent guard: its own probe already asks the documented
 *   `parse_special: false` and gets a verified answer. Passed through to
 *   `resolveSamplingLogitBias` itself, not applied here (issue #311 review,
 *   third pass, finding M) — that is the one merge function demo mode's own
 *   preview also calls, so a preset-derived rule enforced there, not inside
 *   the live-probe layer demo never reaches, is what lets demo inherit it
 *   automatically instead of missing it a fourth time.
 * - `rules.serializeLiveProbe`: caps `liveProbeVariantTokenizer`'s own
 *   fan-out at 1 for KoboldCpp instead of `LIVE_TOKENIZE_PROBE_CONCURRENCY`
 *   — see that function's own comment for why (issue #311 review, round
 *   seven).
 *
 * Which endpoint answers is decided on `preset` directly, right below, not
 * through `rules`: choosing between `koboldCppLiveTokenizeProbe` (below —
 * prefix-calibrated per issue #311's original finding, and its own probes
 * serialized per server against KoboldCpp's shared tokenize buffer, see
 * `withKoboldCppTokenCountLock`, server/context-probe.ts) and
 * `probeLlamaCppTokenize` means picking a whole function, not a flat value
 * `SamplingBiasPresetRules` can carry — and `preset` is already this
 * function's own parameter, so nothing is gained by re-deriving the same
 * fact from `rules` instead. An earlier version of this function did route
 * this decision through a `rules` field (`serializeLiveProbe`, doing double
 * duty as both "which probe" and a false claim about serialization it did
 * not control — two independent structural reviews caught that the field
 * governed nothing about serialization at all, since
 * `postKoboldCppTokenCount` already serializes unconditionally); reverted
 * to `preset` once `serializeLiveProbe` took on its real, current job of
 * capping fan-out instead.
 *
 * A writer who configured only bannedStrings on KoboldCpp must not have
 * their request blocked by an unreachable server that a text-only ban never
 * needed to ask anything of — `probeInput` already dropped bannedStrings for
 * a native-transport preset, so checking it alongside phraseBias below
 * reduces exactly to "is there anything left to probe at all".
 */
async function resolveWithLiveProbe(
  combined: SamplingBiasMergeInput,
  preset: "llama-cpp" | "koboldcpp",
  settings: GenerationSettings,
  signal: AbortSignal | undefined
): Promise<SamplingBiasResolutionResult> {
  const rules = samplingBiasPresetRules(preset);
  const probeInput: SamplingBiasMergeInput = rules.bannedStringsTransport === "native"
    ? { ...combined, bannedStrings: [] }
    : combined;
  if (probeInput.phraseBias.length === 0 && probeInput.bannedStrings.length === 0) {
    return resolveSamplingLogitBias(combined, neverCalledTokenizer, rules);
  }
  const probe = preset === "koboldcpp"
    ? await koboldCppLiveTokenizeProbe(settings, signal)
    : probeLlamaCppTokenize;
  if (typeof probe !== "function") return { kind: "tokenizer-unavailable", cause: probe };
  const tokenizer = await liveProbeVariantTokenizer(probeInput, probe, settings, rules, signal);
  return tokenizer === null
    ? { kind: "tokenizer-unavailable", cause: "probe-failed" }
    : resolveSamplingLogitBias(combined, tokenizer, rules);
}

/**
 * Builds a `LiveTokenizeProbe` for KoboldCpp's `/api/extra/tokencount`, or
 * reports why one cannot be built — the calibrate-and-strip fix for the
 * BOS-prefix problem `probeKoboldCppTokenize` (server/context-probe.ts)
 * documents on itself: that endpoint's documented example shows `ids`
 * beginning with the model's BOS token, so a single-token phrase comes back
 * as two IDs on any BOS-adding build (the normal case) and every surface
 * variant misclassifies multi-token.
 *
 * Tokenizes the empty string exactly once here — before the batch of
 * surface-variant probes in `liveProbeVariantTokenizer` starts, not once per
 * phrase — and treats whatever `ids` comes back as this build's
 * unconditional prefix (self-calibrating: a build that adds no BOS reports
 * an empty prefix and every subsequent strip is a no-op; a build that adds
 * one, or more than one, is handled the same way without 1667 ever knowing
 * which token ID is BOS for this model). Every later call strips that same
 * prefix (`stripKoboldCppBosPrefix`) before the caller classifies the
 * result.
 *
 * The calibration probe's own outcome already distinguishes "failed" from
 * "no-ids" (`KoboldCppTokenizeProbeResult`) — surfaced here as the two
 * `TokenizerUnavailableCause`s that already exist for exactly this
 * distinction, rather than collapsing both into "probe-failed" the way an
 * earlier version of this fix did: a build old enough to answer without
 * `ids` answered, so "no-token-ids" is the honest cause, not a claim about
 * its network (issue #311 review, second pass, finding E).
 *
 * A per-phrase call that itself comes back "no-ids" or "failed" — as
 * opposed to the calibration call, checked here — is mapped to `null` by
 * the returned closure, the same generic "probe-failed" every other
 * `LiveTokenizeProbe` failure already reports: calibration having already
 * confirmed this build *does* answer with `ids`, a later call losing that
 * is a transport hiccup, not evidence about the build itself.
 */
async function koboldCppLiveTokenizeProbe(
  settings: GenerationSettings,
  signal: AbortSignal | undefined
): Promise<LiveTokenizeProbe | "probe-failed" | "no-token-ids"> {
  const calibration = await probeKoboldCppTokenize(settings, "", signal);
  if (calibration.kind === "failed") return "probe-failed";
  if (calibration.kind === "no-ids") return "no-token-ids";
  const prefix = calibration.ids;
  return async (probeSettings, text, probeSignal) => {
    const result = await probeKoboldCppTokenize(probeSettings, text, probeSignal);
    return result.kind === "ok" ? stripKoboldCppBosPrefix(result.ids, prefix) : null;
  };
}

/** A local server answering a handful of small POSTs in parallel is normal;
 * an unbounded burst against it (a full 256-entry list times four variants)
 * is not a request 1667 should make in one breath. The ceiling for a preset
 * whose probe answers independently per call — llama.cpp. KoboldCpp caps at
 * 1 instead (`SamplingBiasPresetRules.serializeLiveProbe`,
 * shared/sampling-phrase-resolution.ts) — see `liveProbeVariantTokenizer`
 * below for why fanning out against KoboldCpp's own serialized endpoint is
 * actively harmful, not merely unnecessary (issue #311 review, round
 * seven). */
const LIVE_TOKENIZE_PROBE_CONCURRENCY = 8;

/** One text tokenized against a live server, returning its token IDs or null
 * on failure — the shape `probeLlamaCppTokenize` (server/context-probe.ts)
 * already has, and `koboldCppLiveTokenizeProbe` above builds for KoboldCpp
 * (that preset's own `probeKoboldCppTokenize` answers a richer, three-way
 * result — server/context-probe.ts's `KoboldCppTokenizeProbeResult` — so it
 * is not, itself, a `LiveTokenizeProbe`; the calibrating closure is). */
type LiveTokenizeProbe = (
  settings: GenerationSettings,
  text: string,
  signal?: AbortSignal
) => Promise<readonly number[] | null>;

/**
 * Text a writer typed that spells special-token control syntax — the bare
 * marker form `<name>`/`<|name|>`/`</name>`/`<|/name|>` common across the
 * model families llama.cpp-based servers most often host (ChatML/Llama-3
 * `<|eot_id|>`/`<|endoftext|>`/`<|im_start|>`; Llama/Mistral `<s>`/`</s>`;
 * Gemma `<end_of_turn>`; and byte/extra-ID markers like `<0x0A>`/
 * `<extra_id_0>`), plus Mistral instruct's `[INST]`/`[/INST]`/
 * `[SYSTEM_PROMPT]` bracket markers. Case-insensitive: a special token's own
 * spelling is fixed by the model, not by whatever case a writer happens to
 * type.
 *
 * Widened from an earlier, narrower alternation that named only the
 * `<|...|>` and `<s>` forms (issue #311 review, third pass, finding K): that
 * version missed the *bare*-angle family entirely — `<end_of_turn>`
 * (Gemma, one of the most commonly self-hosted families on KoboldCpp),
 * `<unk>`, `<eos>`, `<extra_id_0>`, `<0x0A>` all passed it, reaching the
 * probe and, under exactly the unverified premise this guard exists to
 * hedge, could resolve single-token and ship the truncate-every-generation
 * case the guard's own reasoning names. Verified against both the catch
 * list above and the phrases it must leave alone: ordinary prose
 * (`a < b and c > d`), a bracketed word that names neither Mistral marker
 * (`[note]`), and a phrase whose angle brackets do not form one contiguous
 * marker (`x<y|z>w`). It now also rejects `<b>`/`<i>`/`<br>` — implausible
 * phrase-bias entries, and the safe side of the same hedge.
 *
 * Used only to gate `rejectSpecialTokenSyntax` in `resolveSamplingLogitBias`
 * above (issue #311 review, third pass, finding I; enforcement moved there
 * from this function in finding M's fix, so demo mode's own preview — which
 * never calls this function at all — cannot miss it) — never applied to
 * llama.cpp, which already handles this correctly and documented:
 * `probeLlamaCppTokenize` sends `parse_special: false`, which the llama.cpp
 * server README documents as treating special tokens "as plaintext" (see
 * that function's own comment), so a llama.cpp phrase spelling
 * `<|eot_id|>` tokenizes as the ordinary text it is, exactly as typed.
 */
const SPECIAL_TOKEN_SYNTAX = /<\|?\/?[A-Za-z0-9_]+\|?>|\[\/?(?:inst|system_prompt)\]/i;

/** Pre-fetches every distinct surface-variant text the draft needs from a
 * live tokenize probe, then returns a plain synchronous lookup over the
 * results — reusing the exact same merge/reject core (resolveSamplingLogitBias)
 * the local-tokenizer path uses. Returns null when any probe call fails
 * outright: a network or server failure is systemic (the tokenizer is
 * unavailable), not a fact about any one phrase, the same distinction the
 * local WASM tokenizer's load failure already draws.
 *
 * Generalized over `probe` (issue #311) so llama-cpp and KoboldCpp share one
 * implementation instead of two copies that could quietly drift apart —
 * the two presets differ only in which endpoint answers the tokenize call,
 * never in how the results get merged. Carries no special-token guard of
 * its own (issue #311 review, third pass, finding M) — `resolveSamplingLogitBias`
 * enforces `SPECIAL_TOKEN_SYNTAX` above this function's own caller now, the
 * one place every caller with a preset in hand, demo mode included, shares.
 *
 * `rules.serializeLiveProbe` (issue #311 review, round seven, blocker; found
 * independently by two structural reviews) caps the worker pool at 1
 * instead of `LIVE_TOKENIZE_PROBE_CONCURRENCY` — required, not merely
 * tidier, for KoboldCpp: `probe(settings, text, signal)` starts running
 * synchronously up to its own first await, and `postKoboldCppTokenCount`
 * (server/context-probe.ts) registers each call in its per-root
 * serialization lock synchronously too — so all
 * `LIVE_TOKENIZE_PROBE_CONCURRENCY` workers below queue their own call
 * before any of them can settle, let alone fail. `failed`, checked only
 * between one worker's own iterations, could not stop a sibling worker's
 * call that was already queued before the first failure happened: a
 * KoboldCpp server that stopped answering after the calibration probe used
 * to make every one of up to 8 already-queued calls pay its own full
 * `probeTimeoutMs`, one at a time (the very serialization that makes them
 * safe is what makes them run sequentially instead of failing together) —
 * 8x the wait to report "tokenizer-unavailable" where 1 call already proves
 * it. Capping fan-out at 1 means only one call is ever placed, so `failed`
 * stops the loop before a second one queues at all; `postKoboldCppTokenCount`'s
 * own lock becomes a backstop rather than the only thing preventing overlap
 * — still required, since it also covers `countKoboldCpp`
 * (server/tokenize-probe.ts), which shares the same upstream buffer but
 * does not route through this function or its concurrency rule. */
async function liveProbeVariantTokenizer(
  sampling: Pick<SamplingBiasMergeInput, "phraseBias" | "bannedStrings">,
  probe: LiveTokenizeProbe,
  settings: GenerationSettings,
  rules: SamplingBiasPresetRules,
  signal?: AbortSignal
): Promise<SyncVariantTokenizer | null> {
  const texts = new Set<string>();
  for (const entry of sampling.phraseBias) {
    for (const variant of SAMPLING_BIAS_VARIANT_VALUES) texts.add(samplingBiasVariantText(entry.phrase, variant));
  }
  for (const entry of sampling.bannedStrings) {
    for (const variant of SAMPLING_BIAS_VARIANT_VALUES) texts.add(samplingBiasVariantText(entry.phrase, variant));
  }
  const outcomes = new Map<string, SamplingBiasVariantOutcome>();
  const queue = [...texts];
  let failed = false;
  async function worker(): Promise<void> {
    for (;;) {
      const text = queue.pop();
      if (text === undefined || failed) return;
      const tokenIds = await probe(settings, text, signal);
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
  const concurrency = rules.serializeLiveProbe ? 1 : LIVE_TOKENIZE_PROBE_CONCURRENCY;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, worker)
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
      throw new Error(`live tokenize probe never queued ${JSON.stringify(text)}`);
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
    // An older preview can omit its empty raw map. Keep malformed values strict.
    logitBias: record.logitBias === undefined ? {} : parseLogitBiasField(record.logitBias),
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

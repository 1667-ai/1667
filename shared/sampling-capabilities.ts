import {
  SAMPLING_KNOB_V2_VALUES,
  type FeatureSupportV2,
  type SamplingKnobV2,
  type SamplingSettingsV2,
  type SettingsDocumentV2,
  type SettingsPresetV2,
  type SettingsProtocolV2
} from "./settings-v2-types.js";
import type { SelectedSettingsRouteV2 } from "./settings-route.js";
import {
  isLogitBiasFamilyKnob,
  OPENAI_REASONING_FAMILY_MODELS,
  promptBiasTokenizerEncoding
} from "./sampling-phrase-resolution.js";

export { SAMPLING_KNOB_V2_VALUES } from "./settings-v2-types.js";
export type { SamplingKnobV2 } from "./settings-v2-types.js";
// Text-to-token-ID resolution lives in its own module (file-size guideline)
// but stays part of this module's public surface: every existing caller
// imports these names from "sampling-capabilities.js", and there is no
// reason to make them chase a split that is an internal organization
// detail, not a meaning change.
export * from "./sampling-phrase-resolution.js";

/**
 * Sampling capability matrix for the exact endpoints used by 1667.
 *
 * Baseline OpenAI fields: https://platform.openai.com/docs/api-reference/chat/create
 * OpenAI schema: https://github.com/openai/openai-openapi/blob/master/openapi.yaml
 * Anthropic Messages: https://platform.claude.com/docs/en/api/messages
 * llama.cpp: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
 * KoboldCpp: https://github.com/LostRuins/koboldcpp/blob/concedo/embd_res/kcpp_docs.embd
 * LM Studio: https://github.com/lmstudio-ai/docs/blob/main/1_developer/3_openai-compat/chat-completions.md
 * Ollama: https://ollama.readthedocs.io/en/openai/
 */

export interface SamplingContext {
  readonly protocol: SettingsProtocolV2 | "legacy-v1";
  readonly preset: SettingsPresetV2 | "legacy-v1";
  readonly remoteModelId: string;
  readonly temperatureSupport: FeatureSupportV2;
}

export type SamplingUnavailableReason =
  | "legacy-v1"
  | "dry-run"
  | "protocol"
  | "preset-unsupported"
  | "preset-unknown"
  | "model-unsupported"
  | "model-unknown"
  | "no-exact-tokenizer"
  | "reasoning-model"
  | "mirostat-off";

export type SamplingResolution =
  | Readonly<{ kind: "available"; wireField: string }>
  | Readonly<{ kind: "unavailable"; reason: SamplingUnavailableReason }>;

interface SamplingPresentation {
  readonly label: string;
  readonly available: boolean;
  readonly reason: string;
  readonly reasonCompact: string;
}

// phraseBias and bannedStrings never appear on the wire under their own name.
// On every preset but one, both resolve to token IDs and merge into the same
// logit_bias object (server/provider-sampling.ts), so they share logit_bias's
// wire field here. KoboldCpp is the one exception (issue #311):
// PRESET_WIRE_OVERRIDES below redirects its bannedStrings to banned_tokens,
// its native anti-slop field, which takes literal phrase text and needs no
// token resolution at all — see the GenerationInput.banned_tokens
// description quoted further down.
//
// This table models field *names*, not field *shapes* — every preset that
// reaches "available" is assumed to accept the one OpenAI-style logit_bias
// object shape server/provider-sampling.ts always sends for the entries this
// table still routes there. That is a real gap once a preset needs a
// different encoding for the same knob (llama.cpp's native pair-array form
// also accepts raw strings tokenized server-side, with no client
// tokenization at all — issue #311 did not build this; it remains a future
// gap, not a shipped capability). Left as a comment rather than an
// abstraction until a preset actually needs it (issue #282 review round 2,
// finding 2).
const PROTOCOL_WIRE: Readonly<{
  "dry-run": Partial<Record<SamplingKnobV2, string>>;
  "openai-chat-completions": Readonly<Record<SamplingKnobV2, string>>;
  "text-completions": Readonly<Record<SamplingKnobV2, string>>;
  "anthropic-messages": Partial<Record<SamplingKnobV2, string>>;
}> = {
  "dry-run": {},
  "openai-chat-completions": {
    topP: "top_p",
    topK: "top_k",
    minP: "min_p",
    frequencyPenalty: "frequency_penalty",
    presencePenalty: "presence_penalty",
    repeatPenalty: "repeat_penalty",
    seed: "seed",
    stop: "stop",
    logitBias: "logit_bias",
    phraseBias: "logit_bias",
    bannedStrings: "logit_bias",
    dryMultiplier: "dry_multiplier",
    dryBase: "dry_base",
    dryRange: "dry_penalty_last_n",
    dryBreakers: "dry_sequence_breakers",
    xtcThreshold: "xtc_threshold",
    xtcProbability: "xtc_probability",
    dynatempRange: "dynatemp_range",
    mirostat: "mirostat",
    mirostatTau: "mirostat_tau",
    mirostatEta: "mirostat_eta"
  },
  "text-completions": {
    topP: "top_p",
    topK: "top_k",
    minP: "min_p",
    frequencyPenalty: "frequency_penalty",
    presencePenalty: "presence_penalty",
    repeatPenalty: "repeat_penalty",
    seed: "seed",
    stop: "stop",
    logitBias: "logit_bias",
    phraseBias: "logit_bias",
    bannedStrings: "logit_bias",
    dryMultiplier: "dry_multiplier",
    dryBase: "dry_base",
    dryRange: "dry_penalty_last_n",
    dryBreakers: "dry_sequence_breakers",
    xtcThreshold: "xtc_threshold",
    xtcProbability: "xtc_probability",
    dynatempRange: "dynatemp_range",
    mirostat: "mirostat",
    mirostatTau: "mirostat_tau",
    mirostatEta: "mirostat_eta"
  },
  "anthropic-messages": {
    topP: "top_p",
    topK: "top_k",
    stop: "stop_sequences"
  }
};

// The knobs llama.cpp and KoboldCpp document beyond the OpenAI chat-completions
// baseline. `isOpenAiExtension` and `PRESET_EXTENSIONS` both derive from this
// one list so a knob is never an extension in one place and a baseline field
// in the other.
export const SAMPLING_OPENAI_EXTENSION_KNOBS: readonly SamplingKnobV2[] = [
  "topK",
  "minP",
  "repeatPenalty",
  "dryMultiplier",
  "dryBase",
  "dryRange",
  "dryBreakers",
  "xtcThreshold",
  "xtcProbability",
  "dynatempRange",
  "mirostat",
  "mirostatTau",
  "mirostatEta"
];

const SAMPLING_OPENAI_EXTENSION_KNOB_SET: ReadonlySet<SamplingKnobV2> =
  new Set(SAMPLING_OPENAI_EXTENSION_KNOBS);

const PRESET_EXTENSIONS: Readonly<
  Partial<Record<SettingsPresetV2, readonly SamplingKnobV2[]>>
> = {
  "llama-cpp": SAMPLING_OPENAI_EXTENSION_KNOBS,
  "lm-studio": ["topK", "repeatPenalty"],
  koboldcpp: SAMPLING_OPENAI_EXTENSION_KNOBS
};

// One preset spells a field differently from the protocol. KoboldCpp's
// OpenAI-compatible adapter reads `mirostat_mode` and then writes the result
// over `mirostat`, so a request that names `mirostat` arrives as mode 0 and
// the tau and eta beside it do nothing. llama.cpp reads `mirostat` and does
// not know `mirostat_mode`, so the spelling has to follow the preset.
//
// KoboldCpp's `bannedStrings` override (issue #311) is a different kind of
// divergence: not a differently-spelled version of the same field, but a
// genuinely different wire field with a different shape. Every other preset
// merges bannedStrings into the numeric logit_bias map the same as
// phraseBias; KoboldCpp instead sends the literal phrase text to
// `banned_tokens`, its native anti-slop field — see the resolveSamplingKnob
// comment on `needsExactTokenizer` and the transport note on
// PRESET_SUBTRACTIONS below for why, and server/provider-sampling.ts for
// where the two wire fields are actually assembled.
const PRESET_WIRE_OVERRIDES: Readonly<
  Partial<Record<SettingsPresetV2, Partial<Record<SamplingKnobV2, string>>>>
> = {
  koboldcpp: { mirostat: "mirostat_mode", bannedStrings: "banned_tokens" }
};

/** Native text endpoints use their own names instead of chat-adapter names. */
const TEXT_PRESET_WIRE_OVERRIDES: Readonly<
  Partial<Record<SettingsPresetV2, Partial<Record<SamplingKnobV2, string>>>>
> = {
  koboldcpp: {
    repeatPenalty: "rep_pen",
    seed: "sampler_seed",
    stop: "stop_sequence",
    bannedStrings: "banned_tokens"
  }
};

// Ollama's OpenAI-compatible endpoint documents logit_bias as unsupported
// (checklist item left unchecked): https://ollama.readthedocs.io/en/openai/
// phraseBias and bannedStrings ride the same wire field on Ollama (there is
// no wire field to speak of, since the whole family is subtracted), so they
// inherit the subtraction rather than repeating it under a different
// unavailable reason.
//
// The rule below is not "self-hosted" as a label — it is whether 1667 can
// identify the vocabulary that will actually serve the request. There are
// two ways to clear that bar, and each preset below fails both:
//
// 1. A closed allow-list keyed on the reported model ID
//    (promptBiasTokenizerEncoding), for a preset whose reported ID is tied
//    to a fixed, real, first-party endpoint.
// 2. Asking the serving backend itself to tokenize, authoritative by
//    construction (probeLlamaCppTokenize / probeKoboldCppTokenize,
//    server/context-probe.ts), for a preset that exposes such a native side
//    channel.
//
// llama.cpp and KoboldCpp (issue #311) both clear route 2 for phraseBias —
// see the two preset-specific paragraphs below — and are not subtracted for
// it. Every other preset here clears neither:
//
// LM Studio is a self-hosted local server whose operator controls what
// "model" string the API reports, independent of the weights actually
// loaded, and exposes no tokenize side channel 1667 uses.
// `lms load --identifier` sets an arbitrary reported name
// (https://lmstudio.ai/docs/cli/local-models/load).
//
// "custom" carries the same risk in its strongest form: it is by
// definition an arbitrary OpenAI-compatible endpoint at an arbitrary base
// URL — the exact preset a writer uses to point 1667 at a self-hosted
// server that is none of the three named above. A local build told to
// call itself "gpt-4o" would otherwise pass the allow-list and receive
// real OpenAI token IDs for a completely different vocabulary. There is no
// single "custom" endpoint to cite, because there is no fixed endpoint at
// all, and no shared native tokenize route to fall back on either.
//
// "openai" clears route 1: its preset is only ever assigned when the
// connection's base URL actually resolves to its one fixed, real host
// (api.openai.com — see presetFor in shared/settings-basic-draft.ts), so
// the reported model ID is trustworthy against the tiktoken allow-list.
//
// "openrouter" clears neither route, for a reason distinct from the alias
// risk above: OpenRouter routes a given model ID to arbitrary providers and
// model families behind the scenes, so the vocabulary that actually serves
// a request is unknowable client-side even though the base URL itself is
// fixed (openrouter.ai) and the model ID is OpenRouter's own routing key.
// A token ID guessed from that ID could corrupt output on whichever family
// OpenRouter happens to route to. It has no native tokenize side channel
// either, so it is subtracted the same as the self-hosted presets.
//
// llama.cpp's server documents an operator-settable alias the same as the
// self-hosted presets above ("-a, --alias STRING  set model name aliases,
// comma-separated (to be used by API)", tools/server/README.md, --alias),
// so its reported model ID is not trusted for the allow-list either — but
// its native POST /tokenize endpoint tokenizes against whatever model that
// server instance actually has loaded, independent of the reported name,
// which clears route 2 for both phraseBias and bannedStrings there: llama.cpp
// documents no native banned-string field, so bannedStrings still resolves
// through the same token-ID merge as phraseBias, just against the live
// probe instead of the tiktoken allow-list.
//
// KoboldCpp (issue #311) clears route 2 the same way, through its own
// `/api/extra/tokencount` probe (server/context-probe.ts,
// probeKoboldCppTokenize) — its documented response carries `ids` alongside
// the token count. That is what makes phraseBias available here.
//
// KoboldCpp's bannedStrings is available for a different reason that route
// 1/2 framing does not capture: its `banned_tokens` field needs no
// vocabulary trust at all, because it needs no tokenization. KoboldCpp's own
// API document
// (https://github.com/LostRuins/koboldcpp/blob/concedo/embd_res/kcpp_docs.embd)
// describes it, verbatim, on the `GenerationInput` schema `/api/v1/generate`
// and `/api/extra/generate/stream` use: "An array of string sequences, each
// entry represents a word or phrase prevented from being generated, either
// modifying model vocab or by backtracking and regenerating when they
// appear." 1667 never calls either of those native endpoints — it streams
// KoboldCpp through `/v1/chat/completions`, the same OpenAI-compatible
// endpoint it already sends `top_k`, `min_p`, and `repeat_penalty` through,
// none of which is an OpenAI chat-completions field either. Those three
// already reach KoboldCpp's native handler today; that is real evidence
// `banned_tokens` will too, and it is not proof, because the document shows
// no OpenAI-compatible endpoint schema that accepts `banned_tokens` by name.
// The document's own description of `/v1/chat/completions` reads, verbatim:
// "This is an OpenAI compatibility endpoint. ... All KoboldCpp samplers are
// supported, please refer to /api/v1/generate for more details" —
// `banned_tokens` sits in that same GenerationInput schema alongside every
// sampler the document does show passed through, which is why 1667 sends it
// there rather than leaving KoboldCpp's best-documented banned-string
// mechanism unused. It remains an unverified pass-through, never confirmed
// against a running KoboldCpp build (issue #311 review note: a fixture can
// assert 1667's own assumption about the wire shape, not a real server's
// behavior — see test/sampling-e2e-fixtures.ts). A banned string on
// KoboldCpp, like on every other preset, makes the text unlikely, never
// impossible — see the field comment on SamplingSettingsV2.bannedStrings.
//
// logitBias itself is unaffected by any of this: it takes a raw token ID
// the writer already resolved by hand, so it never depends on which
// tokenizer produced it. (Reasoning-family OpenAI models still reject it —
// see the reasoning-family gate in resolveSamplingKnob.)
const PRESET_SUBTRACTIONS: Readonly<
  Partial<Record<SettingsPresetV2, readonly SamplingKnobV2[]>>
> = {
  "lm-studio": ["minP", "phraseBias", "bannedStrings"],
  ollama: ["logitBias", "phraseBias", "bannedStrings"],
  koboldcpp: ["frequencyPenalty"],
  custom: ["phraseBias", "bannedStrings"],
  openrouter: ["phraseBias", "bannedStrings"]
};

function needsExactTokenizer(knob: SamplingKnobV2): boolean {
  return knob === "phraseBias" || knob === "bannedStrings";
}

// Anthropic documents top_p/top_k restrictions by exact model ID. Keep this
// allow-list closed so a new model cannot cause an unexpected 400 response.
const ANTHROPIC_TRUNCATION_SAMPLING: ReadonlySet<string> = new Set([
  "claude-opus-4-5",
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-6"
]);

const KNOB_LABELS: Readonly<Record<SamplingKnobV2, string>> = {
  topP: "top p",
  topK: "top k",
  minP: "min p",
  frequencyPenalty: "frequency penalty",
  presencePenalty: "presence penalty",
  repeatPenalty: "repeat penalty",
  seed: "seed",
  stop: "stop sequences",
  logitBias: "logit bias",
  phraseBias: "phrase bias",
  bannedStrings: "banned strings",
  dryMultiplier: "dry multiplier",
  dryBase: "dry base",
  dryRange: "dry range",
  dryBreakers: "dry breakers",
  xtcThreshold: "xtc threshold",
  xtcProbability: "xtc chance",
  dynatempRange: "dyn temp range",
  mirostat: "mirostat",
  mirostatTau: "mirostat tau",
  mirostatEta: "mirostat eta"
};

export function samplingKnobLabel(knob: SamplingKnobV2): string {
  return KNOB_LABELS[knob];
}

/** Why a knob is unavailable, in one sentence. The server names this in the
 *  request it refuses, and the panel prints it beside the row. One table
 *  holds the words, so a new reason cannot reach one surface and miss another. */
export function samplingUnavailableReason(reason: SamplingUnavailableReason): string {
  return UNAVAILABLE_REASON_TEXT[reason].reason;
}

/** The same fact, in the words a status line has room for. */
export function samplingUnavailableReasonCompact(reason: SamplingUnavailableReason): string {
  return UNAVAILABLE_REASON_TEXT[reason].compact;
}

/** The same fact again, phrased as a clause that follows a knob's name — e.g.
 *  `dry multiplier` + `because this provider does not support it`. Used only
 *  by the server's route-validation error, which names the offending knob
 *  itself before this text. */
export function samplingUnavailableReasonClause(reason: SamplingUnavailableReason): string {
  return UNAVAILABLE_REASON_TEXT[reason].clause;
}

export function samplingContextForRoute(route: SelectedSettingsRouteV2): SamplingContext {
  return {
    protocol: route.connection.protocol,
    preset: route.connection.preset,
    remoteModelId: route.model.remoteId,
    temperatureSupport: route.model.capabilities.temperature
  };
}

export function resolveSamplingKnob(
  context: SamplingContext,
  sampling: SamplingSettingsV2,
  knob: SamplingKnobV2
): SamplingResolution {
  if (context.protocol === "legacy-v1" || context.preset === "legacy-v1") {
    return { kind: "unavailable", reason: "legacy-v1" };
  }
  if (context.protocol === "dry-run" || context.preset === "dry-run") {
    return { kind: "unavailable", reason: "dry-run" };
  }
  if (context.temperatureSupport === "unsupported") {
    return { kind: "unavailable", reason: "model-unsupported" };
  }

  const wireField = PROTOCOL_WIRE[context.protocol][knob];
  if (wireField === undefined) return { kind: "unavailable", reason: "protocol" };

  const subtraction = PRESET_SUBTRACTIONS[context.preset];
  if (subtraction?.includes(knob)) {
    return { kind: "unavailable", reason: "preset-unsupported" };
  }

  if (
    context.protocol === "text-completions"
    && context.preset === "llama-cpp"
    && isLogitBiasFamilyKnob(knob)
  ) {
    return { kind: "unavailable", reason: "preset-unsupported" };
  }
  if (
    (context.protocol === "openai-chat-completions" || context.protocol === "text-completions")
    && isOpenAiExtension(knob)
  ) {
    const extensions = PRESET_EXTENSIONS[context.preset];
    if (!extensions?.includes(knob)) {
      return { kind: "unavailable", reason: "preset-unknown" };
    }
  }

  if (
    context.protocol === "anthropic-messages"
    && (knob === "topP" || knob === "topK")
    && !ANTHROPIC_TRUNCATION_SAMPLING.has(context.remoteModelId)
  ) {
    return { kind: "unavailable", reason: "model-unknown" };
  }

  if (
    context.protocol === "openai-chat-completions"
    && context.preset === "openai"
    && isLogitBiasFamilyKnob(knob)
    && OPENAI_REASONING_FAMILY_MODELS.has(context.remoteModelId)
  ) {
    return { kind: "unavailable", reason: "reasoning-model" };
  }

  // The tiktoken allow-list is the tokenizer authority for every preset
  // that reaches this point except "llama-cpp" and "koboldcpp": every other
  // preset with a trust problem was already subtracted above
  // (PRESET_SUBTRACTIONS), so what is left here is "openai" (a trustworthy
  // reported model ID) and any other preset/protocol combination with no
  // tokenizer strategy at all, both of which the allow-list correctly gates.
  // llama-cpp and KoboldCpp resolve phraseBias through their own live
  // tokenize probe instead (server/context-probe.ts, probeLlamaCppTokenize /
  // probeKoboldCppTokenize), which this synchronous capability check cannot
  // run — that resolution, and its own "tokenizer failed" outcome, happens
  // where the async work already lives: request build time and the editor's
  // resolveSamplingBias preview. KoboldCpp's bannedStrings needs no
  // tokenizer at all (issue #311 — see the PRESET_SUBTRACTIONS comment
  // above), so excluding it here is correct for a different reason than
  // llama-cpp's: not "the check runs elsewhere", but "there is no check to
  // run".
  if (
    context.protocol === "openai-chat-completions"
    && context.preset !== "llama-cpp"
    && context.preset !== "koboldcpp"
    && needsExactTokenizer(knob)
    && promptBiasTokenizerEncoding(context.remoteModelId) === null
  ) {
    return { kind: "unavailable", reason: "no-exact-tokenizer" };
  }

  // Checked last, after every route/protocol/preset check: an unsupported
  // route reports its own reason for mirostat tau/eta too, and only a
  // supported route that has mirostat off falls through to this reason.
  if ((knob === "mirostatTau" || knob === "mirostatEta") && sampling.mirostat === null) {
    return { kind: "unavailable", reason: "mirostat-off" };
  }
  return {
    kind: "available",
    wireField: context.protocol === "text-completions"
      ? TEXT_PRESET_WIRE_OVERRIDES[context.preset]?.[knob] ?? wireField
      : PRESET_WIRE_OVERRIDES[context.preset]?.[knob] ?? wireField
  };
}

export function samplingKnobPresentation(
  context: SamplingContext,
  sampling: SamplingSettingsV2,
  knob: SamplingKnobV2
): SamplingPresentation {
  const resolution = resolveSamplingKnob(context, sampling, knob);
  if (resolution.kind === "available") {
    return {
      label: samplingKnobLabel(knob),
      available: true,
      reason: "This parameter is available.",
      reasonCompact: "available"
    };
  }
  const text = UNAVAILABLE_REASON_TEXT[resolution.reason];
  return {
    label: samplingKnobLabel(knob),
    available: false,
    reason: text.reason,
    reasonCompact: text.compact
  };
}

export function samplingKnobValueIsSet(
  sampling: SamplingSettingsV2,
  knob: SamplingKnobV2
): boolean {
  const value = sampling[knob];
  if (value === null) return false;
  if (typeof value === "number") return true;
  if (Array.isArray(value)) return value.length > 0;
  return Object.keys(value).length > 0;
}

export interface ConfiguredSamplingKnob {
  readonly knob: SamplingKnobV2;
  readonly resolution: SamplingResolution;
}

export function resolveConfiguredSamplingKnobs(
  context: SamplingContext,
  sampling: SamplingSettingsV2
): readonly ConfiguredSamplingKnob[] {
  return SAMPLING_KNOB_V2_VALUES
    .filter((knob) => samplingKnobValueIsSet(sampling, knob))
    .map((knob) => ({ knob, resolution: resolveSamplingKnob(context, sampling, knob) }))
    // `mirostat-off` says the parent knob is off, not that the route refuses
    // the parameter. A knob whose parent is off is not configured for this
    // request — its value stays set for when the parent comes back on — so it
    // is not a validation error and does not belong in the request plan. Every
    // other unavailable reason is still a real refusal and stays in the list.
    .filter(({ resolution }) => !(resolution.kind === "unavailable" && resolution.reason === "mirostat-off"));
}

export function applySamplingSettings(
  document: SettingsDocumentV2,
  sampling: SamplingSettingsV2,
  profileId: string = document.routing.default
): SettingsDocumentV2 {
  const profile = document.profiles[profileId];
  if (profile === undefined) throw new Error(`Sampling route references missing profile ${profileId}`);
  const nextSampling = SAMPLING_KNOB_V2_VALUES.some((knob) => samplingKnobValueIsSet(sampling, knob))
    ? sampling
    : undefined;
  if (samplingSettingsEqual(profile.sampling, nextSampling)) return document;
  const { sampling: _previousSampling, ...withoutSampling } = profile;
  return {
    ...document,
    profiles: {
      ...document.profiles,
      [profileId]: nextSampling === undefined
        ? withoutSampling
        : { ...profile, sampling: nextSampling }
    }
  };
}

function isOpenAiExtension(knob: SamplingKnobV2): boolean {
  return SAMPLING_OPENAI_EXTENSION_KNOB_SET.has(knob);
}

export function samplingSettingsEqual(
  left: SamplingSettingsV2 | undefined,
  right: SamplingSettingsV2 | undefined
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return SAMPLING_KNOB_V2_VALUES.every((knob) => {
    const a = left[knob];
    const b = right[knob];
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every((value, index) => samplingArrayItemEqual(value, b[index]));
    }
    if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
      const leftEntries = Object.entries(a);
      const rightEntries = Object.entries(b);
      return leftEntries.length === rightEntries.length
        && leftEntries.every(([key, value]) =>
          (b as Readonly<Record<string, unknown>>)[key] === value);
    }
    return a === b;
  });
}

/** `stop` and `bannedStrings` hold primitive strings, which compare with
 * `===`. `phraseBias` holds `{ phrase, weight }` value objects that a draft
 * edit always recreates with a fresh reference, so a reference comparison
 * would report every unedited draft as changed. */
function samplingArrayItemEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (
    left !== null && right !== null
    && typeof left === "object" && typeof right === "object"
    && "phrase" in left && "weight" in left
    && "phrase" in right && "weight" in right
  ) {
    const leftEntry = left as { phrase: unknown; weight: unknown };
    const rightEntry = right as { phrase: unknown; weight: unknown };
    return leftEntry.phrase === rightEntry.phrase && leftEntry.weight === rightEntry.weight;
  }
  return false;
}

const UNAVAILABLE_REASON_TEXT: Readonly<Record<SamplingUnavailableReason, {
  readonly reason: string;
  readonly compact: string;
  readonly clause: string;
}>> = {
  "legacy-v1": {
    reason: "Format 1 settings are read-only.",
    compact: "read-only",
    clause: "for read-only format 1 settings"
  },
  "dry-run": {
    reason: "Dry run does not send provider requests.",
    compact: "dry run",
    clause: "for a dry-run connection"
  },
  protocol: {
    reason: "Not supported by this provider.",
    compact: "not supported by provider",
    clause: "because this provider does not support it"
  },
  "preset-unsupported": {
    reason: "Not supported by this provider.",
    compact: "not supported by provider",
    clause: "because this provider does not support it"
  },
  "preset-unknown": {
    reason: "Provider support is unknown.",
    compact: "support unknown",
    clause: "because support is unknown for this provider"
  },
  "model-unsupported": {
    reason: "Not supported by this model.",
    compact: "not supported by model",
    clause: "because this model does not support sampling settings"
  },
  "model-unknown": {
    reason: "Model support is unknown.",
    compact: "model support unknown",
    clause: "because support is unknown for this model"
  },
  "no-exact-tokenizer": {
    reason: "1667 has no exact tokenizer for this model, so it cannot resolve text to token IDs.",
    compact: "no exact tokenizer",
    clause: "for a model with no exact tokenizer"
  },
  "reasoning-model": {
    reason: "This reasoning model rejects logit bias.",
    compact: "reasoning model",
    clause: "for a reasoning model"
  },
  "mirostat-off": {
    reason: "Mirostat is off.",
    compact: "mirostat off",
    clause: "while mirostat is off"
  }
};

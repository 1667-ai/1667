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
  | "reasoning-model";

export type SamplingResolution =
  | Readonly<{ kind: "available"; wireField: string }>
  | Readonly<{ kind: "unavailable"; reason: SamplingUnavailableReason }>;

interface SamplingPresentation {
  readonly label: string;
  readonly available: boolean;
  readonly reason: string;
  readonly reasonCompact: string;
}

// phraseBias and bannedStrings never appear on the wire under their own name:
// both resolve to token IDs and merge into the same logit_bias object
// (server/provider-sampling.ts), so they share logit_bias's wire field here.
const PROTOCOL_WIRE: Readonly<
  Record<SettingsProtocolV2, Partial<Record<SamplingKnobV2, string>>>
> = {
  "dry-run": {},
  "openai-chat-completions": {
    topP: "top_p",
    topK: "top_k",
    minP: "min_p",
    frequencyPenalty: "frequency_penalty",
    presencePenalty: "presence_penalty",
    repeatPenalty: "repeat_penalty",
    stop: "stop",
    logitBias: "logit_bias",
    phraseBias: "logit_bias",
    bannedStrings: "logit_bias"
  },
  "anthropic-messages": {
    topP: "top_p",
    topK: "top_k",
    stop: "stop_sequences"
  }
};

const PRESET_EXTENSIONS: Readonly<
  Partial<Record<SettingsPresetV2, readonly SamplingKnobV2[]>>
> = {
  "llama-cpp": ["topK", "minP", "repeatPenalty"],
  "lm-studio": ["topK", "repeatPenalty"],
  koboldcpp: ["topK", "minP", "repeatPenalty"]
};

// Ollama's OpenAI-compatible endpoint documents logit_bias as unsupported
// (checklist item left unchecked): https://ollama.readthedocs.io/en/openai/
// phraseBias and bannedStrings ride the same wire field, so they inherit the
// subtraction rather than repeating it under a different unavailable reason.
//
// The rule below is not "self-hosted" as a label — it is whether 1667 can
// identify the vocabulary that will actually serve the request. There are
// two ways to clear that bar, and each preset below fails both:
//
// 1. A closed allow-list keyed on the reported model ID
//    (promptBiasTokenizerEncoding), for a preset whose reported ID is tied
//    to a fixed, real, first-party endpoint.
// 2. Asking the serving backend itself to tokenize, authoritative by
//    construction (probeLlamaCppTokenize, server/context-probe.ts),
//    for a preset that exposes such a native side channel.
//
// llama.cpp clears route 2 — see the "llama-cpp" comment below — and is not
// subtracted. Every other preset here clears neither:
//
// KoboldCpp and LM Studio are self-hosted local servers whose operator
// controls what "model" string the API reports, independent of the weights
// actually loaded, and neither exposes a tokenize side channel 1667 uses yet
// (KoboldCpp's `/api/extra/tokencount` is deferred to a follow-up stage).
// LM Studio's `lms load --identifier` sets an arbitrary reported name
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
// which is why it is the one self-hosted preset not subtracted here.
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
  koboldcpp: ["frequencyPenalty", "phraseBias", "bannedStrings"],
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
  stop: "stop sequences",
  logitBias: "logit bias",
  phraseBias: "phrase bias",
  bannedStrings: "banned strings"
};

export function samplingKnobLabel(knob: SamplingKnobV2): string {
  return KNOB_LABELS[knob];
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

  if (context.protocol === "openai-chat-completions" && isOpenAiExtension(knob)) {
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
  // that reaches this point except "llama-cpp": every other preset with a
  // trust problem was already subtracted above (PRESET_SUBTRACTIONS), so
  // what is left here is "openai" (a trustworthy reported model ID) and
  // any other preset/protocol combination with no tokenizer strategy at
  // all, both of which the allow-list correctly gates. llama-cpp resolves
  // phraseBias/bannedStrings through its own live tokenize probe instead
  // (server/context-probe.ts, probeLlamaCppTokenize), which this
  // synchronous capability check cannot run — that resolution, and its own
  // "tokenizer failed" outcome, happens where the async work already
  // lives: request build time and the editor's resolveSamplingBias preview.
  if (
    context.protocol === "openai-chat-completions"
    && context.preset !== "llama-cpp"
    && needsExactTokenizer(knob)
    && promptBiasTokenizerEncoding(context.remoteModelId) === null
  ) {
    return { kind: "unavailable", reason: "no-exact-tokenizer" };
  }
  return { kind: "available", wireField };
}

export function samplingKnobPresentation(
  context: SamplingContext,
  knob: SamplingKnobV2
): SamplingPresentation {
  const resolution = resolveSamplingKnob(context, knob);
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
    .map((knob) => ({ knob, resolution: resolveSamplingKnob(context, knob) }));
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
  return knob === "topK" || knob === "minP" || knob === "repeatPenalty";
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
}>> = {
  "legacy-v1": {
    reason: "Format 1 settings are read-only.",
    compact: "read-only"
  },
  "dry-run": {
    reason: "Dry run does not send provider requests.",
    compact: "dry run"
  },
  protocol: {
    reason: "This protocol does not document this parameter.",
    compact: "not in protocol"
  },
  "preset-unsupported": {
    reason: "This preset does not document this parameter.",
    compact: "not in preset"
  },
  "preset-unknown": {
    reason: "This endpoint does not document extension parameters.",
    compact: "unknown endpoint"
  },
  "model-unsupported": {
    reason: "This model does not declare sampling support.",
    compact: "model unsupported"
  },
  "model-unknown": {
    reason: "This model has no documented support for this parameter.",
    compact: "model unknown"
  },
  "no-exact-tokenizer": {
    reason: "1667 has no exact tokenizer for this model, so it cannot resolve text to token IDs.",
    compact: "no exact tokenizer"
  },
  "reasoning-model": {
    reason: "This reasoning model rejects logit bias.",
    compact: "reasoning model"
  }
};

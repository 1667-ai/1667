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

export { SAMPLING_KNOB_V2_VALUES } from "./settings-v2-types.js";
export type { SamplingKnobV2 } from "./settings-v2-types.js";

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
  | "no-exact-tokenizer";

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
const PRESET_SUBTRACTIONS: Readonly<
  Partial<Record<SettingsPresetV2, readonly SamplingKnobV2[]>>
> = {
  "lm-studio": ["minP"],
  ollama: ["logitBias", "phraseBias", "bannedStrings"],
  koboldcpp: ["frequencyPenalty"]
};

/**
 * Tokenizer encodings 1667 can resolve a text phrase against. tiktoken ships
 * several named encodings; these are the two relevant to the OpenAI model
 * families 1667 routes to.
 */
export type PromptBiasEncoding = "o200k_base" | "cl100k_base";

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
 * the closed allow-list above. Resolution logic (below) turns null into the
 * "no-exact-tokenizer" unavailable reason rather than guessing. */
export function promptBiasTokenizerEncoding(remoteModelId: string): PromptBiasEncoding | null {
  return OPENAI_PROMPT_BIAS_ENCODING.get(remoteModelId) ?? null;
}

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
  }
};

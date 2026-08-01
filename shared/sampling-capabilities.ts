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
  | "model-unknown";

export type SamplingResolution =
  | Readonly<{ kind: "available"; wireField: string }>
  | Readonly<{ kind: "unavailable"; reason: SamplingUnavailableReason }>;

interface SamplingPresentation {
  readonly label: string;
  readonly available: boolean;
  readonly reason: string;
  readonly reasonCompact: string;
}

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
    logitBias: "logit_bias"
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

const PRESET_SUBTRACTIONS: Readonly<
  Partial<Record<SettingsPresetV2, readonly SamplingKnobV2[]>>
> = {
  "lm-studio": ["minP"],
  ollama: ["logitBias"],
  koboldcpp: ["frequencyPenalty"]
};

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
  logitBias: "logit bias"
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
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
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
  }
};

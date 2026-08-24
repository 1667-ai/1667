import type {
  FeatureSupportV2,
  SamplingSettingsV2,
  SettingsPresetV2,
  SettingsProtocolV2
} from "./settings-v2-types.js";
import {
  OPENAI_SAMPLING_RULES,
  resolveReasoningSampling,
  samplingRequestHasAnyValue,
  type ResolvedReasoningSampling
} from "./sampling-capabilities.js";
import { resolveTokenProbabilities } from "./token-probability-capabilities.js";
import {
  GENERATION_EFFORT_V4_VALUES,
  THINKING_MODE_V4_VALUES,
  type GenerationEffortV4,
  type ThinkingModeV4
} from "./settings-v4-types.js";
import { promptCacheAdapter } from "./prompt-cache-capabilities.js";

export const THINKING_MODE_VALUES = THINKING_MODE_V4_VALUES;
export type ThinkingMode = ThinkingModeV4;

export const REASONING_EFFORT_VALUES = GENERATION_EFFORT_V4_VALUES;
export type ReasoningEffort = GenerationEffortV4;

export type ReasoningAdapter =
  | "dry-run"
  | "text-completions"
  | "compatible"
  | "openai-official"
  | "anthropic-official"
  | "openai-subscription"
  | "anthropic-subscription";

export type ReasoningThinkingType = "adaptive" | "manual";

export interface AnthropicReasoningCapability {
  readonly provider: "anthropic";
  readonly model: string;
  readonly thinking: ReasoningThinkingType;
  readonly defaultThinking: "on" | "off";
  readonly disabled: boolean;
  /** Effort values accepted by the model's adaptive request contract. */
  readonly efforts: readonly Exclude<ReasoningEffort, "default" | "minimal">[];
  /** Some exact models accept disabled thinking only with this effort set. */
  readonly disabledEfforts?: readonly Exclude<ReasoningEffort, "default" | "minimal">[];
}

export interface OpenAiReasoningCapability {
  readonly provider: "openai";
  readonly model: string;
  readonly efforts: readonly OpenAiEffort[];
  readonly defaultEffort: OpenAiEffort;
}

export type OpenAiEffort = "none" | Exclude<ReasoningEffort, "default">;

export type ReasoningCapability = AnthropicReasoningCapability | OpenAiReasoningCapability;

export interface ReasoningTarget {
  readonly adapter: ReasoningAdapter;
  readonly protocol: SettingsProtocolV2 | "legacy-v1";
  readonly preset: SettingsPresetV2 | "legacy-v1";
  readonly remoteModelId: string;
  readonly reasoningEffort: FeatureSupportV2;
  readonly temperature?: FeatureSupportV2;
}

export interface ReasoningRequest {
  readonly target: ReasoningTarget;
  readonly effort: ReasoningEffort;
  readonly thinkingMode: ThinkingMode;
  readonly temperature: number | null;
  readonly sampling: SamplingSettingsV2;
  readonly tokenProbabilities: number | null;
  readonly storySampling?: Readonly<{
    readonly phraseBias: boolean;
    readonly bannedStrings: boolean;
  }>;
  readonly reasoningDisplay?: "off" | "marker" | "open";
  readonly keepReasoning?: boolean;
}

export type ReasoningUnavailableReason =
  | "adapter-unsupported"
  | "model-unsupported"
  | "model-unknown"
  | "thinking-mode-unsupported"
  | "effort-unsupported"
  | "pair-unsupported"
  | "sampling-unsupported"
  | "token-probabilities-unsupported";

export interface ReasoningUnavailable {
  readonly kind: "unavailable";
  readonly reason: ReasoningUnavailableReason;
  readonly message: string;
  readonly field?: string;
}

type OpenAiReasoningWireEffort = "none" | Exclude<ReasoningEffort, "default">;
type AnthropicReasoningWireEffort = Exclude<ReasoningEffort, "default" | "minimal">;
type AnthropicThinkingWire = Readonly<{
  readonly type: "adaptive" | "disabled";
  readonly display?: "summarized" | "omitted";
}>;

type OpenAiReasoningWire = {
  readonly kind: "openai";
  /** Direct OpenAI Chat Completions and Pi Codex lowering. */
  readonly openaiEffort?: OpenAiReasoningWireEffort;
  readonly anthropicEffort?: never;
  readonly thinking?: never;
};

type AnthropicReasoningWire = {
  readonly kind: "anthropic";
  readonly openaiEffort?: never;
  /** Direct Anthropic output_config.effort lowering. */
  readonly anthropicEffort?: AnthropicReasoningWireEffort;
  readonly thinking?: AnthropicThinkingWire;
};

type CompatibleReasoningWire =
  | {
      readonly kind: "compatible-openai";
      readonly openaiEffort?: OpenAiReasoningWireEffort;
      readonly anthropicEffort?: never;
      readonly thinking?: never;
    }
  | {
      readonly kind: "compatible-anthropic";
      readonly openaiEffort?: never;
      readonly anthropicEffort?: AnthropicReasoningWireEffort;
      readonly thinking?: never;
    }
  | {
      readonly kind: "compatible";
      readonly openaiEffort?: never;
      readonly anthropicEffort?: never;
      readonly thinking?: never;
    };

type NoReasoningWire = {
  readonly kind: "none";
  readonly openaiEffort?: never;
  readonly anthropicEffort?: never;
  readonly thinking?: never;
};

export type ResolvedReasoningWire =
  | OpenAiReasoningWire
  | AnthropicReasoningWire
  | CompatibleReasoningWire
  | NoReasoningWire;

export interface ResolvedReasoningPolicy {
  readonly kind: "available";
  readonly wire: ResolvedReasoningWire;
  readonly effectiveEffort: ReasoningEffort | "none";
  readonly thinkingOn: boolean;
  readonly allowedSampling: ResolvedReasoningSampling["allowedSampling"];
  readonly omittedSampling: ResolvedReasoningSampling["omittedSampling"];
  readonly temperatureAllowed: ResolvedReasoningSampling["temperatureAllowed"];
  readonly tokenProbabilitiesAllowed: ResolvedReasoningSampling["tokenProbabilitiesAllowed"];
  readonly display?: "summarized" | "omitted";
  readonly capability?: ReasoningCapability;
}

export type ReasoningPolicyResolution = ResolvedReasoningPolicy | ReasoningUnavailable;

const LOW_TO_MAX = ["low", "medium", "high", "xhigh", "max"] as const;
const LOW_TO_MAX_NO_XHIGH = ["low", "medium", "high", "max"] as const;
const LOW_TO_HIGH = ["low", "medium", "high"] as const;

function anthropic(
  model: string,
  thinking: ReasoningThinkingType,
  defaultThinking: "on" | "off",
  efforts: readonly Exclude<ReasoningEffort, "default" | "minimal">[],
  options: Pick<AnthropicReasoningCapability, "disabled" | "disabledEfforts"> = { disabled: true }
): AnthropicReasoningCapability {
  return {
    provider: "anthropic",
    model,
    thinking,
    defaultThinking,
    efforts,
    ...options
  };
}

function openai(
  model: string,
  efforts: readonly OpenAiEffort[],
  defaultEffort: OpenAiEffort
): OpenAiReasoningCapability {
  return { provider: "openai", model, efforts, defaultEffort };
}

export const ANTHROPIC_REASONING_CAPABILITIES: ReadonlyMap<string, AnthropicReasoningCapability> = new Map([
  ["claude-fable-5", anthropic("claude-fable-5", "adaptive", "on", LOW_TO_MAX, { disabled: false })],
  ["claude-mythos-5", anthropic("claude-mythos-5", "adaptive", "on", LOW_TO_MAX, { disabled: false })],
  ["claude-mythos-preview", anthropic("claude-mythos-preview", "adaptive", "on", LOW_TO_MAX_NO_XHIGH, { disabled: false })],
  ["claude-opus-5", anthropic("claude-opus-5", "adaptive", "on", LOW_TO_MAX, {
    disabled: true,
    disabledEfforts: LOW_TO_HIGH
  })],
  ["claude-opus-4-8", anthropic("claude-opus-4-8", "adaptive", "off", LOW_TO_MAX)],
  ["claude-opus-4-7", anthropic("claude-opus-4-7", "adaptive", "off", LOW_TO_MAX)],
  ["claude-sonnet-5", anthropic("claude-sonnet-5", "adaptive", "on", LOW_TO_MAX)],
  ["claude-opus-4-6", anthropic("claude-opus-4-6", "adaptive", "off", LOW_TO_MAX_NO_XHIGH)],
  ["claude-sonnet-4-6", anthropic("claude-sonnet-4-6", "adaptive", "off", LOW_TO_MAX_NO_XHIGH)],
  ["claude-opus-4-5", anthropic("claude-opus-4-5", "manual", "off", LOW_TO_HIGH)],
  ["claude-opus-4-5-20251101", anthropic("claude-opus-4-5-20251101", "manual", "off", LOW_TO_HIGH)],
  ["claude-sonnet-4-5", anthropic("claude-sonnet-4-5", "manual", "off", [])],
  ["claude-sonnet-4-5-20250929", anthropic("claude-sonnet-4-5-20250929", "manual", "off", [])],
  ["claude-haiku-4-5", anthropic("claude-haiku-4-5", "manual", "off", [])],
  ["claude-haiku-4-5-20251001", anthropic("claude-haiku-4-5-20251001", "manual", "off", [])]
]);

export const OPENAI_REASONING_CAPABILITIES: ReadonlyMap<string, OpenAiReasoningCapability> = new Map([
  ["gpt-5.6", openai("gpt-5.6", ["none", "low", "medium", "high", "xhigh", "max"], "medium")],
  ["gpt-5.6-sol", openai("gpt-5.6-sol", ["none", "low", "medium", "high", "xhigh", "max"], "medium")],
  ["gpt-5.6-terra", openai("gpt-5.6-terra", ["none", "low", "medium", "high", "xhigh", "max"], "medium")],
  ["gpt-5.6-luna", openai("gpt-5.6-luna", ["none", "low", "medium", "high", "xhigh", "max"], "medium")],
  ["gpt-5.5", openai("gpt-5.5", ["none", "low", "medium", "high", "xhigh"], "medium")],
  ["gpt-5.4", openai("gpt-5.4", ["none", "low", "medium", "high", "xhigh"], "none")],
  ["gpt-5.4-mini", openai("gpt-5.4-mini", ["none", "low", "medium", "high", "xhigh"], "none")],
  ["gpt-5.4-nano", openai("gpt-5.4-nano", ["none", "low", "medium", "high", "xhigh"], "none")],
  ["gpt-5.2", openai("gpt-5.2", ["none", "low", "medium", "high", "xhigh"], "none")],
  ["gpt-5.2-2025-12-11", openai("gpt-5.2-2025-12-11", ["none", "low", "medium", "high", "xhigh"], "none")],
  ["gpt-5.1", openai("gpt-5.1", ["none", "low", "medium", "high"], "none")],
  ["gpt-5", openai("gpt-5", ["minimal", "low", "medium", "high"], "medium")],
  ["gpt-5-mini", openai("gpt-5-mini", ["minimal", "low", "medium", "high"], "medium")],
  ["gpt-5-nano", openai("gpt-5-nano", ["minimal", "low", "medium", "high"], "medium")]
]);

const SUBSCRIPTION_OPENAI_REASONING_MODELS = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra"
] as const;

export const SUBSCRIPTION_REASONING_CAPABILITIES: ReadonlyMap<string, ReasoningCapability> = new Map<string, ReasoningCapability>([
  ["gpt-5.3-codex-spark", openai("gpt-5.3-codex-spark", ["low", "medium", "high", "xhigh"], "medium")],
  ...SUBSCRIPTION_OPENAI_REASONING_MODELS.map((model) => [
    model,
    OPENAI_REASONING_CAPABILITIES.get(model)!
  ] as const),
  ...[...ANTHROPIC_REASONING_CAPABILITIES.entries()].map(([model, capability]) => [model, capability] as const)
]);

export function reasoningAdapterFor(
  protocol: SettingsProtocolV2 | "legacy-v1",
  preset: SettingsPresetV2 | "legacy-v1",
  baseUrl: string | null
): ReasoningAdapter {
  if (protocol === "dry-run") return "dry-run";
  if (protocol === "text-completions") return "text-completions";
  if (protocol === "openai-codex-responses") return "openai-subscription";
  if (protocol === "anthropic-subscription-messages") return "anthropic-subscription";
  if (protocol === "legacy-v1" || preset === "legacy-v1") return "compatible";
  const cacheAdapter = promptCacheAdapter(protocol, preset, baseUrl);
  if (cacheAdapter === "openai-official") return "openai-official";
  if (cacheAdapter === "anthropic-official") return "anthropic-official";
  return "compatible";
}

export function anthropicReasoningCapability(
  adapter: ReasoningAdapter,
  modelId: string
): AnthropicReasoningCapability | undefined {
  if (adapter !== "anthropic-official" && adapter !== "anthropic-subscription") return undefined;
  const direct = ANTHROPIC_REASONING_CAPABILITIES.get(modelId);
  if (direct !== undefined) return direct;
  if (adapter !== "anthropic-subscription") return undefined;
  const subscription = SUBSCRIPTION_REASONING_CAPABILITIES.get(modelId);
  return subscription?.provider === "anthropic" ? subscription : undefined;
}

export function openAiReasoningCapability(
  adapter: ReasoningAdapter,
  modelId: string
): OpenAiReasoningCapability | undefined {
  if (adapter === "openai-official") return OPENAI_REASONING_CAPABILITIES.get(modelId);
  if (adapter === "openai-subscription") {
    const capability = SUBSCRIPTION_REASONING_CAPABILITIES.get(modelId);
    return capability?.provider === "openai" ? capability : undefined;
  }
  return undefined;
}

export function reasoningDisplayFor(request: Pick<ReasoningRequest, "reasoningDisplay" | "keepReasoning">): "summarized" | "omitted" {
  return request.reasoningDisplay !== "off" || request.keepReasoning !== false
    ? "summarized"
    : "omitted";
}

function unavailable(
  reason: ReasoningUnavailableReason,
  message: string,
  field?: string
): ReasoningUnavailable {
  return { kind: "unavailable", reason, message, ...(field === undefined ? {} : { field }) };
}

function samplingPolicy(
  request: ReasoningRequest,
  provider: "openai" | "anthropic" | "compatible" | "none",
  effectiveEffort: ReasoningEffort | "none",
  thinkingOn: boolean
): ResolvedReasoningSampling | ReasoningUnavailable {
  const result = resolveReasoningSampling({
    provider,
    remoteModelId: request.target.remoteModelId,
    effectiveEffort,
    thinkingOn,
    temperature: request.temperature,
    sampling: request.sampling,
    tokenProbabilities: request.tokenProbabilities,
    storySampling: request.storySampling
  });
  return result.kind === "unavailable"
    ? unavailable("sampling-unsupported", result.message, result.field)
    : result;
}

function basePolicyFor(
  request: ReasoningRequest,
  provider: "openai" | "anthropic" | "compatible" | "none",
  effectiveEffort: ReasoningEffort | "none",
  thinkingOn: boolean,
  wire: ResolvedReasoningWire
): ReasoningPolicyResolution {
  const sampling = samplingPolicy(request, provider, effectiveEffort, thinkingOn);
  return sampling.kind === "unavailable"
    ? sampling
    : basePolicy(request, effectiveEffort, thinkingOn, sampling, wire);
}

function compatiblePolicy(request: ReasoningRequest): ReasoningPolicyResolution {
  const { target } = request;
  if (target.protocol === "anthropic-messages"
    && request.temperature !== null
    && request.sampling.topP !== null) {
    return unavailable(
      "sampling-unsupported",
      "Compatible Anthropic requests cannot combine temperature with top p.",
      "sampling"
    );
  }
  if (target.reasoningEffort !== "supported") {
    if (request.effort !== "default" || request.thinkingMode !== "default") {
      return unavailable("model-unsupported", "The selected model does not support reasoning controls.");
    }
    return basePolicyFor(request, "compatible", "default", false, { kind: "compatible" });
  }
  if (target.protocol === "anthropic-messages" || target.protocol === "anthropic-subscription-messages") {
    if (request.thinkingMode !== "default") {
      return unavailable("thinking-mode-unsupported", "Thinking Mode is unavailable for this compatible Anthropic model.", "thinkingMode");
    }
    const effort = request.effort;
    if (!(["default", "low", "medium", "high"] as readonly string[]).includes(effort)) {
      return unavailable("effort-unsupported", "This compatible Anthropic model supports only default, low, medium, and high effort.", "effort");
    }
    return basePolicyFor(
      request,
      "compatible",
      effort,
      effort !== "default",
      effort === "default"
        ? { kind: "compatible" }
        : { kind: "compatible-anthropic", anthropicEffort: effort as AnthropicReasoningWireEffort }
    );
  }
  if (request.thinkingMode === "on") {
    return unavailable("thinking-mode-unsupported", "Thinking Mode on is unavailable for this compatible model.", "thinkingMode");
  }
  if (request.thinkingMode === "off" && request.effort !== "default") {
    return unavailable("pair-unsupported", "Thinking Mode off requires default effort on a compatible model.");
  }
  const effort = request.effort;
  if (!["default", "low", "medium", "high"].includes(effort)) {
    return unavailable("effort-unsupported", "This compatible model supports only default, low, medium, and high effort.", "effort");
  }
  const effective = request.thinkingMode === "off" ? "default" : effort;
  return basePolicyFor(
    request,
    "compatible",
    effective,
    effective !== "default",
    request.thinkingMode === "off"
      ? { kind: "compatible-openai", openaiEffort: "none" }
      : effective === "default"
        ? { kind: "compatible" }
        : { kind: "compatible-openai", openaiEffort: effective as OpenAiReasoningWireEffort }
  );
}

function basePolicy(
  request: ReasoningRequest,
  effectiveEffort: ReasoningEffort | "none",
  thinkingOn: boolean,
  sampling: ResolvedReasoningSampling,
  wire: ResolvedReasoningWire
): ResolvedReasoningPolicy {
  return {
    kind: "available",
    wire,
    effectiveEffort,
    thinkingOn,
    allowedSampling: sampling.allowedSampling,
    omittedSampling: sampling.omittedSampling,
    temperatureAllowed: sampling.temperatureAllowed,
    tokenProbabilitiesAllowed: sampling.tokenProbabilitiesAllowed
      && resolveTokenProbabilities({
        protocol: request.target.protocol,
        preset: request.target.preset,
        remoteModelId: request.target.remoteModelId,
        temperatureSupport: request.target.temperature ?? "unknown"
      }).kind === "available"
  };
}

function officialOpenAiPolicy(request: ReasoningRequest): ReasoningPolicyResolution {
  if (request.target.adapter === "openai-official"
    && (request.target.remoteModelId === "gpt-5.5-pro" || request.target.remoteModelId === "gpt-5.4-pro")) {
    return unavailable(
      "adapter-unsupported",
      "The direct OpenAI Chat Completions adapter does not support this exact model.",
      "model"
    );
  }
  // An explicit persisted "unsupported" capability is stronger than the
  // closed reasoning catalog. It still permits the predecessor's default
  // request, but an exact sampling-catalog row remains authoritative. It never
  // permits a new reasoning control to be inferred for an unknown exact model.
  if (request.target.reasoningEffort === "unsupported"
    && (request.effort !== "default" || request.thinkingMode !== "default")) {
    return unavailable("model-unsupported", "The selected model explicitly disables reasoning controls.");
  }
  if (request.target.reasoningEffort === "unsupported") {
    return basePolicyFor(
      request,
      OPENAI_SAMPLING_RULES.has(request.target.remoteModelId) ? "openai" : "none",
      "none",
      false,
      { kind: "none" }
    );
  }
  const capability = openAiReasoningCapability(request.target.adapter, request.target.remoteModelId);
  if (capability === undefined) {
    if (request.effort === "default" && request.thinkingMode === "default"
      && request.temperature === null
      && request.tokenProbabilities === null
      && !samplingRequestHasAnyValue(request.sampling, request.storySampling)) {
      return basePolicyFor(request, "none", "default", false, { kind: "none" });
    }
    return unavailable("model-unknown", "The exact OpenAI model is not in the capability catalog.");
  }
  const effort = request.effort;
  if (request.thinkingMode === "on" && effort === "default") {
    return unavailable("pair-unsupported", "Thinking Mode on requires an explicit effort on OpenAI.");
  }
  if (request.thinkingMode === "off" && effort !== "default") {
    return unavailable("pair-unsupported", "Thinking Mode off cannot be combined with an explicit OpenAI effort.");
  }
  if (effort !== "default" && !capability.efforts.includes(effort as never)) {
    return unavailable("effort-unsupported", `The exact OpenAI model does not support effort ${effort}.`, "effort");
  }
  const effectiveEffort = request.thinkingMode === "off" ? "none" : effort === "default" ? capability.defaultEffort : effort;
  if (request.thinkingMode === "off" && !capability.efforts.includes("none")) {
    return unavailable("pair-unsupported", "The exact OpenAI model does not support disabled reasoning.");
  }
  const openaiEffort = request.thinkingMode === "off"
    ? "none"
    : effort === "default"
      ? undefined
      : effort === "minimal" ? "minimal" : effort;
  if (request.target.adapter === "openai-subscription"
    && samplingRequestHasAnyValue(request.sampling, request.storySampling)) {
    return unavailable("sampling-unsupported", "The pinned subscription adapter cannot serialize sampling controls.", "sampling");
  }
  return basePolicyFor(
    request,
    "openai",
    effectiveEffort,
    effectiveEffort !== "none",
    openaiEffort === undefined
      ? { kind: "openai" }
      : { kind: "openai", openaiEffort }
  );
}

function officialAnthropicPolicy(request: ReasoningRequest): ReasoningPolicyResolution {
  // See the OpenAI branch: a stored unsupported capability must settle the
  // reasoning decision before an exact-model catalog lookup. The default
  // request remains usable, while explicit reasoning controls still refuse.
  if (request.target.reasoningEffort === "unsupported"
    && (request.effort !== "default" || request.thinkingMode !== "default")) {
    return unavailable("model-unsupported", "The selected model explicitly disables reasoning controls.");
  }
  const capability = anthropicReasoningCapability(request.target.adapter, request.target.remoteModelId);
  if (capability === undefined) {
    if (request.target.reasoningEffort === "unsupported") {
      return basePolicyFor(request, "none", "default", false, { kind: "none" });
    }
    if (request.effort === "default" && request.thinkingMode === "default"
      && request.temperature === null
      && request.tokenProbabilities === null
      && !samplingRequestHasAnyValue(request.sampling, request.storySampling)) {
      return basePolicyFor(request, "none", "default", false, { kind: "none" });
    }
    return unavailable("model-unknown", "The exact Anthropic model is not in the capability catalog.");
  }
  if (request.target.reasoningEffort === "unsupported") {
    return basePolicyFor(request, "anthropic", "default", false, { kind: "none" });
  }
  const effort = request.effort;
  if (effort !== "default" && effort !== "minimal" && !capability.efforts.includes(effort as never)) {
    return unavailable("effort-unsupported", `The exact Anthropic model does not support effort ${effort}.`, "effort");
  }
  if (effort === "minimal") {
    return unavailable("effort-unsupported", "Anthropic does not support minimal effort.", "effort");
  }
  if (request.thinkingMode === "on" && capability.thinking !== "adaptive") {
    return unavailable("thinking-mode-unsupported", "Thinking Mode on is unavailable on this manual-only Anthropic model.", "thinkingMode");
  }
  const offEffortAllowed = request.thinkingMode === "off"
    && capability.disabled
    && (capability.disabledEfforts === undefined
      ? true
      : effort === "default" || capability.disabledEfforts.includes(effort as never));
  if (request.thinkingMode === "off" && !offEffortAllowed) {
    return unavailable("pair-unsupported", "The exact Anthropic model does not accept this Thinking Mode and effort pair.");
  }
  const thinkingOn = request.thinkingMode === "on"
    || (request.thinkingMode === "default" && capability.defaultThinking === "on");
  if (request.target.adapter === "anthropic-subscription"
    && effort !== "default"
    && !thinkingOn) {
    return unavailable(
      "pair-unsupported",
      "The pinned Anthropic subscription adapter cannot serialize effort unless thinking is enabled.",
      "effort"
    );
  }
  const display = thinkingOn ? reasoningDisplayFor(request) : undefined;
  const wire: ResolvedReasoningWire = {
    kind: "anthropic",
    ...(thinkingOn ? { thinking: { type: "adaptive", display } } : request.thinkingMode === "off" ? { thinking: { type: "disabled" } } : {}),
    ...(effort !== "default"
      ? { anthropicEffort: effort as Exclude<ReasoningEffort, "default" | "minimal"> }
      : {})
  };
  const sampling = samplingPolicy(request, "anthropic", effort, thinkingOn);
  if (sampling.kind === "unavailable") return sampling;
  if (request.target.adapter === "anthropic-subscription"
    && samplingRequestHasAnyValue(request.sampling, request.storySampling)) {
    return unavailable("sampling-unsupported", "The pinned subscription adapter cannot serialize sampling controls.", "sampling");
  }
  return {
    ...basePolicy(request, effort, thinkingOn, sampling, wire),
    ...(thinkingOn ? { display } : {}),
    capability
  };
}

/** Resolve one final request. UI, direct adapters, and subscription adapters
 * all call this function; no adapter may infer a second reasoning policy. */
export function resolveReasoningPolicy(request: ReasoningRequest): ReasoningPolicyResolution {
  if (request.target.adapter === "dry-run" || request.target.adapter === "text-completions") {
    if (request.effort !== "default" || request.thinkingMode !== "default") {
      return unavailable("adapter-unsupported", "This provider does not support reasoning controls.");
    }
    if (request.target.adapter === "dry-run"
      && samplingRequestHasAnyValue(request.sampling, request.storySampling)) {
      return unavailable("sampling-unsupported", "Dry run does not send provider requests.", "sampling");
    }
    return basePolicyFor(request, "none", "default", false, { kind: "none" });
  }
  if (request.target.adapter === "compatible") return compatiblePolicy(request);
  if (request.target.adapter === "openai-official" || request.target.adapter === "openai-subscription") {
    return officialOpenAiPolicy(request);
  }
  return officialAnthropicPolicy(request);
}

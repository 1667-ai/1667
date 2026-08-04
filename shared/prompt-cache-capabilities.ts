import type {
  FeatureSupportV2,
  PromptCachePolicyV2,
  SettingsDocumentV2,
  SettingsPresetV2,
  SettingsProtocolV2,
  SettingsRoutePurpose
} from "./settings-v2-types.js";
import {
  resolveSettingsProfile,
  selectSettingsRoute,
  type SelectedSettingsRouteV2
} from "./settings-route.js";
import {
  isOfficialAnthropicBaseUrl,
  isOfficialOpenAiBaseUrl
} from "./settings-provider-defaults.js";

export type PromptCacheAdapter =
  | "legacy-v1"
  | "dry-run"
  | "anthropic-official"
  | "openai-official"
  | "compatible";

export interface PromptCacheContext {
  readonly source: "legacy-v1" | "settings-v2";
  readonly policy: PromptCachePolicyV2;
  readonly support: FeatureSupportV2;
  readonly protocol: SettingsProtocolV2 | "legacy-v1";
  readonly preset: SettingsPresetV2 | "legacy-v1";
  readonly remoteModelId: string;
  readonly adapter: PromptCacheAdapter;
}

export type PromptCacheTokenizer = "o200k_base";
export type PromptCacheWriteMultiplier = 1 | 1.25 | 2;

export type PromptCacheCapability =
  | Readonly<{
      kind: "anthropic-explicit";
      minimumTokens: number;
      autoTtl: "5m";
      longTtl: "1h";
      writeMultiplier: Readonly<{ auto: 1.25; long: 2 }>;
    }>
  | Readonly<{
      kind: "openai-automatic";
      minimumTokens: 1024;
      longRetention: "24h" | null;
      writeMultiplier: Readonly<{ auto: 1; long: 1 }>;
    }>
  | Readonly<{
      kind: "openai-explicit";
      minimumTokens: 1024;
      tokenizer: PromptCacheTokenizer;
      maximumBreakpoints: 4;
      autoTtl: "30m";
      writeMultiplier: Readonly<{ auto: 1.25 }>;
    }>;

export type PromptCacheCapabilityReason =
  | "legacy-v1"
  | "dry-run"
  | "unsupported"
  | "compatible-endpoint"
  | "unknown-model";

export type PromptCacheCapabilityResolution =
  | Readonly<{ kind: "available"; capability: PromptCacheCapability }>
  | Readonly<{ kind: "unavailable"; reason: PromptCacheCapabilityReason }>;

interface PromptCachePolicyPresentationBase {
  readonly policy: PromptCachePolicyV2;
  readonly behavior: string;
  readonly ttl: string;
  readonly compactTtl: string;
  readonly writeCost: string;
}

export type PromptCachePolicyPresentation =
  | Readonly<PromptCachePolicyPresentationBase & {
      available: true;
      writeMultiplier: PromptCacheWriteMultiplier | null;
    }>
  | Readonly<PromptCachePolicyPresentationBase & {
      available: false;
      writeMultiplier: null;
      unavailableReason: string;
      unavailableReasonCompact: string;
    }>;

const OPENAI_EXPLICIT_MODELS = new Set([
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna"
]);

const OPENAI_LEGACY_EXTENDED_MODELS = new Set([
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5.1-chat-latest",
  "gpt-5",
  "gpt-4.1"
]);

const OPENAI_LEGACY_AUTOMATIC_MODELS = new Set([
  ...OPENAI_LEGACY_EXTENDED_MODELS,
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o",
  "gpt-4o-mini"
]);

const ANTHROPIC_MINIMUM_TOKENS = new Map<string, number>([
  ["claude-fable-5", 512],
  ["claude-mythos-5", 512],
  ["claude-mythos-preview", 2_048],
  ["claude-opus-4-8", 1_024],
  ["claude-opus-4-7", 2_048],
  ["claude-opus-4-6", 4_096],
  ["claude-opus-4-5", 4_096],
  ["claude-opus-4-5-20251101", 4_096],
  ["claude-sonnet-5", 1_024],
  ["claude-sonnet-4-6", 1_024],
  ["claude-sonnet-4-5", 1_024],
  ["claude-sonnet-4-5-20250929", 1_024],
  ["claude-haiku-4-5", 4_096],
  ["claude-haiku-4-5-20251001", 4_096]
]);

export function promptCacheAdapter(
  protocol: SettingsProtocolV2,
  preset: SettingsPresetV2,
  baseUrl: string | null
): PromptCacheAdapter {
  if (protocol === "dry-run") return "dry-run";
  if (protocol === "anthropic-messages"
    && preset === "anthropic"
    && isOfficialAnthropicBaseUrl(baseUrl ?? "")) {
    return "anthropic-official";
  }
  if (protocol === "openai-chat-completions"
    && preset === "openai"
    && isOfficialOpenAiBaseUrl(baseUrl ?? "")) {
    return "openai-official";
  }
  return "compatible";
}

export function promptCacheContextForDocument(
  document: SettingsDocumentV2,
  purpose: SettingsRoutePurpose = "default"
): PromptCacheContext {
  return promptCacheContextForRoute(selectSettingsRoute(document, purpose));
}

/** Profile-editor projections already hold a profile identity. Keep that
 * distinct from a routing purpose, whose fallback belongs to route selection. */
export function promptCacheContextForProfile(
  document: SettingsDocumentV2,
  profileId: string
): PromptCacheContext {
  return promptCacheContextForRoute(resolveSettingsProfile(document, profileId));
}

export function promptCacheContextForRoute(
  route: SelectedSettingsRouteV2
): PromptCacheContext {
  const { profile, model, connection } = route;
  return {
    source: "settings-v2",
    policy: profile.cachePolicy,
    support: model.capabilities.promptCaching,
    protocol: connection.protocol,
    preset: connection.preset,
    remoteModelId: model.remoteId,
    adapter: promptCacheAdapter(connection.protocol, connection.preset, connection.baseUrl)
  };
}

export function applyPromptCachePolicy(
  document: SettingsDocumentV2,
  policy: PromptCachePolicyV2,
  profileId: string = document.routing.default
): SettingsDocumentV2 {
  const profile = document.profiles[profileId];
  if (profile === undefined) throw new Error(`Prompt-cache route references missing profile ${profileId}`);
  if (profile.cachePolicy === policy) return document;
  return {
    ...document,
    profiles: {
      ...document.profiles,
      [profileId]: { ...profile, cachePolicy: policy }
    }
  };
}

export function resolvePromptCacheCapability(
  context: PromptCacheContext
): PromptCacheCapabilityResolution {
  if (context.source === "legacy-v1") return { kind: "unavailable", reason: "legacy-v1" };
  if (context.adapter === "dry-run") return { kind: "unavailable", reason: "dry-run" };
  if (context.adapter === "compatible") {
    return { kind: "unavailable", reason: "compatible-endpoint" };
  }
  if (context.support === "unsupported") {
    return { kind: "unavailable", reason: "unsupported" };
  }
  if (context.adapter === "anthropic-official") {
    const minimumTokens = ANTHROPIC_MINIMUM_TOKENS.get(context.remoteModelId);
    return minimumTokens === undefined
      ? { kind: "unavailable", reason: "unknown-model" }
      : {
          kind: "available",
          capability: {
            kind: "anthropic-explicit",
            minimumTokens,
            autoTtl: "5m",
            longTtl: "1h",
            writeMultiplier: { auto: 1.25, long: 2 }
          }
        };
  }
  if (OPENAI_EXPLICIT_MODELS.has(context.remoteModelId)) {
    return {
      kind: "available",
      capability: {
        kind: "openai-explicit",
        minimumTokens: 1_024,
        tokenizer: "o200k_base",
        maximumBreakpoints: 4,
        autoTtl: "30m",
        writeMultiplier: { auto: 1.25 }
      }
    };
  }
  if (OPENAI_LEGACY_AUTOMATIC_MODELS.has(context.remoteModelId)) {
    return {
      kind: "available",
      capability: {
        kind: "openai-automatic",
        minimumTokens: 1_024,
        longRetention: OPENAI_LEGACY_EXTENDED_MODELS.has(context.remoteModelId) ? "24h" : null,
        writeMultiplier: { auto: 1, long: 1 }
      }
    };
  }
  return { kind: "unavailable", reason: "unknown-model" };
}

export function promptCachePolicyPresentation(
  context: PromptCacheContext,
  policy: PromptCachePolicyV2
): PromptCachePolicyPresentation {
  const resolution = resolvePromptCacheCapability(context);
  if (policy === "off") return offPresentation(context, resolution);
  if (resolution.kind === "unavailable") {
    return unavailablePresentation(policy, resolution.reason);
  }
  const capability = resolution.capability;
  if (policy === "long") {
    if (capability.kind === "anthropic-explicit") {
      return {
        policy,
        available: true,
        behavior: cacheablePrefixBehavior(
          "Explicit breakpoint on the last stable prompt block.",
          capability.minimumTokens
        ),
        ttl: "1 hour",
        compactTtl: "1h",
        writeMultiplier: capability.writeMultiplier.long,
        writeCost: writeCost(capability.writeMultiplier.long)
      };
    }
    if (capability.kind === "openai-automatic" && capability.longRetention === "24h") {
      return {
        policy,
        available: true,
        behavior: cacheablePrefixBehavior(
          "Stable routing key with OpenAI automatic prefix caching.",
          capability.minimumTokens
        ),
        ttl: "Up to 24 hours",
        compactTtl: "≤24h",
        writeMultiplier: capability.writeMultiplier.long,
        writeCost: writeCost(capability.writeMultiplier.long)
      };
    }
    return {
      policy,
      available: false,
      behavior: "This model does not support a separate long-retention mode.",
      ttl: "Unavailable",
      compactTtl: "n/a",
      writeMultiplier: null,
      writeCost: "No request will be sent with a downgraded TTL.",
      unavailableReason: "Long retention is not supported for this exact model.",
      unavailableReasonCompact: "No long cache."
    };
  }
  switch (capability.kind) {
    case "anthropic-explicit":
      return {
        policy,
        available: true,
        behavior: cacheablePrefixBehavior(
          "Explicit breakpoint on the last stable prompt block.",
          capability.minimumTokens
        ),
        ttl: "5 minutes",
        compactTtl: "5m",
        writeMultiplier: capability.writeMultiplier.auto,
        writeCost: writeCost(capability.writeMultiplier.auto)
      };
    case "openai-automatic":
      return {
        policy,
        available: true,
        behavior: cacheablePrefixBehavior(
          "Stable routing key with OpenAI automatic prefix caching.",
          capability.minimumTokens
        ),
        ttl: "Provider-managed",
        compactTtl: "provider",
        writeMultiplier: capability.writeMultiplier.auto,
        writeCost: writeCost(capability.writeMultiplier.auto)
      };
    case "openai-explicit": {
      const ttl = openAiExplicitTtl(capability.autoTtl);
      return {
        policy,
        available: true,
        behavior: cacheablePrefixBehavior(
          "Stable routing key and explicit stable-prefix breakpoints only.",
          capability.minimumTokens
        ),
        ttl: ttl.label,
        compactTtl: ttl.compact,
        writeMultiplier: capability.writeMultiplier.auto,
        writeCost: writeCost(capability.writeMultiplier.auto)
      };
    }
  }
}

function cacheablePrefixBehavior(prefix: string, minimumTokens: number): string {
  return `${prefix} Prefixes below ${minimumTokens.toLocaleString("en-US")} tokens are accepted but not cached.`;
}

function offPresentation(
  context: PromptCacheContext,
  resolution: PromptCacheCapabilityResolution
): PromptCachePolicyPresentation {
  if (resolution.kind === "available" && resolution.capability.kind === "openai-explicit") {
    return {
      policy: "off",
      available: true,
      behavior: "OpenAI automatic breakpoints are disabled; no stable breakpoint is sent.",
      ttl: "None",
      compactTtl: "none",
      writeMultiplier: null,
      writeCost: "No 1667 cache writes."
    };
  }
  const providerManaged = context.adapter === "openai-official" || context.adapter === "compatible";
  return {
    policy: "off",
    available: true,
    behavior: providerManaged
      ? "1667 sends no opt-in cache key or breakpoint; provider-managed caching may still occur."
      : "1667 sends no cache controls.",
    ttl: providerManaged ? "Provider-managed" : "None",
    compactTtl: providerManaged ? "provider" : "none",
    writeMultiplier: null,
    writeCost: "No 1667 cache-write opt-in."
  };
}

function unavailablePresentation(
  policy: Exclude<PromptCachePolicyV2, "off">,
  reason: PromptCacheCapabilityReason
): PromptCachePolicyPresentation {
  const explanation: Record<PromptCacheCapabilityReason, string> = {
    "legacy-v1": "Cache policy requires editable format-2 settings.",
    "dry-run": "Dry run never calls a model provider.",
    "unsupported": "Prompt caching is explicitly disabled for this model.",
    "compatible-endpoint": "Prompt caching is not supported by this provider.",
    "unknown-model": "Prompt-cache support is unknown for this model."
  };
  const compactExplanation: Record<PromptCacheCapabilityReason, string> = {
    "legacy-v1": "Use format 2.",
    "dry-run": "No dry-run cache.",
    "unsupported": "Cache disabled.",
    "compatible-endpoint": "Not supported.",
    "unknown-model": "Support unknown."
  };
  return {
    policy,
    available: false,
    behavior: explanation[reason],
    ttl: "Unavailable",
    compactTtl: "n/a",
    writeMultiplier: null,
    writeCost: "No cache controls will be sent.",
    unavailableReason: explanation[reason],
    unavailableReasonCompact: compactExplanation[reason]
  };
}

function writeCost(multiplier: PromptCacheWriteMultiplier): string {
  return multiplier === 1
    ? "No cache-write premium for this model family."
    : `Cache writes cost ${multiplier}× normal input.`;
}

function openAiExplicitTtl(ttl: "30m"): { label: string; compact: string } {
  switch (ttl) {
    case "30m":
      return { label: "At least 30 minutes", compact: "≥30m" };
  }
}

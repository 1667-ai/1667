import type { GenerationSettings, Provider } from "../shared/types.js";
import { applyBasicSettingsDraft } from "../shared/settings-basic-draft.js";
import type {
  ModelConnectionV2,
  SettingsDocumentV2,
  SettingsPresetV2,
  SettingsRoutePurpose
} from "../shared/settings-v2-types.js";
import type { SettingsDocumentV5 } from "../shared/settings-v5-types.js";
import { isSubscriptionProtocolV2 } from "../shared/settings-v2-types.js";
import {
  clampMaxOutputTokensToModel,
  resolveModelScalar,
  type ModelScalarMetadataSourcesV2
} from "../shared/model-scalar-resolution.js";
import {
  defaultConnectionTimeouts,
  defaultModelCapabilities,
  isOfficialAnthropicBaseUrl
} from "../shared/settings-provider-defaults.js";
import {
  lowerPromptCache,
  promptCacheBlockMessage,
  type PromptCacheContext
} from "./provider-cache-policy.js";
import {
  promptCacheContextForRoute
} from "../shared/prompt-cache-capabilities.js";
import { generationEffortAvailabilityForRoute } from "../shared/generation-effort-capabilities.js";
import {
  selectSettingsRoute,
  type SelectedSettingsRouteV2
} from "../shared/settings-route.js";
import { parseGenerationSettingsV1 } from "./settings-v1-codec.js";
import { parseSettingsDocumentV2 } from "./settings-v2-codec.js";
import {
  MAX_SETTINGS_NAME_SCALARS,
  SettingsFormatError
} from "./settings-v2-scalars.js";

export interface EffectiveMetadataV2 extends ModelScalarMetadataSourcesV2 {}

export function convertGenerationSettingsV1(value: GenerationSettings): SettingsDocumentV2 {
  const settings = parseGenerationSettingsV1(value);
  const connection = connectionFromGenerationSettings(settings);
  const modelName = settings.model === ""
    ? connection.name
    : [...settings.model].slice(0, MAX_SETTINGS_NAME_SCALARS).join("");
  return parseSettingsDocumentV2({
    schemaVersion: 2,
    connections: { "migrated:connection": connection },
    models: {
      "migrated:model": {
        connectionId: "migrated:connection",
        remoteId: settings.provider === "dry-run" ? "dry-run" : settings.model,
        name: modelName,
        discovered: {},
        overrides: settings.contextWindow === null ? {} : { contextWindow: settings.contextWindow },
        capabilities: defaultModelCapabilities(settings.provider)
      }
    },
    profiles: {
      default: {
        name: "Default",
        modelId: "migrated:model",
        temperature: settings.temperature,
        maxOutputTokens: settings.maxTokens,
        effort: "default",
        cachePolicy: "off"
      }
    },
    routing: { default: "default" },
    writing: { defaultAuthorBrief: settings.systemPrompt }
  });
}

/** Project one route into the serializable Generation Settings view. */
export function effectiveGenerationView(
  value: SettingsDocumentV2,
  purpose: SettingsRoutePurpose = "default",
  metadata: EffectiveMetadataV2 = {}
): GenerationSettings {
  return projectEffectiveGeneration(value, purpose, metadata).settings;
}

export function projectEffectiveGeneration(
  value: SettingsDocumentV2,
  purpose: SettingsRoutePurpose,
  metadata: EffectiveMetadataV2,
  allowBlankModel = false
) {
  const document = parseSettingsDocumentV2(value);
  return projectEffectiveGenerationAtRoute(
    document.writing.defaultAuthorBrief,
    selectSettingsRoute(document, purpose),
    metadata,
    allowBlankModel
  );
}

/** Project one already selected route without reparsing or applying routing
 * fallback again. */
export function projectEffectiveGenerationFromRoute(
  defaultAuthorBrief: string,
  route: SelectedSettingsRouteV2,
  metadata: EffectiveMetadataV2,
  allowBlankModel = false
) {
  return projectEffectiveGenerationAtRoute(
    defaultAuthorBrief,
    route,
    metadata,
    allowBlankModel
  );
}

function projectEffectiveGenerationAtRoute(
  defaultAuthorBrief: string,
  route: SelectedSettingsRouteV2,
  metadata: EffectiveMetadataV2,
  allowBlankModel: boolean
) {
  const { profile, model, connection } = route;
  const promptCache = promptCacheContextForRoute(route);
  const promptCachePlan = lowerPromptCache(promptCache);
  if (promptCachePlan.kind === "blocked") {
    throw new SettingsFormatError(promptCacheBlockMessage(promptCachePlan.reason));
  }
  const effortAvailability = generationEffortAvailabilityForRoute(route, profile.effort);
  if (effortAvailability.kind === "unavailable") {
    throw new SettingsFormatError(`${effortAvailability.reason}.`);
  }
  const provider = providerForProtocol(connection.protocol);
  const remoteId = effectiveRemoteId(
    provider,
    model.remoteId,
    allowBlankModel
  );
  const contextWindow = resolveModelScalar(model, metadata, "contextWindow");
  const settings: GenerationSettings = {
    provider,
    baseUrl: connection.baseUrl ?? "",
    model: remoteId,
    apiKeyEnv: effectiveApiKeyEnv(connection),
    ...(connection.allowInsecureHttp === true
      ? { allowInsecureHttp: true as const }
      : {}),
    ...(isSubscriptionProtocolV2(connection.protocol)
      ? { protocol: connection.protocol }
      : {}),
    temperature: profile.temperature,
    maxTokens: clampMaxOutputTokensToModel(profile.maxOutputTokens, model, metadata),
    systemPrompt: defaultAuthorBrief,
    contextWindow: contextWindow ?? null
  };
  return {
    route,
    promptCache,
    settings
  };
}

/** Runtime-only cache projection for the selected route. Keeping this separate
 * from GenerationSettings preserves the frozen v1 provider contract while
 * making capability/preset lowering explicit for later slices. */
export function effectivePromptCacheContext(
  value: SettingsDocumentV2,
  purpose: SettingsRoutePurpose = "default"
): PromptCacheContext {
  const document = parseSettingsDocumentV2(value);
  return promptCacheContextForRoute(selectSettingsRoute(document, purpose));
}

/** Compatibility editor for the existing simple GenerationSettings UI. It
 * updates only the selected default connection/model/profile and writing brief,
 * preserving IDs, routing, unselected records, discovery, effort, and policy. */
export function applyEffectiveGenerationSettings<D extends SettingsDocumentV2 | SettingsDocumentV5>(
  value: D,
  generationValue: GenerationSettings
): D {
  const { allowInsecureHttp: _allowInsecureHttp, ...legacyValue } = generationValue;
  const settings = parseGenerationSettingsV1(legacyValue);
  if (value.schemaVersion === 5) {
    return applyBasicSettingsDraft(value, settings);
  }
  return parseSettingsDocumentV2(
    applyBasicSettingsDraft(parseSettingsDocumentV2(value), settings)
  ) as D;
}

export function inferSettingsPresetV2(provider: Provider, baseUrl: string): SettingsPresetV2 {
  if (provider === "dry-run") return "dry-run";
  if (provider === "anthropic") {
    return isOfficialAnthropicBaseUrl(baseUrl) ? "anthropic" : "custom";
  }
  const normalized = normalizeLegacyBaseUrl(baseUrl);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return "custom";
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "api.openai.com") return "openai";
  if (provider === "text-completion") return "custom";
  if (host === "openrouter.ai") return "openrouter";
  if (isLoopback(host) && parsed.port === "1234") return "lm-studio";
  if (isLoopback(host) && parsed.port === "11434") return "ollama";
  if (isLoopback(host) && parsed.port === "8080") return "llama-cpp";
  if (isLoopback(host) && parsed.port === "5001") return "koboldcpp";
  return "custom";
}

function connectionFromGenerationSettings(settings: GenerationSettings): ModelConnectionV2 {
  if (settings.provider === "dry-run") {
    return {
      name: "Dry Run",
      preset: "dry-run",
      protocol: "dry-run",
      baseUrl: null,
      auth: { type: "none" },
      headers: [],
      timeouts: defaultConnectionTimeouts(settings.provider)
    };
  }
  const preset = inferSettingsPresetV2(settings.provider, settings.baseUrl);
  return {
    name: connectionName(preset),
    preset,
    protocol: settings.provider === "anthropic"
      ? "anthropic-messages"
      : settings.provider === "text-completion"
        ? "text-completions"
        : "openai-chat-completions",
    ...(settings.provider === "text-completion"
      ? { textPromptFormat: "raw" as const }
      : {}),
    baseUrl: normalizeLegacyBaseUrl(settings.baseUrl),
    auth: settings.apiKeyEnv === null
      ? { type: "none" }
      : settings.provider === "anthropic"
        ? { type: "header-env", name: "x-api-key", env: settings.apiKeyEnv }
        : { type: "bearer-env", env: settings.apiKeyEnv },
    headers: [],
    timeouts: defaultConnectionTimeouts(settings.provider)
  };
}

export function providerForProtocol(protocol: ModelConnectionV2["protocol"]): Provider {
  if (isSubscriptionProtocolV2(protocol)) {
    return protocol === "openai-codex-responses"
      ? "openai-compatible"
      : "anthropic";
  }
  switch (protocol) {
    case "dry-run": return "dry-run";
    case "openai-chat-completions": return "openai-compatible";
    case "text-completions": return "text-completion";
    case "anthropic-messages": return "anthropic";
  }
  throw new SettingsFormatError("Unsupported settings protocol");
}

function effectiveRemoteId(
  provider: Provider,
  remoteId: string,
  allowBlank: boolean
): string {
  if (!allowBlank && provider !== "dry-run" && remoteId.trim().length === 0) {
    throw new SettingsFormatError("Network runtime lowering requires a nonblank model remote ID");
  }
  return remoteId;
}

export function effectiveApiKeyEnv(connection: ModelConnectionV2): string | null {
  if (
    connection.auth.type === "none"
    || connection.auth.type === "bearer-stored"
    || connection.auth.type === "header-stored"
  ) return null;
  return connection.auth.env;
}

function normalizeLegacyBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function connectionName(preset: SettingsPresetV2): string {
  switch (preset) {
    case "dry-run": return "Dry Run";
    case "openai": return "OpenAI";
    case "openrouter": return "OpenRouter";
    case "anthropic": return "Anthropic";
    case "lm-studio": return "LM Studio";
    case "ollama": return "Ollama";
    case "llama-cpp": return "llama.cpp";
    case "koboldcpp": return "KoboldCpp";
    case "custom": return "Custom";
  }
  throw new SettingsFormatError("Unsupported settings preset");
}

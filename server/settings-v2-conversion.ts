import type { GenerationSettings, Provider } from "../shared/types.js";
import { applyBasicSettingsDraft } from "../shared/settings-basic-draft.js";
import type {
  ModelConnectionV2,
  ModelDefinitionV2,
  ModelScalarMetadataV2,
  SettingsDocumentV2,
  SettingsPresetV2,
  SettingsRoutePurpose
} from "../shared/settings-v2-types.js";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
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
import { selectSettingsRoute } from "../shared/settings-route.js";
import { parseGenerationSettingsV1 } from "./settings-v1-codec.js";
import { parseSettingsDocumentV2 } from "./settings-v2-codec.js";
import {
  MAX_SETTINGS_NAME_SCALARS,
  SettingsFormatError
} from "./settings-v2-scalars.js";
import {
  attachProviderRuntime,
  providerRuntimeFromV2,
  type ProviderRuntime
} from "./provider-runtime.js";

export interface EffectiveMetadataV2 {
  readonly runtime?: ModelScalarMetadataV2;
  readonly builtin?: ModelScalarMetadataV2;
}

export interface EffectiveGenerationRuntime {
  readonly settings: GenerationSettings;
  readonly promptCache: PromptCacheContext;
  readonly providerRuntime: ProviderRuntime;
}

export interface EffectiveGenerationRuntimeOptions {
  /** Provider checks and discovery do not require a generation-ready model ID. */
  readonly allowBlankModel?: boolean;
}

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

/** Project the selected v2 route into the unchanged provider runtime contract.
 * Unsupported v2-only semantics fail explicitly rather than being dropped. */
export function effectiveGenerationSettings(
  value: SettingsDocumentV2,
  purpose: SettingsRoutePurpose = "default",
  metadata: EffectiveMetadataV2 = {}
): GenerationSettings {
  return effectiveGenerationRuntime(value, purpose, metadata).settings;
}

/** Project settings and cache policy from one parsed route snapshot. Callers
 * must not combine independent reads: a settings activation between them could
 * otherwise pair one provider target with another target's cache contract. */
export function effectiveGenerationRuntime(
  value: SettingsDocumentV2,
  purpose: SettingsRoutePurpose = "default",
  metadata: EffectiveMetadataV2 = {},
  environment?: NodeJS.ProcessEnv,
  options: EffectiveGenerationRuntimeOptions = {},
  storedSecrets?: ReadonlyMap<string, string>
): EffectiveGenerationRuntime {
  const document = parseSettingsDocumentV2(value);
  const route = selectSettingsRoute(document, purpose);
  const { profile, model, connection } = route;
  const promptCache = promptCacheContextForRoute(route);
  const promptCachePlan = lowerPromptCache(promptCache);
  if (promptCachePlan.kind === "blocked") {
    throw new SettingsFormatError(promptCacheBlockMessage(promptCachePlan.reason));
  }
  const provider = providerForProtocol(connection.protocol);
  if (provider === "anthropic" && profile.effort === "off") {
    throw new SettingsFormatError(
      "Anthropic does not define a generation-effort mapping for off"
    );
  }
  const remoteId = effectiveRemoteId(
    provider,
    model.remoteId,
    options.allowBlankModel === true
  );
  const contextWindow = resolveModelScalar(model, metadata, "contextWindow");
  const modelMaxOutputTokens = resolveModelScalar(model, metadata, "maxOutputTokens");
  const providerRuntime = providerRuntimeFromV2(
    connection,
    profile.effort,
    model.capabilities,
    profile.sampling ?? EMPTY_SAMPLING_V2,
    environment,
    storedSecrets
  );
  const settings = attachProviderRuntime({
      provider,
      baseUrl: connection.baseUrl ?? "",
      model: remoteId,
      apiKeyEnv: effectiveApiKeyEnv(connection),
      temperature: profile.temperature,
      maxTokens: modelMaxOutputTokens === undefined
        ? profile.maxOutputTokens
        : Math.min(profile.maxOutputTokens, modelMaxOutputTokens),
      systemPrompt: document.writing.defaultAuthorBrief,
      contextWindow: contextWindow ?? null
    }, providerRuntime);
  return {
    promptCache,
    providerRuntime,
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
export function applyEffectiveGenerationSettings(
  value: SettingsDocumentV2,
  generationValue: GenerationSettings
): SettingsDocumentV2 {
  const document = parseSettingsDocumentV2(value);
  const { allowInsecureHttp: _allowInsecureHttp, ...legacyValue } = generationValue;
  const settings = parseGenerationSettingsV1(legacyValue);
  return parseSettingsDocumentV2(applyBasicSettingsDraft(document, settings));
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
    protocol: settings.provider === "anthropic" ? "anthropic-messages" : "openai-chat-completions",
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
  switch (protocol) {
    case "dry-run": return "dry-run";
    case "openai-chat-completions": return "openai-compatible";
    case "anthropic-messages": return "anthropic";
  }
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

function resolveModelScalar(
  model: ModelDefinitionV2,
  metadata: EffectiveMetadataV2,
  scalar: keyof ModelScalarMetadataV2
): number | undefined {
  return model.overrides[scalar]
    ?? metadata.runtime?.[scalar]
    ?? model.discovered[scalar]
    ?? metadata.builtin?.[scalar];
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
}

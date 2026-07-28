import type {
  ModelDiscoveryResultV2,
  ModelConnectionV2,
  ModelScalarMetadataV2,
  SettingsDocumentV2,
  SettingsPresetV2,
  SettingsProtocolV2,
  SettingsView
} from "./settings-v2-types.js";
import type { GenerationSettings, Provider } from "./types.js";
import {
  defaultConnectionTimeouts,
  defaultModelCapabilities,
  isOfficialAnthropicBaseUrl
} from "./settings-provider-defaults.js";
import { classifyHttpHost } from "./http-host-class.js";
import { storedCredentialSecretId } from "./settings-stored-credential.js";

/**
 * Apply the deliberately small Release A editor to the active default route.
 * IDs and advanced fields survive; the basic form changes only values it owns.
 */
export function applyBasicSettingsDraft(
  document: SettingsDocumentV2,
  draft: GenerationSettings
): SettingsDocumentV2 {
  return applyBasicSettingsDocumentDraft(document, draft, savedModelIdentity);
}

/**
 * Apply an editable draft to a probe document.
 * A probe can use the model that the server loaded.
 */
export function applyBasicSettingsProbeDraft(
  document: SettingsDocumentV2,
  draft: GenerationSettings
): SettingsDocumentV2 {
  return applyBasicSettingsDocumentDraft(document, draft, probeModelIdentity);
}

type ModelIdentity = {
  readonly remoteId: string;
  readonly name: string;
};

function applyBasicSettingsDocumentDraft(
  document: SettingsDocumentV2,
  draft: GenerationSettings,
  modelIdentityFor: (settings: GenerationSettings) => ModelIdentity
): SettingsDocumentV2 {
  const route = activeDefaultRoute(document);
  const projected = basicSettingsFromDocument(document);
  const storedAuth = storedCredentialSecretId(route.connection.auth) !== null;
  const normalizedProjection = normalizeBasicSettingsIdentity(projected, false, storedAuth);
  const normalizedDraft = normalizeBasicSettingsIdentity(draft, true, storedAuth);
  if (sameBasicSettings(normalizedProjection, normalizedDraft)) return document;

  const protocol = protocolFor(normalizedDraft.provider);
  const protocolChanged = route.connection.protocol !== protocol;
  const baseUrlChanged = normalizedProjection.baseUrl !== normalizedDraft.baseUrl;
  const nextBaseUrl = !baseUrlChanged
    ? route.connection.baseUrl
    : normalizedDraft.provider === "dry-run"
      ? null
      : normalizedDraft.baseUrl;
  const connectionIdentityChanged =
    protocolChanged || baseUrlChanged;
  const modelIdentityChanged =
    connectionIdentityChanged || normalizedProjection.model !== normalizedDraft.model;
  const modelIdentity = modelIdentityChanged
    ? modelIdentityFor(normalizedDraft)
    : { remoteId: route.model.remoteId, name: route.model.name };
  const contextWindowChanged =
    normalizedProjection.contextWindow !== normalizedDraft.contextWindow;
  const connection = connectionFor(
    route.connection,
    projected,
    normalizedDraft,
    protocol,
    nextBaseUrl,
    connectionIdentityChanged
  );
  const model = modelIdentityChanged
    ? {
        ...route.model,
        ...modelIdentity,
        discovered: {},
        overrides: contextWindowChanged && normalizedDraft.contextWindow !== null
          ? { contextWindow: normalizedDraft.contextWindow }
          : {},
        capabilities: defaultModelCapabilities(normalizedDraft.provider)
      }
    : {
        ...route.model,
        discovered: contextWindowChanged && normalizedDraft.contextWindow === null
          ? metadataWithoutContextWindow(route.model.discovered)
          : route.model.discovered,
        overrides: contextWindowChanged
          ? overridesWithContextWindow(route.model.overrides, normalizedDraft.contextWindow)
          : route.model.overrides
      };

  return {
    ...document,
    connections: {
      ...document.connections,
      [route.model.connectionId]: connection
    },
    models: {
      ...document.models,
      [route.profile.modelId]: model
    },
    profiles: {
      ...document.profiles,
      [document.routing.default]: {
        ...route.profile,
        temperature: normalizedDraft.temperature,
        maxOutputTokens: normalizedDraft.maxTokens
      }
    },
    writing: { defaultAuthorBrief: normalizedDraft.systemPrompt }
  };
}

/** Persist metadata from the latest explicit discovery separately from a
 * user's manual limit override. The frozen v2 document stores scalar evidence;
 * source and observation time remain in the bounded discovery response shown
 * by the editor. */
export function applyBasicModelDiscovery(
  document: SettingsDocumentV2,
  discovery: ModelDiscoveryResultV2 | null,
  visibleContextWindow: number | null
): SettingsDocumentV2 {
  if (discovery === null) return document;
  const route = activeDefaultRoute(document);
  const found = discovery.models.find(
    (candidate) => candidate.remoteId === route.model.remoteId
  );
  if (found === undefined) return document;
  const discovered: ModelScalarMetadataV2 = {
    ...(found.contextWindow === null ? {} : {
      contextWindow: found.contextWindow
    }),
    ...(found.maxOutputTokens === null ? {} : {
      maxOutputTokens: found.maxOutputTokens
    })
  };
  const overrides = { ...route.model.overrides };
  if (
    visibleContextWindow === null
    || visibleContextWindow === found.contextWindow
  ) {
    delete overrides.contextWindow;
  } else {
    overrides.contextWindow = visibleContextWindow;
  }
  return {
    ...document,
    models: {
      ...document.models,
      [route.profile.modelId]: {
        ...route.model,
        discovered,
        overrides
      }
    }
  };
}

export function settingsDocumentSupportsBasicEditor(document: SettingsDocumentV2): boolean {
  try {
    activeDefaultRoute(document);
    return true;
  } catch {
    return false;
  }
}

/** Project the active default route back into the legacy/basic editor shape. */
export function basicSettingsFromDocument(document: SettingsDocumentV2): GenerationSettings {
  const route = activeDefaultRoute(document);
  const provider: Provider = route.connection.protocol === "dry-run"
    ? "dry-run"
    : route.connection.protocol === "anthropic-messages"
      ? "anthropic"
      : "openai-compatible";
  const auth = route.connection.auth;
  return {
    provider,
    baseUrl: route.connection.baseUrl ?? "",
    model: provider === "dry-run" && route.model.remoteId === "dry-run"
      ? ""
      : route.model.remoteId,
    apiKeyEnv: auth.type === "bearer-env" || auth.type === "header-env"
      ? auth.env
      : null,
    ...(route.connection.allowInsecureHttp === true
      ? { allowInsecureHttp: true }
      : {}),
    temperature: route.profile.temperature,
    maxTokens: route.profile.maxOutputTokens,
    systemPrompt: document.writing.defaultAuthorBrief,
    contextWindow: route.model.overrides.contextWindow
      ?? route.model.discovered.contextWindow
      ?? null
  };
}

/** Editable views present their persisted document (active or staged) while
 * runtime callers remain pinned to `effective`; legacy views have no document. */
export function basicSettingsForDisplay(view: SettingsView): GenerationSettings {
  return view.editable
    ? basicSettingsFromDocument(view.document)
    : view.effective;
}

function activeDefaultRoute(document: SettingsDocumentV2) {
  const profile = document.profiles[document.routing.default];
  if (profile === undefined) throw new Error("Default generation profile is missing");
  const model = document.models[profile.modelId];
  if (model === undefined) throw new Error("Default profile model is missing");
  const connection = document.connections[model.connectionId];
  if (connection === undefined) throw new Error("Default model connection is missing");
  return { profile, model, connection };
}

function connectionFor(
  current: ModelConnectionV2,
  projected: GenerationSettings,
  draft: GenerationSettings,
  protocol: SettingsProtocolV2,
  baseUrl: string | null,
  identityChanged: boolean
): ModelConnectionV2 {
  const protocolChanged = current.protocol !== protocol;
  if (!identityChanged) {
    return projected.apiKeyEnv === draft.apiKeyEnv
        && projected.allowInsecureHttp === draft.allowInsecureHttp
      ? current
      : connectionWithBasicPolicy(current, draft, authFor(draft, current.auth));
  }

  if (draft.provider === "dry-run") {
    const { allowInsecureHttp: _allowInsecureHttp, ...portable } = current;
    return {
      ...portable,
      name: "Dry Run",
      preset: "dry-run",
      protocol,
      baseUrl: null,
      auth: { type: "none" },
      headers: [],
      timeouts: protocolChanged ? defaultConnectionTimeouts(draft.provider) : current.timeouts
    };
  }

  if (baseUrl === null) throw new Error("Network settings require a base URL");
  const preset = presetFor(draft.provider, baseUrl);
  const plaintext = new URL(baseUrl).protocol === "http:";
  const originChanged = current.baseUrl === null
    || new URL(current.baseUrl).origin !== new URL(baseUrl).origin;
  const { allowInsecureHttp: _allowInsecureHttp, ...portable } = current;
  return {
    ...portable,
    name: connectionName(preset),
    preset,
    protocol,
    baseUrl,
    auth: authFor(draft, current.auth),
    headers: protocolChanged || plaintext || originChanged ? [] : current.headers,
    timeouts: protocolChanged ? defaultConnectionTimeouts(draft.provider) : current.timeouts,
    ...(draft.allowInsecureHttp === true ? { allowInsecureHttp: true as const } : {})
  };
}

function authFor(
  draft: GenerationSettings,
  current: ModelConnectionV2["auth"]
): ModelConnectionV2["auth"] {
  if (draft.provider === "dry-run") return { type: "none" };
  if (draft.apiKeyEnv === null) {
    if (current.type !== "bearer-stored" && current.type !== "header-stored") {
      return { type: "none" };
    }
    return draft.provider === "anthropic"
      ? {
          type: "header-stored",
          name: "x-api-key",
          secretId: current.secretId
        }
      : { type: "bearer-stored", secretId: current.secretId };
  }
  return draft.provider === "anthropic"
    ? { type: "header-env", name: "x-api-key", env: draft.apiKeyEnv }
    : { type: "bearer-env", env: draft.apiKeyEnv };
}

function overridesWithContextWindow(
  current: ModelScalarMetadataV2,
  contextWindow: number | null
): ModelScalarMetadataV2 {
  const overrides = { ...current };
  if (contextWindow === null) delete overrides.contextWindow;
  else overrides.contextWindow = contextWindow;
  return overrides;
}

function metadataWithoutContextWindow(current: ModelScalarMetadataV2): ModelScalarMetadataV2 {
  const metadata = { ...current };
  delete metadata.contextWindow;
  return metadata;
}

function sameBasicSettings(left: GenerationSettings, right: GenerationSettings): boolean {
  return left.provider === right.provider
    && left.baseUrl === right.baseUrl
    && left.model === right.model
    && left.apiKeyEnv === right.apiKeyEnv
    && left.allowInsecureHttp === right.allowInsecureHttp
    && left.temperature === right.temperature
    && left.maxTokens === right.maxTokens
    && left.systemPrompt === right.systemPrompt
    && left.contextWindow === right.contextWindow;
}

function protocolFor(provider: Provider): SettingsProtocolV2 {
  if (provider === "dry-run") return "dry-run";
  if (provider === "anthropic") return "anthropic-messages";
  return "openai-chat-completions";
}

function presetFor(provider: Provider, baseUrl: string): SettingsPresetV2 {
  if (provider === "anthropic") {
    return isOfficialAnthropicBaseUrl(baseUrl) ? "anthropic" : "custom";
  }
  const parsed = new URL(baseUrl);
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "api.openai.com") return "openai";
  if (hostname === "openrouter.ai") return "openrouter";
  const loopback = classifyHttpHost(baseUrl) === "loopback";
  if (loopback && parsed.port === "1234") return "lm-studio";
  if (loopback && parsed.port === "11434") return "ollama";
  if (loopback && parsed.port === "8080") return "llama-cpp";
  if (loopback && parsed.port === "5001") return "koboldcpp";
  return "custom";
}

function connectionName(preset: SettingsPresetV2): string {
  if (preset === "openai") return "OpenAI";
  if (preset === "openrouter") return "OpenRouter";
  if (preset === "anthropic") return "Anthropic";
  if (preset === "lm-studio") return "LM Studio";
  if (preset === "ollama") return "Ollama";
  if (preset === "llama-cpp") return "llama.cpp";
  if (preset === "koboldcpp") return "KoboldCpp";
  return "Custom";
}

function requireBasicBaseUrl(
  value: string,
  apiKeyEnv: string | null,
  allowInsecureHttp: boolean,
  hasStoredCredential: boolean
): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Base URL must be a valid URL");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0
    || parsed.href.includes("?") || parsed.href.includes("#")) {
    throw new Error("Base URL cannot contain credentials, a query, or a fragment");
  }
  if (parsed.protocol === "https:") return trimmed;
  if (parsed.protocol === "http:") {
    if (apiKeyEnv !== null || hasStoredCredential) {
      throw new Error("Plain HTTP connections cannot carry an API key");
    }
    const hostClass = classifyHttpHost(trimmed);
    if (hostClass === "loopback") return trimmed;
    if (
      allowInsecureHttp
      && (hostClass === "private-literal" || hostClass === "lan-hostname")
    ) return trimmed;
  }
  throw new Error(
    "Basic settings require HTTPS, except for keyless localhost or opted-in LAN HTTP"
  );
}

function normalizeBasicSettingsIdentity(
  settings: GenerationSettings,
  requireHostedHttps: boolean,
  hasStoredCredential: boolean
): GenerationSettings {
  const model = settings.model.trim();
  const baseUrl = settings.provider === "dry-run"
    ? ""
    : requireHostedHttps
      ? requireBasicBaseUrl(
          settings.baseUrl,
          settings.apiKeyEnv,
          settings.allowInsecureHttp === true,
          hasStoredCredential
        )
      : settings.baseUrl.trim().replace(/\/+$/, "");
  const allowInsecureHttp = settings.provider !== "dry-run"
    && settings.allowInsecureHttp === true
    && isOptedInLanHttp(baseUrl);
  return {
    ...settings,
    apiKeyEnv: settings.provider === "dry-run" ? null : settings.apiKeyEnv,
    baseUrl,
    model: settings.provider === "dry-run" && model === "dry-run" ? "" : model,
    allowInsecureHttp
  };
}

function connectionWithBasicPolicy(
  current: ModelConnectionV2,
  draft: GenerationSettings,
  auth: ModelConnectionV2["auth"]
): ModelConnectionV2 {
  const { allowInsecureHttp: _allowInsecureHttp, ...portable } = current;
  return {
    ...portable,
    auth,
    ...(draft.allowInsecureHttp === true ? { allowInsecureHttp: true as const } : {})
  };
}

function isOptedInLanHttp(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    const hostClass = classifyHttpHost(parsed.href);
    return parsed.protocol === "http:"
      && (hostClass === "private-literal" || hostClass === "lan-hostname");
  } catch {
    return false;
  }
}

function remoteIdFor(settings: GenerationSettings): string {
  if (settings.provider === "dry-run") return settings.model.trim() || "dry-run";
  const remoteId = settings.model.trim();
  if (remoteId.length === 0) throw new Error("Model name cannot be empty");
  return remoteId;
}

function modelNameFor(settings: GenerationSettings): string {
  return settings.provider === "dry-run" ? "Dry Run" : settings.model.trim();
}

function savedModelIdentity(settings: GenerationSettings): ModelIdentity {
  return {
    remoteId: remoteIdFor(settings),
    name: modelNameFor(settings)
  };
}

function probeModelIdentity(settings: GenerationSettings): ModelIdentity {
  if (settings.provider === "dry-run") return savedModelIdentity(settings);
  const remoteId = settings.model.trim();
  return {
    remoteId,
    name: remoteId.length > 0
      ? remoteId
      : connectionName(presetFor(settings.provider, settings.baseUrl))
  };
}

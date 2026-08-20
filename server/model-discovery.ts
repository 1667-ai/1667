import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type {
  DiscoveredModelV2,
  ModelDiscoveryResultV2,
  ModelDiscoverySourceV2,
  SubscriptionProtocolV2
} from "../shared/settings-v2-types.js";
import { isSubscriptionProtocolV2 } from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";
import { hasUnpairedSurrogate, unicodeScalarLength } from "../shared/unicode.js";
import { ProviderError } from "./errors.js";
import { getProviderJson } from "./provider-json.js";
import { providerRuntimeFor } from "./provider-runtime.js";
import { providerRoot, providerUrl } from "./providers.js";
import {
  MAX_SETTINGS_REMOTE_ID_SCALARS,
  MAX_SETTINGS_TOKEN_COUNT
} from "./settings-v2-scalars.js";

const MAX_DISCOVERED_MODELS = 256;

export async function discoverProviderModels(
  settings: GenerationSettings,
  now: () => Date = () => new Date(),
  signal?: AbortSignal
): Promise<ModelDiscoveryResultV2> {
  if (settings.provider === "dry-run") {
    return { observedAt: now().toISOString(), models: [] };
  }
  const runtime = providerRuntimeFor(settings);
  if (runtime.protocol !== undefined && isSubscriptionProtocolV2(runtime.protocol)) {
    return {
      observedAt: now().toISOString(),
      models: subscriptionCatalog(runtime.protocol)
    };
  }
  const root = providerRoot(settings);
  const timeoutMs = Math.min(runtime.timeouts.totalMs, 30_000);
  const result = settings.provider === "anthropic"
    ? await discover(
        settings,
        anthropicDiscoveryUrl(settings),
        "anthropic-models",
        { "anthropic-version": "2023-06-01" },
        timeoutMs,
        signal
      )
    : runtime.preset === "lm-studio"
      ? await discover(settings, `${root}/api/v0/models`, "lm-studio-models", {}, timeoutMs, signal)
      : runtime.preset === "ollama"
        ? await discover(settings, `${root}/api/tags`, "ollama-tags", {}, timeoutMs, signal)
        : await discover(
            settings,
            providerUrl(settings, "/models"),
            "openai-models",
            {},
            timeoutMs,
            signal
          );
  return {
    observedAt: now().toISOString(),
    models: result
  };
}

function subscriptionCatalog(
  protocol: SubscriptionProtocolV2
): readonly DiscoveredModelV2[] {
  const provider = protocol === "openai-codex-responses"
    ? openaiCodexProvider()
    : anthropicProvider();
  return provider.getModels()
    .slice(0, MAX_DISCOVERED_MODELS)
    .map((model) => ({
      remoteId: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxTokens,
      source: "pi-catalog"
    }));
}

function anthropicDiscoveryUrl(settings: GenerationSettings): string {
  const url = providerUrl(settings, "/v1/models");
  return new URL(settings.baseUrl).protocol === "https:"
    ? `${url}?limit=${MAX_DISCOVERED_MODELS}`
    : url;
}

async function discover(
  settings: GenerationSettings,
  url: string,
  source: ModelDiscoverySourceV2,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<readonly DiscoveredModelV2[]> {
  const data = await getProviderJson(settings, url, headers, {
    signal,
    timeoutMs
  });
  const entries = source === "ollama-tags"
    ? isObject(data) && Array.isArray(data.models) ? data.models : null
    : isObject(data) && Array.isArray(data.data) ? data.data : null;
  if (entries === null) {
    throw new ProviderError(`Model discovery returned an invalid ${source} catalog.`);
  }
  const result: DiscoveredModelV2[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isObject(entry)) continue;
    const remoteId = modelId(entry, source);
    if (remoteId === null || seen.has(remoteId)) continue;
    seen.add(remoteId);
    result.push({
      remoteId,
      name: modelName(entry, remoteId),
      contextWindow: source === "anthropic-models"
        ? modelScalar(entry, "max_input_tokens")
        : source === "lm-studio-models"
          ? modelScalar(entry, "loaded_context_length")
          : modelScalar(entry, "loaded_context_length")
            ?? modelScalar(entry, "context_length")
            ?? modelScalar(entry, "max_context_length"),
      maxOutputTokens: source === "anthropic-models"
        ? modelScalar(entry, "max_tokens")
        : modelScalar(entry, "max_output_tokens"),
      source
    });
    if (result.length === MAX_DISCOVERED_MODELS) break;
  }
  return result;
}

function modelId(
  entry: Record<string, unknown>,
  source: ModelDiscoverySourceV2
): string | null {
  const value = source === "ollama-tags"
    ? typeof entry.model === "string" ? entry.model : entry.name
    : entry.id;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || hasUnpairedSurrogate(value)
    || value.normalize("NFC") !== value
  ) return null;
  return unicodeScalarLength(value, MAX_SETTINGS_REMOTE_ID_SCALARS)
    <= MAX_SETTINGS_REMOTE_ID_SCALARS
    ? value
    : null;
}

function modelName(entry: Record<string, unknown>, fallback: string): string {
  const value = typeof entry.display_name === "string"
    ? entry.display_name
    : typeof entry.name === "string"
      ? entry.name
      : fallback;
  const safe = value.trim().length === 0
    || hasUnpairedSurrogate(value)
    || value.normalize("NFC") !== value
    ? fallback
    : value;
  return Array.from(safe).slice(0, 256).join("");
}

function modelScalar(entry: Record<string, unknown>, key: string): number | null {
  const value = entry[key];
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_SETTINGS_TOKEN_COUNT
    ? value
    : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

import type {
  ModelDiscoveryResultV2,
  ModelDiscoverySourceV2
} from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";
import {
  MAX_DISCOVERED_MODELS,
  discoverBundledModels,
  sanitizeDiscoveredModels,
  type ModelDiscoveryCandidate
} from "../shared/model-discovery-catalog.js";
import { ProviderError } from "./errors.js";
import { getProviderJson } from "./provider-json.js";
import {
  isSubscriptionProviderRuntime,
  providerRuntimeFor,
  type SubscriptionProviderRuntime
} from "./provider-runtime.js";
import { providerRoot, providerUrl } from "./providers.js";
import { subscriptionProviderForProtocol } from "./subscription-protocol.js";

type NetworkDiscoverySourceV2 = Exclude<ModelDiscoverySourceV2, "pi-catalog">;

interface NetworkCatalogAdapter {
  readonly entries: (data: unknown) => readonly unknown[] | null;
  readonly candidate: (entry: unknown) => ModelDiscoveryCandidate | null;
}

const NETWORK_CATALOG_ADAPTERS = {
  "anthropic-models": {
    entries: dataEntries,
    candidate: (entry) => objectCandidate(entry, {
      id: "id",
      name: "display_name",
      contextWindow: "max_input_tokens",
      maxOutputTokens: "max_tokens"
    })
  },
  "openai-models": {
    entries: dataEntries,
    candidate: openAiCandidate
  },
  "lm-studio-models": {
    entries: dataEntries,
    candidate: (entry) => objectCandidate(entry, {
      id: "id",
      name: "name",
      contextWindow: "loaded_context_length",
      maxOutputTokens: "max_output_tokens"
    })
  },
  "ollama-tags": {
    entries: modelEntries,
    candidate: ollamaCandidate
  }
} satisfies Record<NetworkDiscoverySourceV2, NetworkCatalogAdapter>;

export async function discoverProviderModels(
  settings: GenerationSettings,
  now: () => Date = () => new Date(),
  signal?: AbortSignal
): Promise<ModelDiscoveryResultV2> {
  if (settings.provider === "dry-run") {
    return { observedAt: now().toISOString(), models: [] };
  }
  const runtime = providerRuntimeFor(settings);
  if (isSubscriptionProviderRuntime(runtime)) {
    return {
      observedAt: now().toISOString(),
      models: subscriptionCatalog(runtime)
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
  runtime: SubscriptionProviderRuntime
): ModelDiscoveryResultV2["models"] {
  const providerId = subscriptionProviderForProtocol(runtime.protocol);
  return discoverBundledModels(runtime.subscription.models.getModels(providerId));
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
  source: NetworkDiscoverySourceV2,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ModelDiscoveryResultV2["models"]> {
  const data = await getProviderJson(settings, url, headers, {
    signal,
    timeoutMs
  });
  const adapter = NETWORK_CATALOG_ADAPTERS[source];
  const entries = adapter.entries(data);
  if (entries === null) {
    throw new ProviderError(`Model discovery returned an invalid ${source} catalog.`);
  }
  return sanitizeDiscoveredModels(entries, source, adapter.candidate);
}

function dataEntries(data: unknown): readonly unknown[] | null {
  return isObject(data) && Array.isArray(data.data) ? data.data : null;
}

function modelEntries(data: unknown): readonly unknown[] | null {
  return isObject(data) && Array.isArray(data.models) ? data.models : null;
}

function objectCandidate(
  entry: unknown,
  keys: {
    readonly id: string;
    readonly name: string;
    readonly contextWindow: string;
    readonly maxOutputTokens: string;
  }
): ModelDiscoveryCandidate | null {
  if (!isObject(entry)) return null;
  return {
    remoteId: entry[keys.id],
    name: typeof entry[keys.name] === "string" ? entry[keys.name] : entry.name,
    contextWindow: [entry[keys.contextWindow]],
    maxOutputTokens: [entry[keys.maxOutputTokens]]
  };
}

function openAiCandidate(entry: unknown): ModelDiscoveryCandidate | null {
  if (!isObject(entry)) return null;
  return {
    remoteId: entry.id,
    name: typeof entry.display_name === "string" ? entry.display_name : entry.name,
    contextWindow: [
      entry.loaded_context_length,
      entry.context_length,
      entry.max_context_length
    ],
    maxOutputTokens: [entry.max_output_tokens]
  };
}

function ollamaCandidate(entry: unknown): ModelDiscoveryCandidate | null {
  if (!isObject(entry)) return null;
  return {
    remoteId: typeof entry.model === "string" ? entry.model : entry.name,
    name: typeof entry.display_name === "string" ? entry.display_name : entry.name,
    contextWindow: [
      entry.loaded_context_length,
      entry.context_length,
      entry.max_context_length
    ],
    maxOutputTokens: [entry.max_output_tokens]
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

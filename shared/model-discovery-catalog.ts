import type {
  DiscoveredModelV2,
  ModelDiscoverySourceV2
} from "./settings-v2-types.js";
import {
  MAX_DISCOVERED_MODELS,
  MAX_SETTINGS_REMOTE_ID_SCALARS,
  MAX_SETTINGS_TOKEN_COUNT
} from "./settings-scalar-policy.js";
import { hasUnpairedSurrogate, unicodeScalarLength } from "./unicode.js";

export { MAX_DISCOVERED_MODELS };

export interface ModelDiscoveryCandidate {
  readonly remoteId: unknown;
  readonly name: unknown;
  readonly contextWindow: readonly unknown[];
  readonly maxOutputTokens: readonly unknown[];
}

/** The typed part of a bundled model that discovery publishes. */
export interface BundledCatalogModel {
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
}

/** Apply one discovery policy after a source adapter projects its fields. */
export function sanitizeDiscoveredModels<T>(
  entries: readonly T[],
  source: ModelDiscoverySourceV2,
  candidateFor: (entry: T) => ModelDiscoveryCandidate | null
): readonly DiscoveredModelV2[] {
  const result: DiscoveredModelV2[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const candidate = candidateFor(entry);
    if (candidate === null) continue;
    const remoteId = safeModelId(candidate.remoteId);
    if (remoteId === null || seen.has(remoteId)) continue;
    seen.add(remoteId);
    result.push({
      remoteId,
      name: safeModelName(candidate.name, remoteId),
      contextWindow: firstSafeModelScalar(candidate.contextWindow),
      maxOutputTokens: firstSafeModelScalar(candidate.maxOutputTokens),
      source
    });
    if (result.length === MAX_DISCOVERED_MODELS) break;
  }
  return result;
}

/** Project a typed bundled catalog through the shared discovery policy. */
export function discoverBundledModels(
  models: readonly BundledCatalogModel[]
): readonly DiscoveredModelV2[] {
  return sanitizeDiscoveredModels(models, "pi-catalog", (model) => ({
    remoteId: model.id,
    name: model.name,
    contextWindow: [model.contextWindow],
    maxOutputTokens: [model.maxTokens]
  }));
}

function safeModelId(value: unknown): string | null {
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

function safeModelName(value: unknown, fallback: string): string {
  const safe = typeof value !== "string"
    || value.trim().length === 0
    || hasUnpairedSurrogate(value)
    || value.normalize("NFC") !== value
    ? fallback
    : value;
  return Array.from(safe).slice(0, 256).join("");
}

function safeModelScalar(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_SETTINGS_TOKEN_COUNT
    ? value
    : null;
}

function firstSafeModelScalar(values: readonly unknown[]): number | null {
  for (const value of values) {
    const scalar = safeModelScalar(value);
    if (scalar !== null) return scalar;
  }
  return null;
}

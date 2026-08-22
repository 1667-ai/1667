import {
  PROVIDER_PROBE_ROUTE_V1_KIND,
  isProviderProbeRouteV1,
  type ProviderProbeRouteV1
} from "../shared/provider-probe-route-v1.js";
import { MAX_PROVIDER_PROBE_SECRETS } from "../shared/settings-v5-limits.js";
import { DEFAULT_WRITING_PROMPT_SETTINGS } from "../shared/settings-v5-writing.js";
import { ServiceError } from "./errors.js";
import { parseSettingsDocumentV5 } from "./settings-v5-codec.js";
import { requireSecretId, requireSettingsId } from "./settings-v2-scalars.js";
import { validateProviderSecretValue } from "../shared/provider-secret-value.js";
import { closedRecord, closedShape, literal } from "./story-wire-validation.js";
import type { SettingsDocumentV5 } from "../shared/settings-v5-types.js";
import type { SettingsValidationOptions } from "./settings-v2-validation.js";

const ROUTE = closedShape(
  ["kind", "connection", "model", "profile"],
  ["secrets"]
);

export function parseProviderProbeRouteV1(
  value: unknown,
  options: SettingsValidationOptions = {}
): ProviderProbeRouteV1 {
  const root = closedRecord(value, "provider probe route", ROUTE);
  literal(root.kind, PROVIDER_PROBE_ROUTE_V1_KIND, "provider probe route.kind");
  const document = settingsDocumentFromProbeFields(root, options);
  const profile = document.profiles.probe!;
  const model = document.models[profile.modelId]!;
  return {
    kind: PROVIDER_PROBE_ROUTE_V1_KIND,
    connection: document.connections[model.connectionId]!,
    model,
    profile,
    ...(root.secrets === undefined ? {} : { secrets: parseProviderProbeSecrets(root.secrets) })
  };
}

export function settingsDocumentFromProviderProbeRoute(
  route: ProviderProbeRouteV1,
  options: SettingsValidationOptions = {}
): SettingsDocumentV5 {
  return parseSettingsDocumentV5({
    schemaVersion: 5,
    connections: { [route.model.connectionId]: route.connection },
    models: { [route.profile.modelId]: route.model },
    profiles: { probe: route.profile },
    routing: { default: "probe" },
    writing: DEFAULT_WRITING_PROMPT_SETTINGS
  }, options);
}

function settingsDocumentFromProbeFields(
  root: Record<string, unknown>,
  options: SettingsValidationOptions
): SettingsDocumentV5 {
  const model = closedRecord(
    root.model,
    "provider probe route.model",
    closedShape(
      ["connectionId", "remoteId", "name", "discovered", "overrides", "capabilities"]
    )
  );
  const profile = closedRecord(
    root.profile,
    "provider probe route.profile",
    closedShape(
      ["name", "modelId", "temperature", "maxOutputTokens", "generationReasoning", "cachePolicy"],
      ["sampling", "tokenProbabilities", "reasoning", "discardReasoning", "continuationPromptOptimization"]
    )
  );
  const connectionId = requireSettingsId(
    model.connectionId,
    "provider probe route.model.connectionId"
  );
  const modelId = requireSettingsId(profile.modelId, "provider probe route.profile.modelId");
  return parseSettingsDocumentV5({
    schemaVersion: 5,
    connections: { [connectionId]: root.connection },
    models: { [modelId]: root.model },
    profiles: { probe: root.profile },
    routing: { default: "probe" },
    writing: DEFAULT_WRITING_PROMPT_SETTINGS
  }, options);
}

export function parseProviderProbeSecrets(
  value: unknown
): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError(
      400,
      "Provider probe secrets must be an object.",
      "invalid_request"
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_PROVIDER_PROBE_SECRETS) {
    throw new ServiceError(
      400,
      `Provider probe secrets exceed the ${MAX_PROVIDER_PROBE_SECRETS}-entry limit.`,
      "invalid_request"
    );
  }
  const result: Record<string, string> = {};
  for (const [rawSecretId, rawValue] of entries) {
    const secretId = requireSecretId(rawSecretId, "Provider probe secret ID");
    result[secretId] = validateProviderSecretValue(rawValue);
  }
  return result;
}

export { isProviderProbeRouteV1 };

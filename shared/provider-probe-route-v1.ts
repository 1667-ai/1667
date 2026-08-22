import type { GenerationSettings, Provider } from "./types.js";
import type {
  GenerationProfileV2,
  ModelConnectionV2,
  ModelDefinitionV2
} from "./settings-v2-types.js";
import type {
  GenerationProfileV5,
  ModelDefinitionV5
} from "./settings-v5-types.js";
import { legacyGenerationReasoningV5 } from "./settings-v5-reasoning.js";
import {
  selectSettingsRoute,
  type SelectedSettingsRoute,
  type SelectedSettingsRouteV2
} from "./settings-route.js";
import type { SettingsDocumentV2, SettingsRoutePurpose } from "./settings-v2-types.js";

export const PROVIDER_PROBE_ROUTE_V1_KIND = "provider-probe-route-v1" as const;

/** Closed selected-route probe. It never carries routing maps, other records,
 *  or writing prompts. */
export interface ProviderProbeRouteV1 {
  readonly kind: typeof PROVIDER_PROBE_ROUTE_V1_KIND;
  readonly connection: ModelConnectionV2;
  readonly model: ModelDefinitionV5;
  readonly profile: GenerationProfileV5;
  readonly secrets?: Readonly<Record<string, string>>;
}

/** A probe may carry a closed selected route so connection policy is not
 * flattened out before the server constructs its provider runtime.
 *
 * `secrets` carries key material the editor holds but has not saved yet, so a
 * key can be tested the moment it is typed. The server resolves it in memory
 * for this one request and never writes it to the secret store: a probe proves
 * possession of the key, it does not activate a credential. */
export type ProviderProbeTarget = GenerationSettings | ProviderProbeRouteV1;

export function isProviderProbeRouteV1(value: unknown): value is ProviderProbeRouteV1 {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { readonly kind?: unknown }).kind === PROVIDER_PROBE_ROUTE_V1_KIND;
}

/** Project a schema-2 selected route into the closed probe payload. */
export function providerProbeRouteFromDocument(
  document: SettingsDocumentV2,
  purpose: SettingsRoutePurpose = "default",
  secrets?: Readonly<Record<string, string>>
): ProviderProbeRouteV1 {
  return providerProbeRouteFromV2Route(selectSettingsRoute(document, purpose), secrets);
}

export function providerProbeRouteFromV5Route(
  route: SelectedSettingsRoute<GenerationProfileV5, ModelDefinitionV5, ModelConnectionV2>,
  secrets?: Readonly<Record<string, string>>
): ProviderProbeRouteV1 {
  return {
    kind: PROVIDER_PROBE_ROUTE_V1_KIND,
    connection: route.connection,
    model: route.model,
    profile: route.profile,
    ...(secrets === undefined || Object.keys(secrets).length === 0 ? {} : { secrets })
  };
}

export function providerProbeRouteFromV2Route(
  route: SelectedSettingsRouteV2,
  secrets?: Readonly<Record<string, string>>
): ProviderProbeRouteV1 {
  return {
    kind: PROVIDER_PROBE_ROUTE_V1_KIND,
    connection: route.connection,
    model: modelDefinitionV5FromV2(route.model, route.connection),
    profile: generationProfileV5FromV2(route.profile),
    ...(secrets === undefined || Object.keys(secrets).length === 0 ? {} : { secrets })
  };
}

function modelDefinitionV5FromV2(
  model: ModelDefinitionV2,
  connection: ModelConnectionV2
): ModelDefinitionV5 {
  const imageInput = "imageInput" in model.capabilities
    ? (model.capabilities as ModelDefinitionV5["capabilities"]).imageInput
    : connection.protocol === "dry-run" ? "unsupported" : "unknown";
  return {
    ...model,
    capabilities: {
      ...model.capabilities,
      imageInput
    }
  };
}

export function generationSettingsFromProbeTarget(
  target: ProviderProbeTarget
): GenerationSettings {
  if (!isProviderProbeRouteV1(target)) return target;
  const protocol = target.connection.protocol;
  const provider: Provider = protocol === "dry-run"
    ? "dry-run"
    : protocol === "anthropic-messages" || protocol === "anthropic-subscription-messages"
      ? "anthropic"
      : protocol === "text-completions"
        ? "text-completion"
        : "openai-compatible";
  const auth = target.connection.auth;
  return {
    provider,
    baseUrl: target.connection.baseUrl ?? "",
    model: provider === "dry-run" && target.model.remoteId === "dry-run"
      ? ""
      : target.model.remoteId,
    apiKeyEnv: auth.type === "bearer-env" || auth.type === "header-env" ? auth.env : null,
    ...(target.connection.allowInsecureHttp === true ? { allowInsecureHttp: true } : {}),
    ...(protocol === "openai-codex-responses" || protocol === "anthropic-subscription-messages"
      ? { protocol }
      : {}),
    temperature: target.profile.temperature,
    maxTokens: target.profile.maxOutputTokens,
    systemPrompt: "",
    contextWindow: target.model.overrides.contextWindow
      ?? target.model.discovered.contextWindow
      ?? null
  };
}

function generationProfileV5FromV2(profile: GenerationProfileV2): GenerationProfileV5 {
  const { effort, ...rest } = profile;
  return {
    ...rest,
    generationReasoning: legacyGenerationReasoningV5(effort)
  };
}

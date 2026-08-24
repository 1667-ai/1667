import { ANTHROPIC_MODELS as PI_ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { OPENAI_CODEX_MODELS as PI_OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";

import {
  discoverBundledModels,
  type BundledCatalogModel
} from "../../shared/model-discovery-catalog.js";
import {
  isSubscriptionProtocolV2,
  type DiscoveredModelV2,
  type ModelDiscoveryResultV2,
  type ModelDiscoverySourceV2,
  type SubscriptionProtocolV2
} from "../../shared/settings-v2-types.js";
import {
  generationSettingsFromProbeTarget,
  isProviderProbeRouteV1,
  type ProviderProbeTarget
} from "../../shared/provider-probe-route-v1.js";


export type DemoSubscriptionCatalogs = Readonly<
  Record<SubscriptionProtocolV2, readonly BundledCatalogModel[]>
>;

const SUBSCRIPTION_CATALOGS: DemoSubscriptionCatalogs = {
  "openai-codex-responses": Object.values(PI_OPENAI_CODEX_MODELS),
  "anthropic-subscription-messages": Object.values(PI_ANTHROPIC_MODELS)
};

const OPENAI_MODELS = [
  {
    remoteId: "gpt-5.4",
    name: "GPT-5.4",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000
  },
  {
    remoteId: "gpt-5-mini",
    name: "GPT-5 mini",
    contextWindow: 400_000,
    maxOutputTokens: 128_000
  }
] satisfies readonly Omit<DiscoveredModelV2, "source">[];

const ANTHROPIC_MODELS = [
  {
    remoteId: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000
  },
  {
    remoteId: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    contextWindow: 200_000,
    maxOutputTokens: 64_000
  }
] satisfies readonly Omit<DiscoveredModelV2, "source">[];

/** Return API fixtures or the bundled plan catalog for the demo API. */
export function discoverDemoModels(
  target: ProviderProbeTarget,
  subscriptionCatalogs: DemoSubscriptionCatalogs = SUBSCRIPTION_CATALOGS
): ModelDiscoveryResultV2 {
  let settings;
  let protocol;
  if (isProviderProbeRouteV1(target)) {
    settings = generationSettingsFromProbeTarget(target);
    protocol = target.connection.protocol;
  } else {
    settings = target;
    protocol = target.protocol ?? null;
  }
  if (protocol !== null && isSubscriptionProtocolV2(protocol)) {
    return {
      observedAt: "2026-01-01T00:00:00.000Z",
      models: discoverBundledModels(subscriptionCatalogs[protocol])
    };
  }
  const anthropic = settings.provider === "anthropic";
  const source: ModelDiscoverySourceV2 = anthropic
    ? "anthropic-models"
    : "openai-models";
  const catalog = anthropic ? ANTHROPIC_MODELS : OPENAI_MODELS;
  return {
    observedAt: "2026-01-01T00:00:00.000Z",
    models: catalog.map((model) => ({ ...model, source }))
  };
}

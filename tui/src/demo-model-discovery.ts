import { basicSettingsFromDocument } from "../../shared/settings-basic-draft.js";
import {
  isSubscriptionProtocolV2,
  type DiscoveredModelV2,
  type ModelDiscoveryResultV2,
  type ModelDiscoverySourceV2,
  type ProviderProbeTarget
} from "../../shared/settings-v2-types.js";
import { selectSettingsRoute } from "../../shared/settings-route.js";

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

/** Return deterministic provider-specific model fixtures for the demo API. */
export function discoverDemoModels(
  target: ProviderProbeTarget
): ModelDiscoveryResultV2 {
  const route = "kind" in target
    ? selectSettingsRoute(target.document, target.purpose)
    : null;
  const settings = route === null
    ? target
    : basicSettingsFromDocument(target.document, route.profileId);
  const protocol = route?.connection.protocol ?? settings.protocol ?? null;
  const subscription = protocol !== null && isSubscriptionProtocolV2(protocol);
  const anthropic = settings.provider === "anthropic";
  const source: ModelDiscoverySourceV2 = subscription
    ? "pi-catalog"
    : anthropic
      ? "anthropic-models"
      : "openai-models";
  const catalog = anthropic ? ANTHROPIC_MODELS : OPENAI_MODELS;
  return {
    observedAt: "2026-01-01T00:00:00.000Z",
    models: catalog.map((model) => ({ ...model, source }))
  };
}

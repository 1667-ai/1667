import type { SubscriptionProtocolV2 } from "../shared/settings-v2-types.js";

/** The one server-side mapping from settings protocols to Pi providers. */
export const SUBSCRIPTION_PROTOCOLS = Object.freeze({
  chatgpt: "openai-codex-responses",
  claude: "anthropic-subscription-messages"
} as const);

// Compatibility alias for the credential-store seam while its owner updates
// imports. The type and guard are owned by shared/settings-v2-types.ts.
export type SubscriptionProtocol = SubscriptionProtocolV2;

export function subscriptionProviderForProtocol(
  value: SubscriptionProtocolV2
): "openai-codex" | "anthropic" {
  return value === SUBSCRIPTION_PROTOCOLS.chatgpt
    ? "openai-codex"
    : "anthropic";
}

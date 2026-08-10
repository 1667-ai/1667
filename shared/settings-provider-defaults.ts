import type { ConnectionTimeoutsV2, ModelCapabilitiesV2 } from "./settings-v2-types.js";
import type { Provider } from "./types.js";

/** Canonical provider defaults. This shared policy leaf has no server or UI dependencies. */
const DRY_RUN_CONNECTION_TIMEOUTS: ConnectionTimeoutsV2 = {
  responseHeaderMs: 1_000,
  firstTokenMs: 1_000,
  idleMs: 1_000,
  totalMs: 5_000
};

const NETWORK_CONNECTION_TIMEOUTS: ConnectionTimeoutsV2 = {
  responseHeaderMs: 120_000,
  firstTokenMs: 120_000,
  idleMs: 120_000,
  totalMs: 1_800_000
};

const DRY_RUN_MODEL_CAPABILITIES: ModelCapabilitiesV2 = {
  temperature: "supported",
  assistantPrefill: "unsupported",
  reasoningEffort: "unsupported",
  promptCaching: "unsupported"
};

const NETWORK_MODEL_CAPABILITIES: ModelCapabilitiesV2 = {
  temperature: "supported",
  assistantPrefill: "unknown",
  reasoningEffort: "unknown",
  promptCaching: "unknown"
};

export function defaultConnectionTimeouts(provider: Provider): ConnectionTimeoutsV2 {
  return provider === "dry-run"
    ? DRY_RUN_CONNECTION_TIMEOUTS
    : NETWORK_CONNECTION_TIMEOUTS;
}

/** Raw text completion has no channel a model could return reasoning on, so
 *  this is the one protocol that can refuse the capability up front rather
 *  than leaving it unknown until a response arrives. */
const TEXT_COMPLETION_MODEL_CAPABILITIES: ModelCapabilitiesV2 = {
  ...NETWORK_MODEL_CAPABILITIES,
  reasoningContent: "unsupported"
};

export function defaultModelCapabilities(provider: Provider): ModelCapabilitiesV2 {
  if (provider === "dry-run") return DRY_RUN_MODEL_CAPABILITIES;
  if (provider === "text-completion") return TEXT_COMPLETION_MODEL_CAPABILITIES;
  return NETWORK_MODEL_CAPABILITIES;
}

/** A protocol or preset label does not make an arbitrary gateway an official
 * provider endpoint. Cache and billing contracts may use these identities only
 * for the provider-owned hosts. */
export function isOfficialAnthropicBaseUrl(value: string): boolean {
  return hasExactHttpsHost(value, "api.anthropic.com");
}

export function isOfficialOpenAiBaseUrl(value: string): boolean {
  return hasExactHttpsHost(value, "api.openai.com");
}

function hasExactHttpsHost(value: string, hostname: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname.toLowerCase() === hostname
      && url.username.length === 0
      && url.password.length === 0;
  } catch {
    return false;
  }
}

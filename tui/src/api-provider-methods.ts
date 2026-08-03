import type { StoryAggregateVersion } from "../../shared/story-aggregate-version.js";
import { WORKER_PROVIDER_CHECK_TIMEOUT_MS } from "../../shared/worker-protocol.js";
import { decodeModelDiscoveryResult } from "../../shared/settings-response-decoder.js";
import {
  decodeContextWindowResponse,
  decodeModelServerCheckResponse,
  decodePromptTokenCount
} from "./api-response-decoders.js";
import type { StoryApi } from "./api.js";

/** These four calls all reach the same running model server rather than the
 * 1667 backend: they check it is alive, probe its context window, list its
 * models, and count tokens against it. `PROVIDER_CHECK_METHODS` in
 * worker-protocol.ts names the same four, and http-operation-policy.ts gives
 * them the shared `"provider-check"` lifetime that sets their timeout.
 * Keeping them together means the next provider-check call has one home. */
export type ProviderMethods = Pick<
  StoryApi,
  | "checkModelServer"
  | "probeContextWindow"
  | "discoverModels"
  | "countPromptTokens"
>;

/** What the provider methods borrow from the API they belong to. */
export interface ProviderMethodCore {
  request<T>(
    method: string,
    path: string,
    decode: (payload: unknown) => T,
    body?: unknown,
    timeoutMs?: number,
    expectedAggregateVersion?: StoryAggregateVersion,
    callerSignal?: AbortSignal
  ): Promise<T>;
}

export function providerMethods(core: ProviderMethodCore): ProviderMethods {
  return {
    checkModelServer: (settings) =>
      core.request("POST", "/api/settings/check-server", decodeModelServerCheckResponse, settings),
    probeContextWindow: (settings) => core.request(
      "POST",
      "/api/settings/probe-context",
      decodeContextWindowResponse,
      settings,
      WORKER_PROVIDER_CHECK_TIMEOUT_MS
    ),
    discoverModels: (settings, signal) => core.request(
      "POST",
      "/api/settings/discover-models",
      decodeModelDiscoveryResult,
      settings,
      WORKER_PROVIDER_CHECK_TIMEOUT_MS,
      undefined,
      signal
    ),
    countPromptTokens: (messages, signal) => core.request(
      "POST",
      "/api/settings/count-tokens",
      decodePromptTokenCount,
      { messages },
      WORKER_PROVIDER_CHECK_TIMEOUT_MS,
      undefined,
      signal
    )
  };
}

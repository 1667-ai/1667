import {
  createModels,
  type CredentialStore,
  type Models
} from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

const CLOSED_AUTH_CONTEXT = Object.freeze({
  env: async () => undefined,
  fileExists: async () => false
});

/** Build the fixed Pi coordinator for the two subscription providers. */
export function createSubscriptionModels(
  credentials: CredentialStore
): Models {
  registerBunOAuthFlows();
  const models = createModels({ credentials, authContext: CLOSED_AUTH_CONTEXT });
  models.setProvider(openaiCodexProvider());
  models.setProvider(anthropicProvider());
  return models;
}

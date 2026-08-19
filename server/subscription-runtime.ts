import type { CredentialStore, Models } from "@earendil-works/pi-ai";
import type {
  SettingsDocumentV2,
  SettingsStateV2
} from "../shared/settings-v2-types.js";
import {
  SUBSCRIPTION_SECRET_IDS,
  createSubscriptionCredentialStore
} from "./subscription-credential-store.js";
import { createSubscriptionModels } from "./subscription-models.js";

/** Runtime-only Pi dependencies for the two fixed subscription protocols. */
export interface SubscriptionRuntimeDependencies {
  readonly credentials: CredentialStore;
  readonly models: Models;
}

/** Create one shared subscription runtime for a machine-tier secret store. */
export function createSubscriptionRuntime(
  secretsDir: string
): SubscriptionRuntimeDependencies {
  const credentials = createSubscriptionCredentialStore(secretsDir);
  return {
    credentials,
    models: createSubscriptionModels(credentials)
  };
}

/** Return all settings and subscription secret IDs that pruning must retain. */
export function providerSecretIdsToKeep(state: SettingsStateV2): Set<string> {
  const ids = storedSecretIdsInState(state);
  for (const secretId of Object.values(SUBSCRIPTION_SECRET_IDS)) {
    ids.add(secretId);
  }
  return ids;
}

export function storedSecretIdsInDocument(
  document: SettingsDocumentV2
): Set<string> {
  const ids = new Set<string>();
  for (const connection of Object.values(document.connections)) {
    if (
      connection.auth.type === "bearer-stored"
      || connection.auth.type === "header-stored"
    ) ids.add(connection.auth.secretId);
  }
  return ids;
}

export function storedSecretIdsInState(state: SettingsStateV2): Set<string> {
  const ids = new Set<string>();
  for (const document of Object.values(state.documents)) {
    for (const secretId of storedSecretIdsInDocument(document)) ids.add(secretId);
  }
  return ids;
}

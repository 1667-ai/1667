import type { Credential, CredentialStore, Models } from "@earendil-works/pi-ai";
import type {
  SubscriptionAuthState
} from "../shared/settings-v2-types.js";
import type { CredentialBearingSettingsDocument } from "../shared/settings-credential-slots.js";
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

/** Read the safe sign-in state used by Settings and auth status surfaces. */
export async function readSubscriptionAuthState(
  credentials: Pick<CredentialStore, "read">
): Promise<SubscriptionAuthState> {
  const [chatgpt, claude] = await Promise.all([
    readSubscriptionCredentialStatus(credentials, "openai-codex"),
    readSubscriptionCredentialStatus(credentials, "anthropic")
  ]);
  return { chatgpt, claude };
}

/** A credential is signed in when its local OAuth envelope has usable fields.
 * Expiry does not make it signed out: Pi can refresh it on next use. */
export function isUsableOAuthCredential(
  credential: Credential | undefined
): credential is Extract<Credential, { type: "oauth" }> {
  return credential?.type === "oauth"
    && typeof credential.access === "string"
    && credential.access.length > 0
    && typeof credential.refresh === "string"
    && credential.refresh.length > 0
    && Number.isFinite(credential.expires);
}

async function readSubscriptionCredentialStatus(
  credentials: Pick<CredentialStore, "read">,
  providerId: "openai-codex" | "anthropic"
): Promise<"signed-in" | "signed-out"> {
  try {
    return isUsableOAuthCredential(await credentials.read(providerId))
      ? "signed-in"
      : "signed-out";
  } catch {
    // Settings must stay usable when one machine-tier envelope is corrupt or
    // unavailable. A status is positive only when it can be proved.
    return "signed-out";
  }
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
export function providerSecretIdsToKeep(
  state: { readonly documents: Readonly<Record<string, CredentialBearingSettingsDocument>> }
): Set<string> {
  const ids = storedSecretIdsInState(state);
  for (const secretId of Object.values(SUBSCRIPTION_SECRET_IDS)) {
    ids.add(secretId);
  }
  return ids;
}

export function storedSecretIdsInDocument(
  document: CredentialBearingSettingsDocument
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

export function storedSecretIdsInState(
  state: { readonly documents: Readonly<Record<string, CredentialBearingSettingsDocument>> }
): Set<string> {
  const ids = new Set<string>();
  for (const document of Object.values(state.documents)) {
    for (const secretId of storedSecretIdsInDocument(document)) ids.add(secretId);
  }
  return ids;
}

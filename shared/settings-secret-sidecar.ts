import type {
  ModelConnectionV2
} from "./settings-v2-types.js";
import type { SettingsDocumentV5 as SettingsDocumentV2 } from "./settings-v5-types.js";
import { validateProviderSecretValue } from "./provider-secret-value.js";
import { resolveSettingsProfile } from "./settings-route.js";
import { storedCredentialSecretId } from "./settings-stored-credential.js";
import { MAX_SETTINGS_ID_SCALARS } from "./settings-validation-scalars.js";
import { isolateSettingsProfileConnection } from "./settings-profile-draft.js";
import {
  settingsTextDraftForDocument,
  settingsTextDraftWithGeneration,
  type SettingsTextDraft
} from "./settings-text-draft.js";

/** A draft and the write-only key material that goes with it. The functions
 * below edit this object in place. A caller that must observe each draft
 * change, as the terminal does to track model provenance, passes an object
 * whose `draft` is an accessor. */
export interface SettingsSecretSidecarState {
  draft: SettingsTextDraft;
  secrets: Readonly<Record<string, string | null>>;
}

export function applyStoredApiKeyEdit(
  state: SettingsSecretSidecarState,
  value: string
): string | null {
  if (state.draft.document === null || state.draft.selectedProfileId === null) {
    return "Stored API keys require editable format-2 settings";
  }
  try {
    if (value.length > 0) validateProviderSecretValue(value);
  } catch (error) {
    return (error instanceof Error ? error.message : "Stored API key is invalid")
      .replace(/^Stored API key/u, "API key");
  }
  try {
    // An untouched blank field is a no-op. Do not replace the document object:
    // model discovery keys its result to the selected connection identity.
    if (value.length === 0
      && storedCredentialSecretId(selectedConnection(state).connection.auth) === null) {
      discardUnreferencedConnectionSecretWrites(state);
      return null;
    }
    const document = isolateSettingsProfileConnection(
      state.draft.document,
      state.draft.selectedProfileId
    );
    const generation = state.draft.generation;
    state.draft = settingsTextDraftForDocument(document, state.draft.selectedProfileId);
    state.draft = settingsTextDraftWithGeneration(state.draft, {
      ...generation,
      apiKeyEnv: null
    });
    const selected = selectedConnection(state);
    const existingSecretId = storedCredentialSecretId(selected.connection.auth);
    if (value.length === 0) {
      replaceSelectedConnectionAuth(state, { type: "none" });
      if (existingSecretId !== null) queueDeletionIfUnreferenced(state, existingSecretId);
      discardUnreferencedConnectionSecretWrites(state);
      return null;
    }
    const secretId = mintStoredSecretId(selected.connectionId);
    state.secrets = { ...state.secrets, [secretId]: value };
    replaceSelectedConnectionAuth(state, storedAuthFor(selected.connection, secretId));
    discardUnreferencedConnectionSecretWrites(state);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

/** One stored-presence signal for the selected connection. Pending changes to
 * other profiles must not change this row. */
export function hasStoredApiKey(
  state: SettingsSecretSidecarState
): boolean {
  try {
    const secretId = storedCredentialSecretId(selectedConnection(state).connection.auth);
    if (secretId === null) return false;
    const pending = state.secrets[secretId];
    return pending === undefined ? true : typeof pending === "string";
  } catch {
    return false;
  }
}

export function rekeyPendingStoredSecret(
  state: SettingsSecretSidecarState
): void {
  try {
    const selected = selectedConnection(state);
    const previousId = storedCredentialSecretId(selected.connection.auth);
    if (previousId === null) return;
    const pending = state.secrets[previousId];
    if (typeof pending !== "string") return;
    const secretId = mintStoredSecretId(selected.connectionId);
    state.secrets = { ...state.secrets, [secretId]: pending };
    replaceSelectedConnectionAuth(state, storedAuthFor(selected.connection, secretId));
    discardUnreferencedConnectionSecretWrites(state);
  } catch {
    // The active edit/save path reports invalid draft structure. A provider
    // cycler never redirects a pending secret to an unrelated default route.
  }
}

export function sameConnectionSecrets(
  left: Readonly<Record<string, string | null>>,
  right: Readonly<Record<string, string | null>>
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) =>
      key === rightKeys[index] && left[key] === right[key]);
}

function selectedConnection(state: SettingsSecretSidecarState): {
  readonly connectionId: string;
  readonly connection: ModelConnectionV2;
} {
  const document = state.draft.document;
  const profileId = state.draft.selectedProfileId;
  if (document === null || profileId === null) {
    throw new Error("Stored API keys require editable format-2 settings");
  }
  return profileConnectionInDocument(document, profileId);
}

function profileConnectionInDocument(
  document: SettingsDocumentV2,
  profileId: string
): {
  readonly connectionId: string;
  readonly connection: ModelConnectionV2;
} {
  const route = resolveSettingsProfile(document, profileId);
  return {
    connectionId: route.model.connectionId,
    connection: route.connection
  };
}

function replaceSelectedConnectionAuth(
  state: SettingsSecretSidecarState,
  auth: ModelConnectionV2["auth"]
): void {
  const document = state.draft.document;
  const profileId = state.draft.selectedProfileId;
  if (document === null || profileId === null) {
    throw new Error("Stored API keys require editable format-2 settings");
  }
  const selected = profileConnectionInDocument(document, profileId);
  state.draft = settingsTextDraftForDocument({
    ...document,
    connections: {
      ...document.connections,
      [selected.connectionId]: { ...selected.connection, auth }
    }
  }, profileId);
}

function storedAuthFor(
  connection: ModelConnectionV2,
  secretId: string
): ModelConnectionV2["auth"] {
  return connection.protocol === "anthropic-messages"
    ? { type: "header-stored", name: "x-api-key", secretId }
    : { type: "bearer-stored", secretId };
}

/** Keep a write only while the current draft still references it. A deletion
 * remains even though its reference has gone, because the save must remove the
 * old persisted value. */
export function discardUnreferencedConnectionSecretWrites(state: SettingsSecretSidecarState): void {
  const referenced = storedSecretIdsInDraft(state);
  state.secrets = Object.fromEntries(
    Object.entries(state.secrets).filter(
      ([secretId, value]) => value === null || referenced.has(secretId)
    )
  );
}

/** Delete only after every profile stopped referencing the credential. A key
 * entered and then cleared before save has no stored value, so drop its write. */
function queueDeletionIfUnreferenced(
  state: SettingsSecretSidecarState,
  secretId: string
): void {
  if (storedSecretIdsInDraft(state).has(secretId)) return;
  if (typeof state.secrets[secretId] === "string") {
    const connectionSecrets = { ...state.secrets };
    delete connectionSecrets[secretId];
    state.secrets = connectionSecrets;
    return;
  }
  state.secrets = { ...state.secrets, [secretId]: null };
}

function storedSecretIdsInDraft(state: SettingsSecretSidecarState): ReadonlySet<string> {
  const document = state.draft.document;
  const referenced = new Set<string>();
  if (document === null) return referenced;
  for (const connection of Object.values(document.connections)) {
    const secretId = storedCredentialSecretId(connection.auth);
    if (secretId !== null) referenced.add(secretId);
  }
  return referenced;
}

/** Every entered key gets a fresh ID. The server treats a stored secret ID
 * as an immutable binding of one credential target to one value: reusing an
 * ID across a provider or endpoint change would overwrite the value the
 * still-active revision resolves, so the save would be refused. The shared
 * machine tier holds every project's keys under one namespace, so the suffix
 * is a crypto-strength UUID: two projects minting for the same connection ID
 * must never collide onto one credential slot. */
function mintStoredSecretId(connectionId: string): string {
  const suffix = `.k${crypto.randomUUID()}`;
  return `${connectionId.slice(0, MAX_SETTINGS_ID_SCALARS - suffix.length)}${suffix}`;
}

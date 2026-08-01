import type {
  ModelConnectionV2,
  SettingsDocumentV2
} from "../../shared/settings-v2-types.js";
import { validateProviderSecretValue } from "../../shared/provider-secret-value.js";
import { resolveSettingsProfile } from "../../shared/settings-route.js";
import { storedCredentialSecretId } from "../../shared/settings-stored-credential.js";
import { MAX_SETTINGS_ID_SCALARS } from "../../server/settings-v2-scalars.js";
import type { SettingsOverlayState } from "./state.js";
import { isolateSettingsProfileConnection } from "./settings-profile-draft.js";
import {
  settingsTextDraftForDocument,
  settingsTextDraftWithGeneration
} from "./settings-text.js";

export function applyStoredApiKeyEdit(
  overlay: SettingsOverlayState,
  value: string
): string | null {
  if (overlay.draft.document === null || overlay.draft.selectedProfileId === null) {
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
      && storedCredentialSecretId(selectedConnection(overlay).connection.auth) === null) {
      discardUnreferencedConnectionSecretWrites(overlay);
      return null;
    }
    const document = isolateSettingsProfileConnection(
      overlay.draft.document,
      overlay.draft.selectedProfileId
    );
    overlay.draft = settingsTextDraftForDocument(document, overlay.draft.selectedProfileId);
    overlay.draft = settingsTextDraftWithGeneration(overlay.draft, {
      ...overlay.draft.generation,
      apiKeyEnv: null
    });
    const selected = selectedConnection(overlay);
    const existingSecretId = storedCredentialSecretId(selected.connection.auth);
    if (value.length === 0) {
      replaceSelectedConnectionAuth(overlay, { type: "none" });
      if (existingSecretId !== null) queueDeletionIfUnreferenced(overlay, existingSecretId);
      discardUnreferencedConnectionSecretWrites(overlay);
      return null;
    }
    const secretId = mintStoredSecretId(selected.connectionId);
    overlay.connectionSecrets = { ...overlay.connectionSecrets, [secretId]: value };
    replaceSelectedConnectionAuth(overlay, storedAuthFor(selected.connection, secretId));
    discardUnreferencedConnectionSecretWrites(overlay);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

export function storedApiKeyPresentation(
  overlay: SettingsOverlayState
): string {
  return hasStoredApiKey(overlay) ? "•••••••• · stored" : "—";
}

/** One stored-presence signal for the selected connection. Pending changes to
 * other profiles must not change this row. */
export function hasStoredApiKey(
  overlay: SettingsOverlayState
): boolean {
  try {
    const secretId = storedCredentialSecretId(selectedConnection(overlay).connection.auth);
    if (secretId === null) return false;
    const pending = overlay.connectionSecrets[secretId];
    return pending === undefined ? true : typeof pending === "string";
  } catch {
    return false;
  }
}

export function rekeyPendingStoredSecret(
  overlay: SettingsOverlayState
): void {
  try {
    const selected = selectedConnection(overlay);
    const previousId = storedCredentialSecretId(selected.connection.auth);
    if (previousId === null) return;
    const pending = overlay.connectionSecrets[previousId];
    if (typeof pending !== "string") return;
    const secretId = mintStoredSecretId(selected.connectionId);
    overlay.connectionSecrets = { ...overlay.connectionSecrets, [secretId]: pending };
    replaceSelectedConnectionAuth(overlay, storedAuthFor(selected.connection, secretId));
    discardUnreferencedConnectionSecretWrites(overlay);
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

function selectedConnection(overlay: SettingsOverlayState): {
  readonly connectionId: string;
  readonly connection: ModelConnectionV2;
} {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
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
  overlay: SettingsOverlayState,
  auth: ModelConnectionV2["auth"]
): void {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null) {
    throw new Error("Stored API keys require editable format-2 settings");
  }
  const selected = profileConnectionInDocument(document, profileId);
  overlay.draft = settingsTextDraftForDocument({
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
export function discardUnreferencedConnectionSecretWrites(overlay: SettingsOverlayState): void {
  const referenced = storedSecretIdsInDraft(overlay);
  overlay.connectionSecrets = Object.fromEntries(
    Object.entries(overlay.connectionSecrets).filter(
      ([secretId, value]) => value === null || referenced.has(secretId)
    )
  );
}

/** Delete only after every profile stopped referencing the credential. A key
 * entered and then cleared before save has no stored value, so drop its write. */
function queueDeletionIfUnreferenced(
  overlay: SettingsOverlayState,
  secretId: string
): void {
  if (storedSecretIdsInDraft(overlay).has(secretId)) return;
  if (typeof overlay.connectionSecrets[secretId] === "string") {
    const connectionSecrets = { ...overlay.connectionSecrets };
    delete connectionSecrets[secretId];
    overlay.connectionSecrets = connectionSecrets;
    return;
  }
  overlay.connectionSecrets = { ...overlay.connectionSecrets, [secretId]: null };
}

function storedSecretIdsInDraft(overlay: SettingsOverlayState): ReadonlySet<string> {
  const document = overlay.draft.document;
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

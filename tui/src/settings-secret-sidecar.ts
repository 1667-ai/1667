import type {
  ModelConnectionV2,
  SettingsDocumentV2,
  SettingsView
} from "../../shared/settings-v2-types.js";
import { validateProviderSecretValue } from "../../shared/provider-secret-value.js";
import { selectSettingsRoute } from "../../shared/settings-route.js";
import { storedCredentialSecretId } from "../../shared/settings-stored-credential.js";
import { MAX_SETTINGS_ID_SCALARS } from "../../server/settings-v2-scalars.js";
import type { SettingsOverlayState } from "./state.js";

/** Apply the write-only sidecar intent to auth references, never key material. */
export function applyStoredApiKeyIntent(
  document: SettingsDocumentV2,
  connectionSecrets: Readonly<Record<string, string | null>>
): SettingsDocumentV2 {
  const entries = Object.entries(connectionSecrets);
  if (entries.length === 0) return document;
  const selected = defaultConnectionInDocument(document);
  const stored = entries.find((entry): entry is [string, string] =>
    typeof entry[1] === "string"
  );
  const auth = stored === undefined
    ? { type: "none" as const }
    : selected.connection.protocol === "anthropic-messages"
      ? {
          type: "header-stored" as const,
          name: "x-api-key",
          secretId: stored[0]
        }
      : { type: "bearer-stored" as const, secretId: stored[0] };
  return {
    ...document,
    connections: {
      ...document.connections,
      [selected.connectionId]: { ...selected.connection, auth }
    }
  };
}

export function applyStoredApiKeyEdit(
  overlay: SettingsOverlayState,
  value: string
): string | null {
  const selected = defaultConnection(overlay.view);
  if (selected === null) {
    return "Stored API keys require editable format-2 settings";
  }
  const existingSecretId = storedCredentialSecretId(selected.connection.auth);
  if (value.length === 0) {
    overlay.connectionSecrets = existingSecretId === null
      ? {}
      : { [existingSecretId]: null };
    return null;
  }
  try {
    validateProviderSecretValue(value);
  } catch (error) {
    return (error instanceof Error ? error.message : "Stored API key is invalid")
      .replace(/^Stored API key/u, "API key");
  }
  const secretId = mintStoredSecretId(selected.connectionId);
  overlay.connectionSecrets = { [secretId]: value };
  overlay.draft = {
    ...overlay.draft,
    generation: { ...overlay.draft.generation, apiKeyEnv: null }
  };
  return null;
}

export function storedApiKeyPresentation(
  overlay: SettingsOverlayState
): string {
  return hasStoredApiKey(overlay) ? "•••••••• · stored" : "—";
}

/** One stored-presence signal for provider changes and the masked UI. Pending
 * writes/deletes override the saved default-route credential. */
export function hasStoredApiKey(
  overlay: SettingsOverlayState
): boolean {
  const pending = Object.values(overlay.connectionSecrets);
  if (pending.some((value) => typeof value === "string")) {
    return true;
  }
  if (pending.some((value) => value === null)) return false;
  const connection = defaultConnection(overlay.view)?.connection;
  return connection !== undefined
    && storedCredentialSecretId(connection.auth) !== null;
}

export function rekeyPendingStoredSecret(
  overlay: SettingsOverlayState
): void {
  const pending = Object.values(overlay.connectionSecrets).find(
    (value): value is string => typeof value === "string"
  );
  if (pending === undefined) return;
  const selected = defaultConnection(overlay.view);
  if (selected === null) return;
  const secretId = mintStoredSecretId(selected.connectionId);
  overlay.connectionSecrets = { [secretId]: pending };
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

function defaultConnection(view: SettingsView): {
  readonly connectionId: string;
  readonly connection: ModelConnectionV2;
} | null {
  return view.editable ? defaultConnectionInDocument(view.document) : null;
}

function defaultConnectionInDocument(document: SettingsDocumentV2): {
  readonly connectionId: string;
  readonly connection: ModelConnectionV2;
} {
  const route = selectSettingsRoute(document, "default");
  return {
    connectionId: route.model.connectionId,
    connection: route.connection
  };
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

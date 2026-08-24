import { applyBasicSettingsProbeDraft } from "../../shared/settings-basic-draft.js";
import type {
  ModelConnectionV2,
  SettingsView
} from "../../shared/settings-v2-types.js";
import type { SettingsDocumentV5 } from "../../shared/settings-v5-types.js";
import type { GenerationSettings } from "../../shared/types.js";
import {
  resolveSettingsProfile,
  selectSettingsRoute
} from "../../shared/settings-route.js";
import { storedCredentialSecretId } from "../../shared/settings-stored-credential.js";
import {
  isProviderProbeRouteV1,
  providerProbeRouteFromV5Route,
  type ProviderProbeTarget
} from "../../shared/provider-probe-route-v1.js";

/** Editable format-2 drafts must retain document-only connection policy across
 * the probe boundary. Legacy views keep their effective runtime. A staged view
 * probes its pending document, so a failed activation stays testable.
 *
 * A key typed into the editor lives only in the sidecar until it is saved. The
 * probe carries both halves of that pending intent — the auth reference on the
 * document and the key material beside it — so reading the model list does not
 * have to wait for a save. Without it the probe would inherit the saved
 * connection's auth, which for a fresh provider is `none`, and every provider
 * that requires a key would answer 401. */
export function settingsProviderProbeTarget(
  view: SettingsView,
  settings: GenerationSettings,
  connectionSecrets: Readonly<Record<string, string | null>>,
  draftDocument?: SettingsDocumentV5 | null,
  selectedProfileId?: string | null
): ProviderProbeTarget {
  if (!view.editable) return settings;
  const profileId = selectedProfileId ?? view.document.routing.default;
  const source = draftDocument ?? view.document;
  if (source.profiles[profileId] === undefined) {
    throw new Error("Selected profile no longer exists");
  }
  const probeDocument = applyBasicSettingsProbeDraft(source, settings, profileId);
  const document = {
    ...probeDocument,
    routing: { ...probeDocument.routing, default: profileId }
  } as SettingsDocumentV5;
  const route = selectSettingsRoute(document, "default");
  const secretId = storedCredentialSecretId(
    resolveSettingsProfile(document, profileId).connection.auth
  );
  const pendingSecret = secretId === null ? undefined : connectionSecrets[secretId];
  return providerProbeRouteFromV5Route(
    route,
    typeof pendingSecret !== "string" || secretId === null
      ? undefined
      : { [secretId]: pendingSecret }
  );
}

export function settingsModelTargetFingerprint(
  view: SettingsView,
  settings: GenerationSettings,
  connectionSecrets: Readonly<Record<string, string | null>>,
  draftDocument?: SettingsDocumentV5 | null,
  selectedProfileId?: string | null
): string {
  const target = settingsProviderProbeTarget(
    view,
    settings,
    connectionSecrets,
    draftDocument,
    selectedProfileId
  );
  const connection = isProviderProbeRouteV1(target)
    ? modelDiscoveryConnectionTarget(target.connection)
    : null;
  const secretIntent = isProviderProbeRouteV1(target)
    ? Object.keys(target.secrets ?? {})
      .sort((left, right) => left.localeCompare(right))
      .map((id) => [id, "replace"] as const)
    : [];
  return JSON.stringify([
    settings.provider,
    settings.baseUrl,
    settings.apiKeyEnv,
    settings.allowInsecureHttp === true,
    connection,
    secretIntent
  ]);
}

function modelDiscoveryConnectionTarget(
  connection: ModelConnectionV2
) {
  return {
    preset: connection.preset,
    protocol: connection.protocol,
    baseUrl: connection.baseUrl,
    auth: connection.auth,
    headers: connection.headers,
    timeoutMs: connection.timeouts.totalMs,
    ...(connection.allowInsecureHttp === true
      ? { allowInsecureHttp: true as const }
      : {})
  };
}

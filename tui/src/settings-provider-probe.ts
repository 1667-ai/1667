import { applyBasicSettingsProbeDraft } from "../../shared/settings-basic-draft.js";
import type {
  ProviderProbeTarget,
  SettingsDocumentV2,
  SettingsView
} from "../../shared/settings-v2-types.js";
import type { GenerationSettings } from "../../shared/types.js";
import { resolveSettingsProfile } from "../../shared/settings-route.js";
import { storedCredentialSecretId } from "../../shared/settings-stored-credential.js";

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
  draftDocument?: SettingsDocumentV2 | null,
  selectedProfileId?: string | null
): ProviderProbeTarget {
  if (!view.editable) return settings;
  const profileId = selectedProfileId ?? view.document.routing.default;
  const source = draftDocument ?? view.document;
  if (source.profiles[profileId] === undefined) {
    throw new Error("Selected profile no longer exists");
  }
  const probeDocument = applyBasicSettingsProbeDraft(source, settings, profileId);
  // Provider APIs expose only a route purpose. Pin this transient probe copy to
  // the selected profile instead of inventing a profile-specific purpose.
  const document = {
    ...probeDocument,
    routing: { ...probeDocument.routing, default: profileId }
  };
  const secretId = storedCredentialSecretId(
    resolveSettingsProfile(document, profileId).connection.auth
  );
  const pendingSecret = secretId === null ? undefined : connectionSecrets[secretId];
  return {
    kind: "settings-document",
    document,
    purpose: "default",
    ...(typeof pendingSecret !== "string" || secretId === null
      ? {}
      : { secrets: { [secretId]: pendingSecret } })
  };
}

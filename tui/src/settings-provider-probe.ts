import { applyBasicSettingsProbeDraft } from "../../shared/settings-basic-draft.js";
import type {
  ProviderProbeTarget,
  SettingsView
} from "../../shared/settings-v2-types.js";
import type { GenerationSettings } from "../../shared/types.js";
import { applyStoredApiKeyIntent } from "./settings-secret-sidecar.js";

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
  connectionSecrets: Readonly<Record<string, string | null>>
): ProviderProbeTarget {
  if (!view.editable) return settings;
  const document = applyStoredApiKeyIntent(
    applyBasicSettingsProbeDraft(view.document, settings),
    connectionSecrets
  );
  const pending = Object.entries(connectionSecrets).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  );
  return {
    kind: "settings-document",
    document,
    purpose: "default",
    ...(pending.length === 0
      ? {}
      : { secrets: Object.fromEntries(pending) })
  };
}

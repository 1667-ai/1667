import { applyBasicSettingsDraft } from "../../shared/settings-basic-draft.js";
import type {
  ProviderProbeTarget,
  SettingsView
} from "../../shared/settings-v2-types.js";
import type { GenerationSettings } from "../../shared/types.js";

/** Editable format-2 drafts must retain document-only connection policy across
 * the probe boundary. Legacy views keep their effective runtime. A staged view
 * probes its pending document, so a failed activation stays testable. */
export function settingsProviderProbeTarget(
  view: SettingsView,
  settings: GenerationSettings
): ProviderProbeTarget {
  if (!view.editable) return settings;
  return {
    kind: "settings-document",
    document: applyBasicSettingsDraft(view.document, settings),
    purpose: "default"
  };
}

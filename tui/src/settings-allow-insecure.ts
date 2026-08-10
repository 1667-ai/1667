import { replaceSettingsDraft } from "./settings-draft-transition.js";
import { settingsDraftChanged } from "./settings-overlay-reconciliation.js";
import { settingsTextDraftWithGeneration } from "./settings-text.js";
import type { SettingsOverlayState } from "./state.js";

export function cycleAllowInsecureHttp(overlay: SettingsOverlayState): boolean {
  const allowInsecureHttp = overlay.draft.generation.allowInsecureHttp !== true;
  const generation = { ...overlay.draft.generation };
  if (allowInsecureHttp) generation.allowInsecureHttp = true;
  else delete generation.allowInsecureHttp;
  replaceSettingsDraft(
    overlay,
    settingsTextDraftWithGeneration(overlay.draft, generation)
  );
  overlay.result = null;
  if (!settingsDraftChanged(overlay)) overlay.conflict = null;
  else if (overlay.conflict !== null) overlay.conflict.armed = false;
  return allowInsecureHttp;
}

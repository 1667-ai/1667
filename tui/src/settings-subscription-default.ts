import { replaceSettingsProviderDraft } from "./settings-draft-transition.js";
import { settingsDraftChanged } from "./settings-overlay-reconciliation.js";
import {
  settingsTextDraftWithSubscriptionPlan
} from "./settings-text.js";
import {
  settingsSubscriptionAutoPreset
} from "./settings-subscription.js";
import type { ActiveSettingsEdit } from "./settings-edit-state.js";
import type { SettingsOverlayState } from "./state.js";
import { SETTINGS_PROVIDER_CHOICES } from "./settings-provider-choices.js";

/** Apply one signed-in plan only to the untouched built-in draft.
 * The selected plan remains a draft until the writer saves Settings. */
export function autoSelectSettingsSubscriptionPlan(
  overlay: SettingsOverlayState,
  activeEdit: ActiveSettingsEdit | null
): boolean {
  if (activeEdit !== null || !overlay.view.editable || settingsDraftChanged(overlay)) return false;
  const preset = settingsSubscriptionAutoPreset(overlay.view);
  if (preset === null || overlay.view.subscriptionAutoSelectEligible !== true) return false;
  const choice = SETTINGS_PROVIDER_CHOICES.find((candidate) => candidate.id === preset);
  if (choice === undefined) return false;
  const generation = {
    ...overlay.draft.generation,
    provider: choice.provider,
    ...choice.defaults
  };
  replaceSettingsProviderDraft(
    overlay,
    settingsTextDraftWithSubscriptionPlan(overlay.draft, preset, generation)
  );
  return true;
}

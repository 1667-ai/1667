import { isSubscriptionPresetV2 } from "../../shared/settings-v2-types.js";
import { resolveSettingsProfile } from "../../shared/settings-route.js";
import type { SettingsOverlayState, SettingsRowId } from "./state.js";

export type SettingsSubscriptionPreset = "chatgpt-plan" | "claude-plan";

const SUBSCRIPTION_HIDDEN_ROWS: ReadonlySet<SettingsRowId> = new Set([
  "base-url",
  "allow-insecure-http",
  "api-key"
]);

/** Return the fixed subscription preset on the selected editable route. */
export function settingsSubscriptionPreset(
  overlay: SettingsOverlayState
): SettingsSubscriptionPreset | null {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null) return null;
  try {
    const preset = resolveSettingsProfile(document, profileId).connection.preset;
    return isSubscriptionPresetV2(preset) ? preset : null;
  } catch {
    return null;
  }
}

/** Keep the keyboard list and rendered rows on the same fixed-plan shape. */
export function settingsSubscriptionRowVisible(
  overlay: SettingsOverlayState,
  row: SettingsRowId
): boolean {
  return settingsSubscriptionPreset(overlay) === null
    || !SUBSCRIPTION_HIDDEN_ROWS.has(row);
}

/** Controls that have no meaning on a plan connection. Hidden connection rows
 * use the same predicate as the guarded rows that remain in the form. */
export function settingsPlanRowDisabled(
  overlay: SettingsOverlayState,
  row: SettingsRowId
): boolean {
  if (settingsSubscriptionPreset(overlay) === null) return false;
  return !settingsSubscriptionRowVisible(overlay, row)
    || row === "text-prompt-format"
    || row === "split-think-tags"
    || row === "api-key-env";
}

export function settingsSubscriptionLoginHint(
  preset: SettingsSubscriptionPreset
): string {
  return preset === "chatgpt-plan"
    ? "Sign in with 1667 auth login chatgpt. ChatGPT output length is best effort."
    : "Sign in with 1667 auth login claude. Claude plan support is experimental.";
}

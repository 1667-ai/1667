import { isSubscriptionPresetV2 } from "../../shared/settings-v2-types.js";
import { resolveSettingsProfile } from "../../shared/settings-route.js";
import type {
  SettingsView,
  SubscriptionAuthState
} from "../../shared/settings-v2-types.js";
import type { SettingsOverlayState, SettingsRowId } from "./state.js";

export type SettingsSubscriptionPreset = "chatgpt-plan" | "claude-plan";

/** Return the one plan that Settings may offer as an automatic draft choice.
 * Both or neither signed-in plans leave the writer's provider untouched. */
export function settingsSubscriptionAutoPreset(
  view: SettingsView
): SettingsSubscriptionPreset | null {
  if (!view.editable || view.subscriptionAuth === undefined) return null;
  const signedIn = [
    view.subscriptionAuth.chatgpt === "signed-in" ? "chatgpt-plan" : null,
    view.subscriptionAuth.claude === "signed-in" ? "claude-plan" : null
  ].filter((preset): preset is SettingsSubscriptionPreset => preset !== null);
  return signedIn.length === 1 ? signedIn[0]! : null;
}

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
  preset: SettingsSubscriptionPreset,
  subscriptionAuth?: SubscriptionAuthState
): string {
  const signedIn = preset === "chatgpt-plan"
    ? subscriptionAuth?.chatgpt === "signed-in"
    : subscriptionAuth?.claude === "signed-in";
  if (signedIn) {
    return preset === "chatgpt-plan"
      ? "ChatGPT plan is signed in. ChatGPT output length is best effort."
      : "Claude plan is signed in. Claude plan support is experimental.";
  }
  return preset === "chatgpt-plan"
    ? "In a terminal, run 1667 auth login chatgpt to sign in. ChatGPT output length is best effort."
    : "In a terminal, run 1667 auth login claude to sign in. Claude plan support is experimental.";
}

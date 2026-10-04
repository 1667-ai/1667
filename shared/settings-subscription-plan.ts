import type { SettingsView, SubscriptionAuthState } from "./settings-v2-types.js";

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

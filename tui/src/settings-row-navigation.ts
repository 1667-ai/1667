import {
  CONNECTION_TIMEOUT_ROWS,
  isConnectionTimeoutRow
} from "./settings-connection-timeouts.js";
import {
  settingsModelChoices
} from "./settings-model-discovery.js";
import { modelPickerRequired } from "./settings-model-picker.js";
import { isSettingsScalarRow } from "./settings-scalar.js";
import type { SettingsOverlayState, SettingsRowId } from "./state.js";

/** The form's keyboard order. The prompt-layout experiment stays beside the
 * generation controls, and the row module owns its value and mutation. */
export const SETTINGS_ROW_IDS = [
  "theme",
  "compose-focus",
  "word-wrap",
  "system-prompt",
  "provider",
  "text-prompt-format",
  "split-think-tags",
  "base-url",
  "allow-insecure-http",
  "api-key",
  ...CONNECTION_TIMEOUT_ROWS,
  "profile",
  "model",
  "image-input",
  "temperature",
  "max-tokens",
  "sampling",
  "context-window",
  "effort",
  "cache-policy",
  "continuation-prompt",
  "token-probabilities",
  "reasoning",
  "keep-thoughts",
  "default-route",
  "prose-route",
  "utility-route"
] as const satisfies readonly SettingsRowId[];

/** Where a row sits in the cursor's list, or -1 for one the surface no longer
 * shows. `apiKeyEnv` is still a setting a config may carry; it stopped being
 * a row, so a semantic shortcut naming it simply leaves the cursor alone. */
export function settingsRowIndex(row: SettingsRowId): number {
  return (SETTINGS_ROW_IDS as readonly SettingsRowId[]).indexOf(row);
}

export function boundedSettingsCursor(value: number): number {
  return Math.max(0, Math.min(SETTINGS_ROW_IDS.length - 1, value));
}

/** Rows whose value is a closed choice: `←→` cycles them in place and their
 * value's brackets are click targets. Everything else is free text the row
 * editor owns. One spelling of the set, read by the panel and the key handler.
 * Deliberately not the inverse of `settingsRowUsesServer`: provider cycles and
 * is server-backed, while theme and compose focus cycle and are local. */
export function settingsRowCycles(row: SettingsRowId): boolean {
  return row === "theme"
    || row === "compose-focus"
    || row === "word-wrap"
    || row === "provider"
    || row === "text-prompt-format"
    || row === "split-think-tags"
    || row === "allow-insecure-http"
    || row === "profile"
    || row === "effort"
    || row === "cache-policy"
    || row === "continuation-prompt"
    || row === "token-probabilities"
    || row === "reasoning"
    || row === "keep-thoughts"
    || row === "default-route"
    || row === "prose-route"
    || row === "utility-route";
}

/** Rows `←→` acts on: a cycler steps through its options, a C-08 scalar steps
 * through its range. Both wear brackets or chevrons, which is what the arrows
 * are anchored to. */
export function settingsRowHasArrows(
  overlay: SettingsOverlayState,
  row: SettingsRowId
): boolean {
  return row === "text-prompt-format" || row === "split-think-tags"
    ? overlay.draft.generation.provider === "text-completion"
    : settingsRowCycles(row)
    || isSettingsScalarRow(row)
    || isConnectionTimeoutRow(row)
    // A cycler stops at eight; past that the option column owns the choice.
    || row === "model" && settingsModelChoices(overlay).length > 0
      && !modelPickerRequired(overlay);
}

import { WRITING_PROMPT_ROW_IDS } from "../../shared/settings-v5-writing.js";
import {
  CONNECTION_TIMEOUT_ROWS,
  isConnectionTimeoutRow
} from "./settings-connection-timeouts.js";
import {
  settingsModelChoices
} from "./settings-model-discovery.js";
import { isSettingsScalarRow } from "./settings-scalar.js";
import {
  settingsPlanRowDisabled,
  settingsSubscriptionRowVisible
} from "./settings-subscription.js";
import { settingsRowIsLocal } from "./settings-local-rows.js";
import { reasoningRowHasArrows } from "./settings-reasoning-row.js";
import { tokenProbabilitiesRowHasArrows } from "./settings-token-probabilities-row.js";
import { settingsSimpleModeRowVisible } from "./settings-view-mode.js";
import type { SettingsOverlayState, SettingsRowId } from "./state.js";

/** The form's keyboard order. The prompt-layout experiment stays beside the
 * generation controls, and the row module owns its value and mutation. */
export const SETTINGS_ROW_IDS = [
  "theme",
  "compose-focus",
  "word-wrap",
  "aside-thoughts",
  "update-checks",
  ...WRITING_PROMPT_ROW_IDS,
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

/** URL, plain-HTTP, and API-key controls do not apply to fixed subscription
 * connections. The provider row remains in the list so the writer can leave
 * the plan preset without a hidden cursor jump. `simple` mode narrows the
 * subscription-filtered list further, so a fixed subscription connection
 * stays hidden in both modes instead of the two visibility rules drifting
 * apart. */
export function settingsRowIds(
  overlay: SettingsOverlayState
): readonly SettingsRowId[] {
  const visible = SETTINGS_ROW_IDS.filter((row) => settingsSubscriptionRowVisible(overlay, row));
  return overlay.viewMode === "advanced"
    ? visible
    : visible.filter(settingsSimpleModeRowVisible);
}

/** Name the selected row before a profile or provider change can reshape the
 * list. The clamp also makes stale captured cursors harmless. */
export function settingsCursorRowIdentity(
  overlay: SettingsOverlayState
): SettingsRowId | null {
  const rows = settingsRowIds(overlay);
  const cursor = boundedSettingsCursor(overlay.cursor, overlay);
  return rows[cursor] ?? null;
}

/** Restore a cursor by row identity after the visible list changes. A removed
 * row falls back to the clamped old position. */
export function restoreSettingsCursor(
  overlay: SettingsOverlayState,
  row: SettingsRowId | null
): void {
  const rows = settingsRowIds(overlay);
  const preserved = row === null ? -1 : rows.indexOf(row);
  overlay.cursor = preserved >= 0
    ? preserved
    : boundedSettingsCursor(overlay.cursor, overlay);
}

/** Where a row sits in the cursor's list, or -1 for one the surface no longer
 * shows. `apiKeyEnv` is still a setting a config may carry; it stopped being
 * a row, so a semantic shortcut naming it simply leaves the cursor alone. */
export function settingsRowIndex(
  row: SettingsRowId,
  overlay: SettingsOverlayState
): number {
  return settingsRowIds(overlay).indexOf(row);
}

export function boundedSettingsCursor(
  value: number,
  overlay: SettingsOverlayState
): number {
  return Math.max(0, Math.min(settingsRowIds(overlay).length - 1, value));
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
    || row === "aside-thoughts"
    || row === "update-checks"
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

/** Rows that have no action at the current draft state. Keep this policy
 * beside the row navigation rules so the key handler, footer, and mouse hit
 * map do not advertise different controls. An image status row is
 * informational even when support is known; capability rows become
 * informational when the selected route cannot answer them. Server rows in a
 * read-only view can report their value, but they cannot accept an edit. */
export function settingsRowIsNonActionable(
  overlay: SettingsOverlayState,
  row: SettingsRowId
): boolean {
  if (row === "image-input" || settingsPlanRowDisabled(overlay, row)) return true;
  if (!overlay.view.editable && !settingsRowIsLocal(row)) return true;
  if (row === "token-probabilities" && !tokenProbabilitiesRowHasArrows(overlay)) return true;
  if (row === "reasoning" && !reasoningRowHasArrows(overlay)) return true;
  return false;
}

/** Rows `←→` acts on: a cycler steps through its options, a C-08 scalar steps
 * through its range. Both wear brackets or chevrons, which is what the arrows
 * are anchored to. */
export function settingsRowHasArrows(
  overlay: SettingsOverlayState,
  row: SettingsRowId
): boolean {
  if (settingsRowIsNonActionable(overlay, row)) return false;
  return row === "text-prompt-format" || row === "split-think-tags"
    ? overlay.draft.generation.provider === "text-completion"
    : settingsRowCycles(row)
    || isSettingsScalarRow(row)
    || isConnectionTimeoutRow(row)
    // Long lists and subscription catalogs still open the option column from
    // Enter, but their row arrows remain useful for quick adjacent choices.
    || row === "model" && settingsModelChoices(overlay).length > 0;
}

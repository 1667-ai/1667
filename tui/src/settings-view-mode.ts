import { WRITING_PROMPT_FIELD_DEFINITIONS } from "../../shared/settings-v5-writing.js";
import { saveConfig, type SettingsViewMode } from "./config.js";
import type { AppSource } from "./app.js";
import type { RuntimeState, SettingsOverlayState, SettingsRowId } from "./state.js";

/** Rows `simple` mode shows on every overlay. `base-url` and `api-key` are
 *  listed here too, but the subscription visibility filter
 *  (settings-subscription.ts) still owns whether they actually render: a
 *  fixed subscription connection hides them in both modes, one visibility
 *  rule instead of two that could drift apart. Writing rows come from the
 *  field-definition table so simple/advanced visibility cannot drift. */
const SETTINGS_SIMPLE_ROW_IDS: ReadonlySet<SettingsRowId> = new Set([
  "theme",
  "apparatus",
  "update-checks",
  ...WRITING_PROMPT_FIELD_DEFINITIONS
    .filter((entry) => entry.view === "simple")
    .map((entry) => entry.row),
  "provider",
  "model",
  "context-window",
  "base-url",
  "api-key"
]);

export function settingsSimpleModeRowVisible(row: SettingsRowId): boolean {
  return SETTINGS_SIMPLE_ROW_IDS.has(row);
}

/** Flip simple/advanced for the rest of the session, and persist the choice
 *  to the user config the same way `applySettingsLocalToggle`
 *  (settings-selector-actions.ts) persists compose focus and word wrap:
 *  `settingsViewMode` is a view preference, not a setting, so it lives in
 *  `UserConfig` rather than the server-backed settings draft
 *  (settings-local-rows.ts). It never touches `overlay.draft` — which rows
 *  show is unrelated to what the draft saves, so flipping it must not dirty
 *  the draft or arm/disarm a save conflict. */
export function toggleSettingsViewMode(
  state: RuntimeState,
  source: AppSource,
  overlay: SettingsOverlayState
): SettingsViewMode {
  const next: SettingsViewMode = overlay.viewMode === "simple" ? "advanced" : "simple";
  overlay.viewMode = next;
  persistViewMode(state, source, "settingsViewMode", next);
  return next;
}

/** Flip the Fact editor's own session preference. Settings and Facts use the
 * same `m` gesture, but keep independent preferences. */
export function toggleFactEditorViewMode(
  state: RuntimeState,
  source: AppSource,
  current: SettingsViewMode = state.config.factsViewMode ?? "simple"
): SettingsViewMode {
  const next: SettingsViewMode = current === "simple" ? "advanced" : "simple";
  persistViewMode(state, source, "factsViewMode", next);
  return next;
}

function persistViewMode(
  state: RuntimeState,
  source: AppSource,
  preference: "settingsViewMode" | "factsViewMode",
  next: SettingsViewMode
): void {
  state.config = { ...state.config, [preference]: next };
  source.config = state.config;
  if (!state.demo) saveConfig(state.config);
}

import type { ActionContext } from "./action-context.js";
import type { ActionRunner } from "./action-runtime.js";
import type { AppSource } from "./app.js";
import {
  saveConfig,
  THEME_NAMES,
  type ThemeName,
  type UserConfig
} from "./config.js";
import { cycleAllowInsecureHttp } from "./settings-allow-insecure.js";
import {
  cycleSettingsModel,
  cycleSettingsProvider,
  restoreSettingsCursor,
  settingsCursorRowIdentity,
  settingsModelDisplayText,
  settingsRowUsesServer
} from "./settings-overlay-model.js";
import {
  cycleCachePolicyControl,
  cycleContinuationPromptControl,
  cycleEffortControl,
  cycleKeepThoughtsControl,
  cycleProfileControl,
  cycleRouteControl,
  cycleSplitThinkTags,
  cycleTextPromptFormatControl,
  stepSettingsScalar,
  type ScalarMagnitude
} from "./settings-profile-controls.js";
import { cycleTokenProbabilitiesControl } from "./settings-token-probabilities-row.js";
import { cycleReasoningControl } from "./settings-reasoning-row.js";
import { isSettingsScalarRow } from "./settings-scalar.js";
import {
  isConnectionTimeoutRow,
  stepConnectionTimeout
} from "./settings-connection-timeouts.js";
import type {
  RuntimeState,
  SettingsOverlayState,
  SettingsRowId
} from "./state.js";

export async function cycleSettingsRow(
  row: SettingsRowId,
  step: -1 | 1,
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  overlay: SettingsOverlayState,
  magnitude: ScalarMagnitude = "step"
): Promise<void> {
  if (settingsRowUsesServer(row) && !overlay.view.editable) {
    state.toast = "legacy settings are read-only";
    return;
  }
  try {
    if (isSettingsScalarRow(row)) {
      stepSettingsScalar(overlay, row, step, magnitude);
    } else if (isConnectionTimeoutRow(row)) {
      stepConnectionTimeout(overlay, row, step, magnitude);
    } else if (row === "theme") {
      const index = THEME_NAMES.indexOf(state.config.theme);
      applySettingsTheme(
        state,
        context,
        THEME_NAMES[(index + step + THEME_NAMES.length) % THEME_NAMES.length]!
      );
    } else if (row === "compose-focus") {
      applySettingsLocalToggle(
        state,
        source,
        "compose-focus",
        state.config.composeFocus === "on" ? "off" : "on"
      );
    } else if (row === "word-wrap") {
      applySettingsLocalToggle(
        state,
        source,
        "word-wrap",
        state.config.wordWrap === "on" ? "off" : "on"
      );
    } else if (row === "update-checks") {
      applyUpdateChecksToggle(
        state,
        source,
        context.backend,
        state.config.updates.mode === "notify" ? "off" : "on"
      );
    } else if (row === "provider") {
      const choice = cycleSettingsProvider(overlay, step);
      state.toast = `provider · ${choice.label} · s saves settings`;
    } else if (row === "text-prompt-format") {
      const format = cycleTextPromptFormatControl(overlay, step);
      if (format !== null) {
        state.toast = `prompt format · ${format} · s saves settings`;
      }
    } else if (row === "split-think-tags") {
      const enabled = cycleSplitThinkTags(overlay);
      if (enabled !== null) {
        state.toast = `split thoughts · ${enabled ? "on" : "off"} · s saves settings`;
      }
    } else if (row === "allow-insecure-http") {
      const enabled = cycleAllowInsecureHttp(overlay);
      state.toast =
        `insecure HTTP (LAN) · ${enabled ? "on" : "off"} · s saves settings`;
    } else if (row === "model") {
      const model = cycleSettingsModel(overlay, step);
      if (model !== null) {
        state.toast =
          `model · ${settingsModelDisplayText(model)} · s saves settings`;
      }
    } else if (row === "profile") {
      const cursorRow = settingsCursorRowIdentity(overlay);
      const profile = cycleProfileControl(overlay, step);
      restoreSettingsCursor(overlay, cursorRow);
      if (profile !== null) state.toast = `profile · ${profile}`;
    } else if (row === "effort") {
      const effort = cycleEffortControl(overlay, step);
      if (effort !== null) state.toast = `effort · ${effort} · s saves settings`;
    } else if (row === "cache-policy") {
      const policy = cycleCachePolicyControl(overlay, step);
      if (policy !== null) state.toast = `cache · ${policy} · s saves settings`;
    } else if (row === "continuation-prompt") {
      const value = cycleContinuationPromptControl(overlay, step);
      if (value !== null) state.toast = `experimental prompt · ${value} · s saves settings`;
    } else if (row === "token-probabilities") {
      const value = cycleTokenProbabilitiesControl(overlay, step);
      if (value !== null) state.toast = `alt count · ${value} · s saves settings`;
    } else if (row === "reasoning") {
      const value = cycleReasoningControl(overlay, step);
      if (value !== null) state.toast = `reasoning · ${value} · s saves settings`;
    } else if (row === "keep-thoughts") {
      const value = cycleKeepThoughtsControl(overlay, step);
      if (value !== null) state.toast = `keep thoughts · ${value} · s saves settings`;
    } else if (row === "default-route") {
      const value = cycleRouteControl(overlay, "default", step);
      if (value !== null) state.toast = `default route · ${value} · s saves settings`;
    } else if (row === "prose-route") {
      const value = cycleRouteControl(overlay, "prose", step);
      if (value !== null) state.toast = `prose route · ${value} · s saves settings`;
    } else if (row === "utility-route") {
      const value = cycleRouteControl(overlay, "utility", step);
      if (value !== null) state.toast = `utility route · ${value} · s saves settings`;
    }
  } catch (error) {
    state.toast = `settings kept · ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function applySettingsTheme(
  state: RuntimeState,
  context: ActionContext,
  theme: ThemeName
): void {
  context.applyTheme(theme);
  state.toast = `theme · ${theme}`;
}

/** Local on/off rows are stored in the user config and save through the same
 *  path. */
export function applySettingsLocalToggle(
  state: RuntimeState,
  source: AppSource,
  row: "compose-focus" | "word-wrap",
  value: "on" | "off"
): void {
  state.config = row === "compose-focus"
    ? { ...state.config, composeFocus: value }
    : { ...state.config, wordWrap: value };
  source.config = state.config;
  if (!state.demo) saveConfig(state.config);
  const label = row === "compose-focus"
    ? "compose focus"
    : "word wrap";
  state.toast = `${label} · ${value}`;
}

/** Persist and immediately apply the update-check preference. */
export function applyUpdateChecksToggle(
  state: RuntimeState,
  source: AppSource,
  runtime: Pick<ActionRunner, "restartUpdateCheck">,
  value: "on" | "off",
  persist: (config: UserConfig) => boolean = saveConfig
): void {
  state.config = {
    ...state.config,
    updates: {
      ...state.config.updates,
      mode: value === "on" ? "notify" : "off"
    }
  };
  source.config = state.config;
  const saved = state.demo || persist(state.config);
  runtime.restartUpdateCheck();
  state.toast = saved
    ? `update checks · ${value}`
    : `update checks · ${value} for this session · config not saved`;
}

import type { ActionContext } from "./action-context.js";
import type { AppSource } from "./app.js";
import { saveConfig, THEME_NAMES, type ThemeName } from "./config.js";
import {
  cycleAllowInsecureHttp,
  cycleSettingsModel,
  cycleSettingsProvider,
  settingsModelDisplayText,
  settingsRowUsesServer
} from "./settings-overlay-model.js";
import {
  cycleCachePolicyControl,
  cycleEffortControl,
  cycleProfileControl,
  cycleRouteControl,
  cycleTextPromptFormatControl,
  stepSettingsScalar,
  type ScalarMagnitude
} from "./settings-profile-controls.js";
import { cycleTokenProbabilitiesControl } from "./settings-token-probabilities-row.js";
import { isSettingsScalarRow } from "./settings-scalar.js";
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
    } else if (row === "theme") {
      const index = THEME_NAMES.indexOf(state.config.theme);
      applySettingsTheme(
        state,
        context,
        THEME_NAMES[(index + step + THEME_NAMES.length) % THEME_NAMES.length]!
      );
    } else if (row === "compose-focus") {
      applySettingsComposeFocus(
        state,
        source,
        state.config.composeFocus === "on" ? "off" : "on"
      );
    } else if (row === "word-wrap") {
      applySettingsWordWrap(
        state,
        source,
        state.config.wordWrap === "on" ? "off" : "on"
      );
    } else if (row === "provider") {
      const choice = cycleSettingsProvider(overlay, step);
      state.toast = `provider · ${choice.label} · s saves settings`;
    } else if (row === "text-prompt-format") {
      const format = cycleTextPromptFormatControl(overlay, step);
      if (format !== null) {
        state.toast = `prompt format · ${format} · s saves settings`;
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
      const profile = cycleProfileControl(overlay, step);
      if (profile !== null) state.toast = `profile · ${profile}`;
    } else if (row === "effort") {
      const effort = cycleEffortControl(overlay, step);
      if (effort !== null) state.toast = `effort · ${effort} · s saves settings`;
    } else if (row === "cache-policy") {
      const policy = cycleCachePolicyControl(overlay, step);
      if (policy !== null) state.toast = `cache · ${policy} · s saves settings`;
    } else if (row === "token-probabilities") {
      const value = cycleTokenProbabilitiesControl(overlay, step);
      if (value !== null) state.toast = `alt count · ${value} · s saves settings`;
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

export function applySettingsComposeFocus(
  state: RuntimeState,
  source: AppSource,
  composeFocus: "on" | "off"
): void {
  state.config = { ...state.config, composeFocus };
  source.config = state.config;
  if (!state.demo) saveConfig(state.config);
  state.toast = `compose focus · ${composeFocus}`;
}

export function applySettingsWordWrap(
  state: RuntimeState,
  source: AppSource,
  wordWrap: "on" | "off"
): void {
  state.config = { ...state.config, wordWrap };
  source.config = state.config;
  if (!state.demo) saveConfig(state.config);
  state.toast = `word wrap · ${wordWrap}`;
}

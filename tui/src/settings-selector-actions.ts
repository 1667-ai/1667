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
  overlay: SettingsOverlayState
): Promise<void> {
  if (settingsRowUsesServer(row) && !overlay.view.editable) {
    state.toast = "legacy settings are read-only";
    return;
  }
  if (row === "theme") {
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
  } else if (row === "provider") {
    const choice = cycleSettingsProvider(overlay, step);
    state.toast = `provider · ${choice.label} · s saves settings`;
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

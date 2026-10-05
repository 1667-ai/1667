import type { LoadedSettings, SettingsState } from "./state.js";

/** What the shell asks about the settings draft: is it changed, and what
 * does Copy hold. The answers come from the settings code, which downloads
 * when the page opens. A draft can only exist after that code has loaded, so
 * until then nothing is changed. */
export interface SettingsUnsaved {
  isDirty(loaded: LoadedSettings): boolean;
  changedPromptText(loaded: LoadedSettings): string;
}

let source: SettingsUnsaved | null = null;

export function registerSettingsUnsaved(unsaved: SettingsUnsaved): void {
  source = unsaved;
}

export function settingsDirty(settings: SettingsState): boolean {
  return settings.kind === "loaded" && source !== null && source.isDirty(settings);
}

export function settingsChangedPromptText(settings: LoadedSettings): string {
  return source === null ? "" : source.changedPromptText(settings);
}

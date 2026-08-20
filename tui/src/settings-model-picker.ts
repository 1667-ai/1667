import type { DiscoveredModelV2 } from "../../shared/settings-v2-types.js";
import { settingsModelChoices } from "./settings-model-discovery.js";
import { settingsModelDisplayText } from "./settings-profile-controls.js";
import { settingsSubscriptionPreset } from "./settings-subscription.js";
import type { SettingsOverlayState } from "./state.js";

/** C-09 caps a cycler at eight options. Past that the writer is stepping
 *  through a list one keypress at a time, which is the case C-15's option
 *  column exists for. */
export const MODEL_CYCLER_CAP = 8;

export interface SettingsModelPicker {
  query: string;
  cursor: number;
}

export function modelPickerRequired(overlay: SettingsOverlayState): boolean {
  const choices = settingsModelChoices(overlay);
  // Subscription catalogs use the same explicit picker interaction even when
  // a catalog currently fits in the short cycler. This keeps ChatGPT and
  // Claude plan model selection consistent as catalogs change.
  return choices.length > MODEL_CYCLER_CAP
    || settingsSubscriptionPreset(overlay) !== null && choices.length > 0;
}

/** The options this picker is showing, narrowed by whatever has been typed.
 *  C-15 owns `↑↓`, so the column is the only focus ring while it is open. */
export function modelPickerRows(
  overlay: SettingsOverlayState,
  query: string
): readonly DiscoveredModelV2[] {
  const needle = query.trim().toLowerCase();
  const choices = settingsModelChoices(overlay);
  if (needle.length === 0) return choices;
  return choices.filter((choice) =>
    settingsModelDisplayText(choice.name).toLowerCase().includes(needle)
    || choice.remoteId.toLowerCase().includes(needle));
}

export function boundedModelPickerCursor(value: number, count: number): number {
  return Math.max(0, Math.min(Math.max(0, count - 1), value));
}

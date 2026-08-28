import type { AppSource } from "./app.js";
import type { ActionContext } from "./action-context.js";
import { resolveSamplingBias } from "./sampling-bias-resolution.js";
import {
  SETTINGS_COMMAND_CATALOG,
  type SettingsCommandTarget
} from "./settings-command-catalog.js";
import {
  samplingLayerRowIndex,
  type SamplingLayerRowSpec
} from "./sampling-model.js";
import {
  settingsRowIndex
} from "./settings-row-navigation.js";
import { settingsSubscriptionRowVisible } from "./settings-subscription.js";
import { settingsSimpleModeRowVisible } from "./settings-view-mode.js";
import type { RuntimeState, SettingsOverlayState } from "./state.js";

/** Focus a command-palette destination without changing the saved Settings
 * view. A provider-specific row that is not applicable falls back to Provider
 * and reports why the requested destination cannot open. */
export function focusSettingsTarget(
  target: SettingsCommandTarget,
  state: RuntimeState,
  overlay: SettingsOverlayState,
  source: AppSource,
  context: ActionContext
): void {
  const row = target.kind === "row" ? target.row : "sampling";
  if (!settingsSubscriptionRowVisible(overlay, row)) {
    const provider = settingsRowIndex("provider", overlay);
    if (provider >= 0) overlay.cursor = provider;
    if (target.kind === "row") {
      state.toast = `${SETTINGS_COMMAND_CATALOG[target.row].name} is unavailable for the selected provider`;
    }
    return;
  }
  let index = settingsRowIndex(row, overlay);
  if (index < 0 && overlay.viewMode === "simple" && !settingsSimpleModeRowVisible(row)) {
    overlay.viewMode = "advanced";
    index = settingsRowIndex(row, overlay);
  }
  if (index < 0) {
    const provider = settingsRowIndex("provider", overlay);
    if (provider >= 0) overlay.cursor = provider;
    if (target.kind === "row") {
      state.toast = `${SETTINGS_COMMAND_CATALOG[target.row].name} is unavailable for the selected provider`;
    }
    return;
  }
  overlay.cursor = index;
  if (target.kind === "sampling") {
    initializeSamplingOverlay(overlay, source, context, target.row);
  }
}

/** Start the nested Sampling surface in one place. Ordinary Enter and
 * semantic palette destinations share the same state and resolution cycle. */
export function initializeSamplingOverlay(
  overlay: SettingsOverlayState,
  source: AppSource,
  context: ActionContext,
  target?: SamplingLayerRowSpec
): void {
  overlay.sampling = {
    panel: "sampling",
    cursor: 0,
    logitBiasOrder: Object.keys(overlay.draft.sampling.logitBias),
    edit: null,
    result: null,
    deleteArmedRowId: null,
    biasResolution: { kind: "idle" },
    resolutionGeneration: 0
  };
  if (target !== undefined) {
    const targetValue = target.kind === "scalar" ? target.knob : target.panel;
    const index = samplingLayerRowIndex(targetValue);
    if (index >= 0) overlay.sampling.cursor = index;
  }
  resolveSamplingBias(overlay, source, context);
}

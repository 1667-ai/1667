import {
  applySettingsModelChoiceDraft,
  clearSettingsModelChoiceDraft,
  type SettingsModelChoiceOrigin
} from "./settings-draft-transition.js";
import { settingsDraftChanged } from "./settings-overlay-reconciliation.js";
import type { DiscoveredModelV2 } from "../../shared/settings-v2-types.js";
import type { SettingsOverlayState } from "./state.js";

export function applySettingsModelChoice(
  overlay: SettingsOverlayState,
  model: Pick<DiscoveredModelV2, "remoteId" | "contextWindow">,
  contextWindow: number | null = model.contextWindow,
  origin: SettingsModelChoiceOrigin = { kind: "manual" }
): void {
  applySettingsModelChoiceDraft(overlay, model, contextWindow, origin);
  overlay.result = null;
  if (!settingsDraftChanged(overlay)) overlay.conflict = null;
  else if (overlay.conflict !== null) overlay.conflict.armed = false;
}

export function applyCachedSettingsModelChoice(
  overlay: SettingsOverlayState,
  choices: readonly DiscoveredModelV2[],
  targetIdentity: string
): string | null {
  if (overlay.draft.generation.model.trim().length > 0 || choices.length !== 1) {
    return null;
  }
  try {
    applySettingsModelChoice(
      overlay,
      choices[0]!,
      choices[0]!.contextWindow,
      { kind: "automatic", targetIdentity }
    );
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function clearAutomaticSettingsModel(
  overlay: SettingsOverlayState
): void {
  clearSettingsModelChoiceDraft(overlay);
  overlay.result = null;
}

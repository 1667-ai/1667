import type { AppSource } from "./app.js";
import type { ActionContext } from "./action-context.js";
import {
  sameGenerationSettings,
  sameSettingsDraft,
  settingsRowUsesServer
} from "./settings-overlay-model.js";
import { settingsProviderProbeTarget } from "./settings-provider-probe.js";
import { sameConnectionSecrets } from "./settings-secret-sidecar.js";
import { activeSettingsEdit } from "./settings-edit-state.js";
import type { RuntimeState, SettingsOverlayState } from "./state.js";

/** Probe the selected draft without letting a late response overwrite newer
 * inline edits or a context limit entered while the request was in flight. */
export async function detectSettingsContext(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  overlay: SettingsOverlayState
): Promise<void> {
  await context.backend.run("detecting context window", async (task) => {
    if (state.settings !== overlay) return;
    overlay.probing = true;
    overlay.result = null;
    context.repaint();
    const editable = overlay.view.editable;
    const probed = editable ? overlay.draft.generation : overlay.view.effective;
    // The probe now authenticates with the sidecar key, so the key is part of
    // what was probed. Without it a limit discovered under one key could land
    // in a draft the writer has since re-keyed.
    const probedSecrets = overlay.connectionSecrets;
    try {
      // No model-first gate here. Whether one is needed is the probe's own
      // knowledge — KoboldCpp and llama.cpp answer from the loaded model
      // without being told its name — and a provider that does need one
      // returns nothing, which lands on the manual-entry warning below.
      const { contextWindow } = await source.api.probeContextWindow(
        settingsProviderProbeTarget(
          overlay.view,
          probed,
          overlay.connectionSecrets
        )
      );
      const currentlyEditable = overlay.view.editable;
      const current = currentlyEditable
        ? overlay.draft.generation
        : overlay.view.effective;
      const edit = activeSettingsEdit(state, overlay);
      if (!task.owns() || state.settings !== overlay
        || edit !== null
        || currentlyEditable !== editable
        || !sameProbeIdentity(probed, current)
        || !sameConnectionSecrets(probedSecrets, overlay.connectionSecrets)
        || current.contextWindow !== probed.contextWindow) {
        return;
      }
      if (contextWindow === null) {
        overlay.result = {
          state: "warning",
          message: "context window unavailable · enter it here"
        };
        return;
      }
      if (editable) {
        overlay.draft = {
          ...overlay.draft,
          generation: { ...overlay.draft.generation, contextWindow }
        };
        if (sameSettingsDraft(overlay.draft, overlay.base)) overlay.conflict = null;
        else if (overlay.conflict !== null) overlay.conflict.armed = false;
      }
      const suffix = editable
        ? " · s saves"
        : " · legacy settings stay read-only";
      overlay.result = {
        state: "ready",
        message: `context window · ${contextWindow.toLocaleString("en-US")} tokens${suffix}`
      };
    } finally {
      if (task.owns() && state.settings === overlay) {
        overlay.probing = false;
      }
    }
  });
}

export async function checkSettings(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  overlay: SettingsOverlayState
): Promise<void> {
  await context.backend.run("checking model server", async (task) => {
    if (state.settings !== overlay) return;
    overlay.checking = true;
    overlay.result = null;
    context.repaint();
    try {
      const checked = overlay.view.editable
        ? overlay.draft.generation
        : overlay.view.effective;
      const checkedSecrets = overlay.connectionSecrets;
      const result = await source.api.checkModelServer(
        settingsProviderProbeTarget(
          overlay.view,
          checked,
          overlay.connectionSecrets
        )
      );
      const current = overlay.view.editable
        ? overlay.draft.generation
        : overlay.view.effective;
      const edit = activeSettingsEdit(state, overlay);
      if (task.owns() && state.settings === overlay
        && (edit === null
          || !settingsRowUsesServer(edit.row))
        && sameConnectionSecrets(checkedSecrets, overlay.connectionSecrets)
        && sameGenerationSettings(checked, current)) {
        overlay.result = result;
      }
    } finally {
      if (task.owns() && state.settings === overlay) {
        overlay.checking = false;
      }
    }
  });
}

function sameProbeIdentity(
  left: SettingsOverlayState["draft"]["generation"],
  right: SettingsOverlayState["draft"]["generation"]
): boolean {
  return left.provider === right.provider
    && left.baseUrl === right.baseUrl
    && left.model === right.model
    && left.apiKeyEnv === right.apiKeyEnv
    && left.allowInsecureHttp === right.allowInsecureHttp;
}

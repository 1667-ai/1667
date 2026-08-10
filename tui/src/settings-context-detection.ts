import type { AppSource } from "./app.js";
import type { ActionContext } from "./action-context.js";
import {
  sameGenerationSettings,
  sameSettingsDraft,
  settingsRowUsesServer
} from "./settings-overlay-model.js";
import { settingsTextDraftWithDetectedContext } from "./settings-text.js";
import { settingsProviderProbeTarget } from "./settings-provider-probe.js";
import { sameConnectionSecrets } from "./settings-secret-sidecar.js";
import { activeSettingsEdit } from "./settings-edit-state.js";
import { replaceSettingsDraft } from "./settings-draft-transition.js";
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
    const probedProfileId = overlay.draft.selectedProfileId;
    const probedDocument = overlay.draft.document;
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
          overlay.connectionSecrets,
          probedDocument,
          probedProfileId
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
        || overlay.draft.selectedProfileId !== probedProfileId
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
        overlay.resultRow = "context-window";
        return;
      }
      if (editable) {
        replaceSettingsDraft(
          overlay,
          settingsTextDraftWithDetectedContext(overlay.draft, contextWindow)
        );
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
      overlay.resultRow = "context-window";
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
      const checkedProfileId = overlay.draft.selectedProfileId;
      const checkedDocument = overlay.draft.document;
      const checkedSecrets = overlay.connectionSecrets;
      const result = await source.api.checkModelServer(
        settingsProviderProbeTarget(
          overlay.view,
          checked,
          overlay.connectionSecrets,
          checkedDocument,
          checkedProfileId
        )
      );
      const current = overlay.view.editable
        ? overlay.draft.generation
        : overlay.view.effective;
      const edit = activeSettingsEdit(state, overlay);
      if (task.owns() && state.settings === overlay
        && (edit === null
          || edit.kind === "row" && !settingsRowUsesServer(edit.row))
        && overlay.draft.selectedProfileId === checkedProfileId
        && sameConnectionSecrets(checkedSecrets, overlay.connectionSecrets)
        && sameGenerationSettings(checked, current)) {
        overlay.result = result;
        overlay.resultRow = "base-url";
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

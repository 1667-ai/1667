import type { AppSource } from "./app.js";
import type { ActionContext } from "./action-context.js";
import { sameSettingsDraft } from "./settings-overlay-model.js";
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
    const editable = overlay.view.editable && overlay.view.pendingRevision === null;
    const probed = editable ? overlay.draft.generation : overlay.view.effective;
    try {
      if (probed.provider !== "dry-run" && probed.model.trim().length === 0) {
        overlay.result = {
          state: "warning",
          message: "enter a model ID before detecting context"
        };
        return;
      }
      const { contextWindow } = await source.api.probeContextWindow(probed);
      const currentlyEditable =
        overlay.view.editable && overlay.view.pendingRevision === null;
      const current = currentlyEditable
        ? overlay.draft.generation
        : overlay.view.effective;
      if (!task.owns() || state.settings !== overlay
        || overlay.edit !== null
        || currentlyEditable !== editable
        || !sameProbeIdentity(probed, current)
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
        : overlay.view.editable
          ? " · pending settings stay unchanged"
          : " · legacy settings stay read-only";
      overlay.result = {
        state: "ready",
        message: `context window · ${contextWindow.toLocaleString("en-US")} tokens${suffix}`
      };
    } finally {
      if (task.owns() && state.settings === overlay) overlay.probing = false;
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
    && left.apiKeyEnv === right.apiKeyEnv;
}

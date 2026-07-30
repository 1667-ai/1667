import { createDurableMutationId } from "../../shared/durable-mutation-id.js";
import {
  applyBasicModelDiscovery,
  applyBasicSettingsDraft
} from "../../shared/settings-basic-draft.js";
import {
  applyPromptCachePolicy,
  promptCacheContextForDocument,
  promptCachePolicyPresentation
} from "../../shared/prompt-cache-capabilities.js";
import { settingsMutationFailureAction } from "../../shared/settings-mutation-failure.js";
import type {
  SettingsDocumentV2,
  SettingsMutationResult
} from "../../shared/settings-v2-types.js";
import type { AppSource } from "./app.js";
import { apiErrorCode } from "./api.js";
import { insertComposerText } from "./composer-model.js";
import { applyComposerEdit } from "./composer-editing.js";
import { readFromClipboard } from "./clipboard.js";
import { sanitizePastedText, type ResolvedKey } from "./keys.js";
import { inlineEditorAction } from "./editor-action.js";
import { publishSettingsView } from "./overlay-publication.js";
import {
  checkSettings,
  detectSettingsContext
} from "./settings-context-detection.js";
import {
  settingsModelDiscoveryIdentity
} from "./settings-model-discovery.js";
import {
  openSettingsPasteTarget,
  openSystemPromptEditor
} from "./settings-prompt-editor.js";
import { activeSettingsEdit } from "./settings-edit-state.js";
import {
  applySettingsRowEdit,
  applyStoredApiKeyIntent,
  beginSettingsRowEdit,
  boundedSettingsCursor,
  disarmSettingsConflict,
  initialSettingsOverlay,
  sameSettingsDraft,
  SETTINGS_ROW_IDS,
  settingsActivationFailureText,
  settingsDraftChanged,
  settingsRowHasArrows,
  settingsRowCycles,
  settingsRowUsesServer,
  settleSettingsOverlaySave
} from "./settings-overlay-model.js";
import {
  applySettingsComposeFocus,
  applySettingsTheme,
  cycleSettingsRow
} from "./settings-selector-actions.js";

import type {
  RuntimeState,
  SettingsOverlayState,
  SettingsRowId
} from "./state.js";
import type { ActionContext } from "./action-context.js";

export async function openSettingsOverlay(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  row?: SettingsRowId
): Promise<void> {
  state.settings = initialSettingsOverlay(source.settingsView, state.config);
  const overlay = state.settings;
  if (row !== undefined) {
    overlay.cursor = SETTINGS_ROW_IDS.indexOf(row);
  }
  state.mode = "SETTINGS";
  context.repaint();
  if (state.connection.down) return;
  await context.backend.run("refreshing settings", async (task) => {
    try {
      const settings = await source.api.getSettings();
      if (!task.owns()) return;
      publishSettingsView(state, source, settings);
    } catch { /* connection decorator owns the banner */ }
  });
}

export async function settingsOverlayAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<boolean> {
  const overlay = state.settings!;
  if (resolved.action === "cancel") {
    if (overlay.edit !== null) {
      overlay.edit = null;
      state.toast = settingsDraftChanged(overlay) ? "row edit cancelled · draft kept" : null;
    } else {
      state.settings = null;
      state.mode = "NAV";
    }
  } else if (resolved.action === "paste-clipboard") {
    const row = SETTINGS_ROW_IDS[boundedSettingsCursor(overlay.cursor)]!;
    const target = openSettingsPasteTarget(state);
    if (target === "editor") {
      const editor = state.editor;
      if (editor !== null) {
        await inlineEditorAction(resolved, state, source, context);
      }
    } else if (target === "inline") {
      await settingsInlineEditAction(resolved, state, source, context, overlay);
    } else {
      if (settingsRowCycles(row)) {
        state.toast = "this row is a selector · use ←→";
      } else if (!overlay.view.editable) {
        state.toast = "legacy settings are read-only";
      }
    }
  } else if (overlay.edit !== null) {
    await settingsInlineEditAction(resolved, state, source, context, overlay);
  } else if (resolved.action === "focus-next") {
    overlay.cursor = boundedSettingsCursor(overlay.cursor + 1);
  } else if (resolved.action === "focus-previous") {
    overlay.cursor = boundedSettingsCursor(overlay.cursor - 1);
  } else if (resolved.action === "focus-index") {
    overlay.cursor = boundedSettingsCursor(resolved.index ?? overlay.cursor);
  } else if (resolved.action === "open-selected" || resolved.action === "edit") {
    const row = SETTINGS_ROW_IDS[boundedSettingsCursor(overlay.cursor)]!;
    if (settingsRowUsesServer(row) && !overlay.view.editable) {
      state.toast = "legacy settings are read-only";
    } else if (row === "model") {
      beginSettingsRowEdit(overlay, state.config);
    } else if (settingsRowCycles(row)) {
      await cycleSettingsRow(row, 1, state, source, context, overlay);
    } else if (row === "system-prompt") {
      openSystemPromptEditor(state);
    } else {
      beginSettingsRowEdit(overlay, state.config);
    }
  } else if (resolved.action === "save-edit") {
    await saveSettingsDraft(state, source, context, overlay);
  } else if (resolved.action === "take-next" || resolved.action === "take-previous") {
    if (resolved.index !== undefined) {
      overlay.cursor = boundedSettingsCursor(resolved.index);
    }
    const step = resolved.action === "take-next" ? 1 : -1;
    const row = SETTINGS_ROW_IDS[boundedSettingsCursor(overlay.cursor)]!;
    if (settingsRowHasArrows(overlay, row)) {
      await cycleSettingsRow(row, step, state, source, context, overlay);
    }
  } else if (resolved.action === "discard-pending") {
    await discardPendingSettings(state, source, context, overlay);
  } else if (resolved.action === "check") {
    await checkSettings(state, source, context, overlay);
  } else if (resolved.action === "detect-context") {
    await detectSettingsContext(state, source, context, overlay);
  }
  return true;
}

async function settingsInlineEditAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  overlay: SettingsOverlayState
): Promise<void> {
  const edit = overlay.edit;
  if (edit?.kind !== "inline") return;
  if (resolved.action === "paste-clipboard") {
    const inputClaim = {
      interactionVersion: state.interactionVersion,
      text: edit.composer.text,
      cursor: edit.composer.cursor,
      anchor: edit.composer.anchor
    };
    const text = await readFromClipboard();
    if (state.settings !== overlay || overlay.edit !== edit) return;
    if (state.interactionVersion !== inputClaim.interactionVersion
      || edit.composer.text !== inputClaim.text
      || edit.composer.cursor !== inputClaim.cursor
      || edit.composer.anchor !== inputClaim.anchor) {
      return;
    }
    if (text === null) {
      state.toast = "clipboard unreadable · paste with ⌘V or ctrl+shift+v";
    } else if (!pasteSettingsInlineEdit(overlay, text)) {
      state.toast = "clipboard has no insertable text";
    }
    return;
  }
  if (resolved.action === "commit-field") {
    const applied = applySettingsRowEdit(overlay, state.config);
    if (applied.kind === "error") {
      state.toast = `row kept · ${applied.message}`;
      return;
    }
    if (applied.kind === "theme") {
      applySettingsTheme(state, context, applied.value);
      return;
    }
    if (applied.kind === "compose-focus") {
      applySettingsComposeFocus(state, source, applied.value);
      return;
    }
    disarmSettingsConflict(overlay);
    if (settingsDraftChanged(overlay)) {
      state.toast = "draft updated · s saves settings";
    }
    return;
  }
  if (resolved.action === "input") {
    disarmSettingsConflict(overlay);
    insertComposerText(edit.composer, resolved.text ?? "");
    return;
  }
  const kind = applyComposerEdit(
    edit.composer,
    resolved.action,
    resolved.extendSelection
  );
  if (kind !== null) {
    if (kind === "delete") disarmSettingsConflict(overlay);
    return;
  }
}

function pasteSettingsInlineEdit(
  overlay: SettingsOverlayState,
  raw: string
): boolean {
  const edit = overlay.edit;
  if (edit?.kind !== "inline") return false;
  const clean = sanitizePastedText(raw);
  if (clean.length === 0) return false;
  disarmSettingsConflict(overlay);
  insertComposerText(edit.composer, clean.replace(/\n+/g, " "));
  return true;
}

async function saveSettingsDraft(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  overlay: SettingsOverlayState
): Promise<void> {
  if (!overlay.view.editable) return void (state.toast = "legacy settings are read-only");
  if (state.connection.down) {
    return void (state.toast = "offline · draft kept until the connection returns");
  }
  // A staged view means the last activation attempt did not commit; saving
  // the unmodified candidate is the retry, so the no-op guards step aside.
  const stagedRetry = overlay.view.pendingRevision !== null;
  if (overlay.saveIntent === undefined && !settingsDraftChanged(overlay) && !stagedRetry) {
    overlay.conflict = null;
    return;
  }
  if (overlay.conflict !== null && !overlay.conflict.armed) {
    overlay.conflict.armed = true;
    state.toast = `${overlay.conflict.message} · s again overwrites`;
    return;
  }

  let intent = overlay.saveIntent;
  if (intent === undefined) {
    const draft = overlay.draft;
    const connectionSecrets = { ...overlay.connectionSecrets };
    let document: SettingsDocumentV2;
    try {
      const basicDocument = applyBasicSettingsDraft(
        overlay.view.document,
        draft.generation
      );
      const discovery = overlay.modelDiscoveryIdentity
          === settingsModelDiscoveryIdentity(draft.generation)
        ? overlay.modelDiscovery
        : null;
      document = applyStoredApiKeyIntent(
        applyPromptCachePolicy(
          applyBasicModelDiscovery(
            basicDocument,
            discovery,
            draft.generation.contextWindow
          ),
          draft.cachePolicy
        ),
        connectionSecrets
      );
      const cacheContext = promptCacheContextForDocument(document);
      const presentation = promptCachePolicyPresentation(cacheContext, draft.cachePolicy);
      if (!presentation.available) {
        throw new Error(
          presentation.unavailableReason
        );
      }
    } catch (error) {
      state.toast = `settings kept · ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    if (
      !stagedRetry
      && document === overlay.view.document
      && Object.keys(connectionSecrets).length === 0
    ) {
      overlay.draft = overlay.base;
      overlay.conflict = null;
      return;
    }
    intent = {
      draft,
      connectionSecrets,
      command: {
        mutationId: createDurableMutationId(),
        expectedStateGeneration: overlay.view.stateGeneration,
        document,
        ...(Object.keys(connectionSecrets).length === 0
          ? {}
          : { connectionSecrets })
      }
    };
  }

  await context.backend.run("saving settings", async (task) => {
    overlay.saveIntent = intent;
    let result;
    try {
      result = await source.api.saveSettings({
        ...intent.command,
        transportOperationId: crypto.randomUUID()
      });
    } catch (error) {
      const action = settingsMutationFailureAction(apiErrorCode(error));
      if (action === "retain") throw error;
      delete overlay.saveIntent;
      if (action === "retire") throw error;
      const refreshed = await source.api.getSettings();
      if (!task.owns()) return;
      publishSettingsView(state, source, refreshed);
      state.toast = "settings changed elsewhere · latest settings loaded, draft kept";
      return;
    }
    const saved = await source.api.getSettings();
    if (!task.owns()) return;
    publishSettingsView(state, source, saved);
    if (state.settings !== overlay) return;
    delete overlay.saveIntent;
    const newerEdits = settleSettingsOverlaySave(
      overlay,
      intent.draft,
      activeSettingsEdit(state, overlay),
      intent.connectionSecrets
    );
    const message = settingsSaveMessage(result);
    state.toast = newerEdits ? `${message} · newer edits kept` : message;
  });
}

/** A credential-touching save activates inside the save request, so the
 * mutation result itself reports this save's activation outcome. */
function settingsSaveMessage(result: SettingsMutationResult): string {
  const outcome = result.activationOutcome;
  if (outcome === null) {
    return result.pendingSettingsRevision === null
      ? "settings saved"
      : "settings saved · activation pending";
  }
  if (outcome.result === "committed") return "settings saved · credentials active";
  return `saved, not active · ${settingsActivationFailureText(outcome.errorCode)}`;
}

async function discardPendingSettings(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  overlay: SettingsOverlayState
): Promise<void> {
  if (!overlay.view.editable || overlay.view.pendingRevision === null) {
    state.toast = "no pending settings to discard";
    return;
  }
  const intent = overlay.discardIntent ?? {
    mutationId: createDurableMutationId(),
    expectedStateGeneration: overlay.view.stateGeneration
  };
  overlay.discardIntent = intent;
  await context.backend.run("discarding pending settings", async (task) => {
    try {
      await source.api.discardPendingSettings({
        ...intent,
        transportOperationId: crypto.randomUUID()
      });
    } catch (error) {
      const action = settingsMutationFailureAction(apiErrorCode(error));
      if (action === "retain") throw error;
      delete overlay.discardIntent;
      if (action === "retire") throw error;
      const view = await source.api.getSettings();
      if (!task.owns()) return;
      publishSettingsView(state, source, view);
      state.toast = "settings changed elsewhere · refreshed latest settings";
      return;
    }
    const view = await source.api.getSettings();
    if (!task.owns()) return;
    delete overlay.discardIntent;
    publishSettingsView(state, source, view);
    state.toast = "pending settings discarded";
  });
}

import { createDurableMutationId } from "../../shared/durable-mutation-id.js";
import {
  applyBasicModelDiscovery,
  applyBasicSettingsDraft
} from "../../shared/settings-basic-draft.js";
import {
  promptCacheContextForProfile,
  promptCachePolicyPresentation
} from "../../shared/prompt-cache-capabilities.js";
import {
  applySamplingSettings,
  resolveConfiguredSamplingKnobs,
  samplingContextForRoute,
  samplingKnobLabel,
  type SamplingUnavailableReason
} from "../../shared/sampling-capabilities.js";
import { settingsMutationFailureAction } from "../../shared/settings-mutation-failure.js";
import { resolveSettingsProfile, selectSettingsRoute } from "../../shared/settings-route.js";
import { EMPTY_SAMPLING_V2 } from "../../shared/settings-v2-types.js";
import type {
  SettingsDocumentV2,
  SettingsMutationResult,
  SettingsRoutePurpose
} from "../../shared/settings-v2-types.js";
import type { AppSource } from "./app.js";
import { apiErrorCode } from "./api.js";
import { insertComposerText } from "./composer-model.js";
import { applyComposerEdit } from "./composer-editing.js";
import { samplingOverlayAction } from "./sampling-actions.js";
import { readFromClipboard } from "./clipboard.js";
import { applyTextKey, sanitizePastedText, type ResolvedKey } from "./keys.js";
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
  settingsRowIndex,
  settingsRows,
  settingsRowUsesServer,
  settleSettingsOverlaySave
} from "./settings-overlay-model.js";
import {
  createSettingsProfile,
  deleteSettingsProfile,
  duplicateSettingsProfile,
  isolateSettingsProfileModel
} from "./settings-profile-draft.js";
import { discardUnreferencedConnectionSecretWrites } from "./settings-secret-sidecar.js";
import { settingsTextDraftForDocument, settingsTextDraftWithGeneration } from "./settings-text.js";
import { modelPickerRequired } from "./settings-model-picker.js";
import {
  pasteIntoModelPicker,
  settingsInlineEditAction,
  settingsModelPickerAction
} from "./settings-field-actions.js";
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
  row?: SettingsRowId,
  profilePurpose?: SettingsRoutePurpose
): Promise<void> {
  const selectedProfileId = profilePurpose !== undefined && source.settingsView.editable
    ? selectSettingsRoute(source.settingsView.document, profilePurpose).profileId
    : undefined;
  state.settings = initialSettingsOverlay(
    source.settingsView,
    state.config,
    selectedProfileId
  );
  const overlay = state.settings;
  if (row !== undefined) {
    const at = settingsRowIndex(row);
    if (at >= 0) overlay.cursor = at;
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
  // C-18: an action's in-place report keeps reporting "until the next
  // keypress". The wrapped block below the fields is a C-32 result line and
  // outlives it; only the row attribution is bounded here.
  if (resolved.action !== "check" && resolved.action !== "detect-context") {
    overlay.resultRow = null;
  }
  // A profile delete requires two consecutive delete commands. Any intervening
  // action starts a different interaction, so it must not retain consent.
  // Cancel handles its own armed state below so Esc remains a harmless abort.
  if (overlay.deleteArmedProfileId !== null
    && resolved.action !== "delete-item"
    && resolved.action !== "cancel") {
    overlay.deleteArmedProfileId = null;
  }
  if (overlay.sampling !== null) {
    await samplingOverlayAction(resolved, state, source, context);
    return true;
  }
  if (resolved.action === "cancel") {
    // Esc peels exactly one layer: the option column is a layer of its own.
    if (overlay.modelPicker !== null) {
      overlay.modelPicker = null;
    } else if (overlay.edit !== null) {
      overlay.edit = null;
      state.toast = settingsDraftChanged(overlay) ? "row edit cancelled · draft kept" : null;
    } else if (overlay.deleteArmedProfileId !== null) {
      overlay.deleteArmedProfileId = null;
      state.toast = "profile deletion cancelled";
    } else {
      state.settings = null;
      state.mode = "NAV";
    }
  } else if (resolved.action === "paste-clipboard" && overlay.modelPicker !== null) {
    // The column is what the writer can see, so paste narrows it rather than
    // filling a row editor hidden behind it.
    await pasteIntoModelPicker(state, overlay);
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
  } else if (overlay.modelPicker !== null) {
    settingsModelPickerAction(resolved, state, overlay);
  } else if (overlay.edit !== null) {
    await settingsInlineEditAction(resolved, state, source, context, overlay);
  } else if (resolved.action === "focus-next") {
    overlay.cursor = boundedSettingsCursor(overlay.cursor + 1);
  } else if (resolved.action === "focus-previous") {
    overlay.cursor = boundedSettingsCursor(overlay.cursor - 1);
  } else if (resolved.action === "focus-index") {
    overlay.cursor = boundedSettingsCursor(resolved.index ?? overlay.cursor);
  } else if (resolved.action === "edit"
    && SETTINGS_ROW_IDS[boundedSettingsCursor(overlay.cursor)] === "profile") {
    if (!overlay.view.editable) {
      state.toast = "legacy settings are read-only";
    } else {
      beginSettingsRowEdit(overlay, state.config);
    }
  } else if (resolved.action === "open-selected" || resolved.action === "edit") {
    const row = SETTINGS_ROW_IDS[boundedSettingsCursor(overlay.cursor)]!;
    if (settingsRowUsesServer(row) && !overlay.view.editable) {
      state.toast = "legacy settings are read-only";
    } else if (row === "model") {
      // C-15: past eight options the list is a column, not a cycler. Below
      // that the row keeps opening for a typed identifier.
      if (modelPickerRequired(overlay)) overlay.modelPicker = { query: "", cursor: 0 };
      else beginSettingsRowEdit(overlay, state.config);
    } else if (settingsRowCycles(row)) {
      await cycleSettingsRow(row, 1, state, source, context, overlay);
    } else if (row === "system-prompt") {
      openSystemPromptEditor(state);
    } else if (row === "sampling") {
      overlay.sampling = {
        panel: "sampling",
        cursor: 0,
        logitBiasOrder: Object.keys(overlay.draft.sampling.logitBias),
        edit: null,
        result: null
      };
    } else {
      beginSettingsRowEdit(overlay, state.config);
    }
  } else if (resolved.action === "row-action") {
    // C-18: `tab` runs whatever this row declares, and nothing where a row
    // declares none.
    const action = settingsRows(overlay, state.config)[
      boundedSettingsCursor(overlay.cursor)
    ]?.action;
    if (action !== undefined) {
      await settingsOverlayAction({ action: action.key }, state, source, context);
    }
  } else if (resolved.action === "save-edit") {
    await saveSettingsDraft(state, source, context, overlay);
  } else if (resolved.action === "new-item" || resolved.action === "duplicate-item"
    || resolved.action === "delete-item") {
    manageSettingsProfile(resolved.action, state, overlay);
  } else if (resolved.action === "take-next" || resolved.action === "take-previous") {
    if (resolved.index !== undefined) {
      overlay.cursor = boundedSettingsCursor(resolved.index);
    }
    const step = resolved.action === "take-next" ? 1 : -1;
    const row = SETTINGS_ROW_IDS[boundedSettingsCursor(overlay.cursor)]!;
    if (settingsRowHasArrows(overlay, row)) {
      await cycleSettingsRow(
        row, step, state, source, context, overlay, resolved.magnitude ?? "step"
      );
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

function manageSettingsProfile(
  action: "new-item" | "duplicate-item" | "delete-item",
  state: RuntimeState,
  overlay: SettingsOverlayState
): void {
  const row = SETTINGS_ROW_IDS[boundedSettingsCursor(overlay.cursor)]!;
  if (row !== "profile") return;
  if (!overlay.view.editable || overlay.draft.document === null || overlay.draft.selectedProfileId === null) {
    state.toast = "legacy settings are read-only";
    return;
  }
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (action === "new-item" || action === "duplicate-item") {
    const created = action === "new-item"
      ? createSettingsProfile(document, profileId)
      : duplicateSettingsProfile(document, profileId);
    if ("error" in created) {
      state.toast = `profile kept · ${created.error}`;
      return;
    }
    overlay.draft = settingsTextDraftForDocument(created.document, created.profileId);
    overlay.deleteArmedProfileId = null;
    overlay.result = null;
    overlay.conflict = overlay.conflict === null ? null : { ...overlay.conflict, armed: false };
    state.toast = `${action === "new-item" ? "profile created" : "profile duplicated"} · s saves settings`;
    return;
  }
  if (overlay.deleteArmedProfileId !== profileId) {
    if (Object.keys(document.profiles).length === 1) {
      state.toast = "profile kept · the last profile cannot be removed";
      return;
    }
    overlay.deleteArmedProfileId = profileId;
    state.toast = `delete ${document.profiles[profileId]!.name} · d again confirms`;
    return;
  }
  const deleted = deleteSettingsProfile(document, profileId);
  if ("error" in deleted) {
    overlay.deleteArmedProfileId = null;
    state.toast = `profile kept · ${deleted.error}`;
    return;
  }
  overlay.draft = settingsTextDraftForDocument(deleted.document, deleted.profileId);
  discardUnreferencedConnectionSecretWrites(overlay);
  overlay.deleteArmedProfileId = null;
  overlay.result = null;
  overlay.conflict = overlay.conflict === null ? null : { ...overlay.conflict, armed: false };
  state.toast = "profile deleted · routes repaired · s saves settings";
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
      if (draft.document === null || draft.selectedProfileId === null) {
        throw new Error("Editable settings document is unavailable");
      }
      const discovery = overlay.modelDiscoveryIdentity
          === settingsModelDiscoveryIdentity(draft.generation)
        ? overlay.modelDiscovery
        : null;
      const savedDocument = applyBasicSettingsDraft(
        draft.document,
        draft.generation,
        draft.selectedProfileId
      );
      const selectedRemoteId = resolveSettingsProfile(
        savedDocument,
        draft.selectedProfileId
      ).model.remoteId;
      const discoveryMatchesSelectedModel = discovery?.models.some(
        (model) => model.remoteId === selectedRemoteId
      ) === true;
      document = applyBasicModelDiscovery(
        discoveryMatchesSelectedModel
          ? isolateSettingsProfileModel(savedDocument, draft.selectedProfileId)
          : savedDocument,
        discovery,
        draft.generation.contextWindow,
        draft.selectedProfileId
      );
      document = applySamplingSettings(
        document,
        draft.sampling,
        draft.selectedProfileId
      );
      assertSamplingDraftAvailable(document, draft.selectedProfileId);
      const cacheContext = promptCacheContextForProfile(document, draft.selectedProfileId);
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

function assertSamplingDraftAvailable(document: SettingsDocumentV2, profileId: string): void {
  const route = resolveSettingsProfile(document, profileId);
  const context = samplingContextForRoute(route);
  const sampling = route.profile.sampling ?? EMPTY_SAMPLING_V2;
  for (const { knob, resolution } of resolveConfiguredSamplingKnobs(context, sampling)) {
    if (resolution.kind === "unavailable") {
      throw new Error(
        `${samplingKnobLabel(knob)} is unavailable · ${SAMPLING_UNAVAILABLE_REASON_COMPACT[resolution.reason]}`
      );
    }
  }
}

const SAMPLING_UNAVAILABLE_REASON_COMPACT: Readonly<Record<SamplingUnavailableReason, string>> = {
  "legacy-v1": "read-only",
  "dry-run": "dry run",
  protocol: "not in protocol",
  "preset-unsupported": "not in preset",
  "preset-unknown": "unknown endpoint",
  "model-unsupported": "model unsupported",
  "model-unknown": "model unknown"
};

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

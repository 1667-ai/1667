import { createDurableMutationId } from "../../shared/durable-mutation-id.js";
import { applyBasicSettingsDraft } from "../../shared/settings-basic-draft.js";
import {
  applyPromptCachePolicy,
  promptCacheContextForDocument,
  promptCachePolicyPresentation
} from "../../shared/prompt-cache-capabilities.js";
import { settingsMutationFailureAction } from "../../shared/settings-mutation-failure.js";
import type { SettingsDocumentV2 } from "../../shared/settings-v2-types.js";
import type { AppSource } from "./app.js";
import { apiErrorCode } from "./api.js";
import {
  backspaceComposer,
  deleteComposerForward,
  insertComposerText,
  moveComposerHorizontal
} from "./composer-model.js";
import {
  moveComposerLineBoundary,
  selectAllComposer
} from "./composer-editing.js";
import { readFromClipboard } from "./clipboard.js";
import { saveConfig, THEME_NAMES, type ThemeName } from "./config.js";
import { sanitizePastedText, type ResolvedKey } from "./keys.js";
import { publishSettingsView } from "./overlay-publication.js";
import { detectSettingsContext } from "./settings-context-detection.js";
import { settingsProviderProbeTarget } from "./settings-provider-probe.js";
import {
  applySettingsRowEdit,
  applyStoredApiKeyIntent,
  beginSettingsPasteEdit,
  beginSettingsRowEdit,
  boundedSettingsCursor,
  cycleAllowInsecureHttp,
  cyclePromptCachePolicy,
  cycleSettingsProvider,
  initialSettingsOverlay,
  sameGenerationSettings,
  sameSettingsDraft,
  SETTINGS_ROW_IDS,
  settingsDraftChanged,
  settingsRowCycles,
  settingsRowUsesServer,
  settleSettingsOverlaySave
} from "./settings-overlay-model.js";
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
  if (row !== undefined) {
    state.settings.cursor = SETTINGS_ROW_IDS.indexOf(row);
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
    if (beginSettingsPasteEdit(overlay, state.config)) {
      await settingsInlineEditAction(resolved, state, source, context, overlay);
    } else {
      const row = SETTINGS_ROW_IDS[boundedSettingsCursor(overlay.cursor)]!;
      if (
        row === "theme"
        || row === "provider"
        || row === "allow-insecure-http"
        || row === "cache-policy"
      ) {
        state.toast = "this row is a selector · use ←→";
      } else if (!overlay.view.editable) {
        state.toast = "legacy settings are read-only";
      } else if (overlay.view.pendingRevision !== null) {
        state.toast = "settings pending restart · discard pending before editing";
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
    const serverBacked = settingsRowUsesServer(row);
    if (serverBacked && !overlay.view.editable) {
      state.toast = "legacy settings are read-only";
    } else if (serverBacked && overlay.view.pendingRevision !== null) {
      state.toast = "settings pending restart · discard pending before editing";
    } else if (row === "theme") {
      const index = THEME_NAMES.indexOf(state.config.theme);
      applyTheme(state, context, THEME_NAMES[(index + 1) % THEME_NAMES.length]!);
    } else if (row === "provider") {
      applyProviderChoice(overlay, state, 1);
    } else if (row === "allow-insecure-http") {
      applyAllowInsecureHttp(overlay, state);
    } else if (row === "cache-policy") {
      applyPromptCachePolicyChoice(overlay, state, 1);
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
    if (row === "theme") {
      const index = THEME_NAMES.indexOf(state.config.theme);
      const theme = THEME_NAMES[(index + step + THEME_NAMES.length) % THEME_NAMES.length]!;
      applyTheme(state, context, theme);
    } else if (row === "compose-focus") {
      // `d` used to toggle this, which collided with delete everywhere else.
      // It cycles with the other closed-choice rows instead.
      applyComposeFocus(state, source, state.config.composeFocus === "on" ? "off" : "on");
    } else if (settingsRowUsesServer(row) && settingsRowCycles(row)) {
      if (!overlay.view.editable) state.toast = "legacy settings are read-only";
      else if (overlay.view.pendingRevision !== null) {
        state.toast = "settings pending restart · discard pending before editing";
      } else if (row === "provider") {
        applyProviderChoice(overlay, state, step);
      } else if (row === "allow-insecure-http") {
        applyAllowInsecureHttp(overlay, state);
      } else if (row === "cache-policy") {
        applyPromptCachePolicyChoice(overlay, state, step);
      }
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
  const edit = overlay.edit!;
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
      applyTheme(state, context, applied.value);
      return;
    }
    if (applied.kind === "compose-focus") {
      applyComposeFocus(state, source, applied.value);
      return;
    }
    if (overlay.conflict !== null) overlay.conflict.armed = false;
    state.toast = settingsDraftChanged(overlay)
      ? "draft updated · s saves settings"
      : "unchanged · no-op";
    return;
  }
  if (resolved.action === "input") {
    if (overlay.conflict !== null) overlay.conflict.armed = false;
    insertComposerText(edit.composer, resolved.text ?? "");
  } else if (resolved.action === "backspace") {
    if (overlay.conflict !== null) overlay.conflict.armed = false;
    backspaceComposer(edit.composer);
  } else if (resolved.action === "delete-forward") {
    if (overlay.conflict !== null) overlay.conflict.armed = false;
    deleteComposerForward(edit.composer);
  } else if (resolved.action === "cursor-left") {
    moveComposerHorizontal(edit.composer, -1);
  } else if (resolved.action === "cursor-right") {
    moveComposerHorizontal(edit.composer, 1);
  } else if (resolved.action === "select-left") {
    moveComposerHorizontal(edit.composer, -1, true);
  } else if (resolved.action === "select-right") {
    moveComposerHorizontal(edit.composer, 1, true);
  } else if (resolved.action === "cursor-line-start") {
    moveComposerLineBoundary(edit.composer, false);
  } else if (resolved.action === "cursor-line-end") {
    moveComposerLineBoundary(edit.composer, true);
  } else if (resolved.action === "select-line-start") {
    moveComposerLineBoundary(edit.composer, false, true);
  } else if (resolved.action === "select-line-end") {
    moveComposerLineBoundary(edit.composer, true, true);
  } else if (resolved.action === "select-all") {
    selectAllComposer(edit.composer);
  }
}

function pasteSettingsInlineEdit(
  overlay: SettingsOverlayState,
  raw: string
): boolean {
  const edit = overlay.edit;
  if (edit === null) return false;
  const clean = sanitizePastedText(raw);
  if (clean.length === 0) return false;
  if (overlay.conflict !== null) overlay.conflict.armed = false;
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
  if (overlay.view.pendingRevision !== null) {
    return void (state.toast = "settings pending restart · editing frozen");
  }
  if (state.connection.down) {
    return void (state.toast = "offline · draft kept until the connection returns");
  }
  if (overlay.saveIntent === undefined && !settingsDraftChanged(overlay)) {
    overlay.conflict = null;
    state.toast = "unchanged · no-op";
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
      document = applyStoredApiKeyIntent(
        applyPromptCachePolicy(
          applyBasicSettingsDraft(overlay.view.document, draft.generation),
          draft.cachePolicy
        ),
        connectionSecrets
      );
      const cacheContext = promptCacheContextForDocument(document);
      const presentation = promptCachePolicyPresentation(cacheContext, draft.cachePolicy);
      if (!presentation.available) {
        throw new Error(
          presentation.unavailableReason
            ?? "The selected prompt-cache policy is unavailable."
        );
      }
    } catch (error) {
      state.toast = `settings kept · ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    if (
      document === overlay.view.document
      && Object.keys(connectionSecrets).length === 0
    ) {
      overlay.draft = overlay.base;
      overlay.conflict = null;
      state.toast = "unchanged · no-op";
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
      state.toast = "settings changed elsewhere · latest revision loaded, draft kept";
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
      intent.connectionSecrets
    );
    const message = result.pendingSettingsRevision === null
      ? "settings saved"
      : "settings staged · restart required";
    state.toast = newerEdits ? `${message} · newer edits kept` : message;
  });
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
      state.toast = "settings changed elsewhere · refreshed latest revision";
      return;
    }
    const view = await source.api.getSettings();
    if (!task.owns()) return;
    delete overlay.discardIntent;
    publishSettingsView(state, source, view);
    state.toast = "pending settings discarded";
  });
}

async function checkSettings(
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
      const checked = overlay.view.editable && overlay.view.pendingRevision === null
        ? overlay.draft.generation
        : overlay.view.effective;
      const result = await source.api.checkModelServer(
        settingsProviderProbeTarget(overlay.view, checked)
      );
      const current = overlay.view.editable && overlay.view.pendingRevision === null
        ? overlay.draft.generation
        : overlay.view.effective;
      if (task.owns() && state.settings === overlay
        && (overlay.edit === null || !settingsRowUsesServer(overlay.edit.row))
        && sameGenerationSettings(checked, current)) {
        overlay.result = result;
      }
    } finally {
      if (task.owns() && state.settings === overlay) overlay.checking = false;
    }
  });
}

function applyTheme(
  state: RuntimeState,
  context: ActionContext,
  theme: ThemeName
): void {
  context.applyTheme(theme);
  state.toast = `theme · ${theme}`;
}

function applyProviderChoice(
  overlay: SettingsOverlayState,
  state: RuntimeState,
  step: -1 | 1
): void {
  const choice = cycleSettingsProvider(overlay, step);
  state.toast = `provider · ${choice.label} · s saves settings`;
}

function applyComposeFocus(
  state: RuntimeState,
  source: AppSource,
  composeFocus: "on" | "off"
): void {
  state.config = { ...state.config, composeFocus };
  source.config = state.config;
  if (!state.demo) saveConfig(state.config);
  state.toast = `compose focus · ${composeFocus}`;
}

function applyPromptCachePolicyChoice(
  overlay: SettingsOverlayState,
  state: RuntimeState,
  step: -1 | 1
): void {
  const policy = cyclePromptCachePolicy(overlay, step);
  state.toast = `cache policy · ${policy} · s saves settings`;
}

function applyAllowInsecureHttp(
  overlay: SettingsOverlayState,
  state: RuntimeState
): void {
  const enabled = cycleAllowInsecureHttp(overlay);
  state.toast = `insecure HTTP (LAN) · ${enabled ? "on" : "off"} · s saves settings`;
}

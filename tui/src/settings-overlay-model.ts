import {
  type SettingsActivationErrorCodeV2,
  type SettingsPresetV2,
  type SettingsView
} from "../../shared/settings-v2-types.js";
import {
  LOCAL_CONFIG_ROWS,
  settingsRowIsLocal,
  type LocalConfigRow
} from "./settings-local-rows.js";
export { LOCAL_CONFIG_ROWS, settingsRowIsLocal, type LocalConfigRow };
import { resolveSettingsProfile } from "../../shared/settings-route.js";
import type { UserConfig } from "./config.js";
import { THEME_NAMES, type ThemeName } from "./config.js";
import {
  createComposer,
  type ComposerState
} from "./composer-model.js";
import { graphemeCells } from "./cell-width.js";
import {
  nextSettingsProviderChoice,
  type SettingsProviderChoice
} from "./settings-provider-choices.js";
import {
  applySettingsManualContextDraft,
  replaceSettingsDraft,
  replaceSettingsProviderDraft
} from "./settings-draft-transition.js";
import {
  applyCachedSettingsModelChoice,
  applySettingsModelChoice
} from "./settings-model-selection.js";
import {
  settingsModelChoices,
  settingsModelSelectionTargetIdentity
} from "./settings-model-discovery.js";
import {
  applyConnectionTimeoutEdit,
  connectionTimeoutEditValue,
  isConnectionTimeoutRow
} from "./settings-connection-timeouts.js";
import {
  parseSettings,
  settingsTextDraftForDocument,
  settingsTextDraftForView,
  settingsTextDraftWithGeneration,
  settingsTextDraftWithSubscriptionPlan,
  settingsTextDraftWithTextPreset
} from "./settings-text.js";
import { settingsPlanRowDisabled } from "./settings-subscription.js";
import { renameSettingsProfile } from "./settings-profile-draft.js";
import { settingsModelDisplayText } from "./settings-profile-controls.js";
import type {
  SettingsInlineEditState,
  SettingsOverlayState,
  SettingsRowId
} from "./state.js";
import {
  applyStoredApiKeyEdit,
  discardUnreferencedConnectionSecretWrites,
  hasStoredApiKey,
  rekeyPendingStoredSecret
} from "./settings-secret-sidecar.js";
import {
  draftRowEditValue,
  sameSettingsDraft,
  settingsDraftChanged,
  settingsFieldKey
} from "./settings-overlay-reconciliation.js";
import {
  boundedSettingsCursor,
  SETTINGS_ROW_IDS,
  settingsRowCycles,
  settingsRowHasArrows,
  settingsRowIndex,
  settingsRowIds,
  settingsCursorRowIdentity,
  restoreSettingsCursor
} from "./settings-row-navigation.js";
export {
  settingsModelDisplayText
} from "./settings-profile-controls.js";
export {
  settingsRows,
  SETTINGS_SECTIONS,
  type SettingsRowPresentation,
  type SettingsSectionId
} from "./settings-row-presentations.js";
export { promptCacheRowValue } from "./settings-profile-controls.js";
export {
  boundedSettingsCursor,
  SETTINGS_ROW_IDS,
  settingsRowCycles,
  settingsRowHasArrows,
  settingsRowIndex,
  settingsRowIds,
  settingsCursorRowIdentity,
  restoreSettingsCursor
} from "./settings-row-navigation.js";

/** Rows that live in the user config rather than a server-backed settings
 *  revision. One list backs every "is this row local?" test in the overlay,
 *  instead of each site naming the same three rows by hand. */


export {
  reconcileSettingsOverlay,
  sameGenerationSettings,
  sameSettingsDraft,
  settingsDraftChanged,
  settleSettingsOverlaySave
} from "./settings-overlay-reconciliation.js";

type SettingsInlineRow = Exclude<SettingsRowId, "system-prompt" | "sampling">;

export function initialSettingsOverlay(
  view: SettingsView,
  config: UserConfig,
  selectedProfileId?: string
): SettingsOverlayState {
  const draft = settingsTextDraftForView(view, selectedProfileId);
  return {
    view,
    base: draft,
    draft,
    modelSelectionByProfile: {},
    connectionSecrets: {},
    cursor: 0,
    edit: null,
    sampling: null,
    profileTransfer: null,
    conflict: null,
    checking: false,
    probing: false,
    discoveringModels: false,
    modelDiscovery: null,
    modelDiscoveryIdentity: null,
    modelDiscoveryResultTargetIdentity: null,
    modelDiscoveryGeneration: 0,
    modelDiscoveryAbortController: null,
    modelDiscoveryTargetIdentity: null,
    result: null,
    resultRow: null,
    deleteArmedProfileId: null,
    modelPicker: null
  };
}

export function settingsRowEditValue(
  overlay: SettingsOverlayState,
  config: UserConfig,
  row: SettingsInlineRow
): string {
  if (row === "theme") return config.theme;
  if (row === "compose-focus") return config.composeFocus;
  if (row === "word-wrap") return config.wordWrap;
  if (row === "allow-insecure-http") {
    return overlay.draft.generation.allowInsecureHttp === true ? "on" : "off";
  }
  if (row === "profile") {
    const document = overlay.draft.document;
    const profileId = overlay.draft.selectedProfileId;
    return document === null || profileId === null
      ? "legacy profile"
      : document.profiles[profileId]?.name ?? "unavailable";
  }
  if (isConnectionTimeoutRow(row)) return connectionTimeoutEditValue(row, overlay);
  return draftRowEditValue(overlay.draft, row);
}

export function beginSettingsRowEdit(
  overlay: SettingsOverlayState,
  config: UserConfig
): void {
  const row = settingsRowIds(overlay)[boundedSettingsCursor(overlay.cursor, overlay)]!;
  if (row === "system-prompt" || row === "sampling") return;
  if (settingsPlanRowDisabled(overlay, row)) return;
  if (settingsRowUsesServer(row)) overlay.result = null;
  const initial = settingsRowEditValue(overlay, config, row);
  const composer = createComposer(initial);
  if (initial.length > 0) composer.anchor = 0;
  overlay.edit = {
    kind: "inline",
    row,
    mode: row === "api-key" ? "secret" : "text",
    composer,
    initial
  };
}

/** Any Settings draft change invalidates prior overwrite consent. */
export function disarmSettingsConflict(overlay: SettingsOverlayState): void {
  if (overlay.conflict !== null) overlay.conflict.armed = false;
}

/** Same grapheme offsets as the write-only buffer; no secret code units cross
 * into rendered text, terminal selection, or clipboard projection. */
export function settingsEditDisplayComposer(
  edit: SettingsInlineEditState
): ComposerState {
  if (edit.mode === "text") return edit.composer;
  const projection = createComposer(maskSecretText(edit.composer.text));
  projection.cursor = edit.composer.cursor;
  projection.anchor = edit.composer.anchor;
  projection.fullscreen = edit.composer.fullscreen;
  return projection;
}

export function beginSettingsPasteEdit(
  overlay: SettingsOverlayState,
  config: UserConfig
): boolean {
  if (overlay.edit !== null) return true;
  const row = settingsRowIds(overlay)[boundedSettingsCursor(overlay.cursor, overlay)]!;
  if (row === "system-prompt" || row === "sampling") return false;
  if (settingsPlanRowDisabled(overlay, row)) return false;
  // Closed choices cycle in place; paste must not open their row editor.
  if (settingsRowCycles(row)) return false;
  if (settingsRowUsesServer(row) && !overlay.view.editable) {
    return false;
  }
  beginSettingsRowEdit(overlay, config);
  return true;
}

export function applySettingsRowEdit(
  overlay: SettingsOverlayState,
  config: UserConfig
): { kind: "theme"; value: ThemeName }
  | { kind: "local"; row: "compose-focus" | "word-wrap"; value: "on" | "off" }
  | { kind: "draft" }
  | { kind: "error"; message: string } {
  const edit = overlay.edit;
  if (edit?.kind !== "inline") {
    return { kind: "error", message: "no settings row is being edited" };
  }
  if (settingsPlanRowDisabled(overlay, edit.row)) {
    overlay.edit = null;
    return { kind: "error", message: "subscription plan controls are fixed" };
  }
  const rawValue = edit.composer.text;
  const value = rawValue.trim();
  if (edit.row === "theme") {
    if (!THEME_NAMES.includes(value as ThemeName)) {
      return { kind: "error", message: `theme must be ${THEME_NAMES.join(", ")}` };
    }
    overlay.edit = null;
    return { kind: "theme", value: value as ThemeName };
  }
  if (edit.row === "compose-focus" || edit.row === "word-wrap") {
    if (value !== "on" && value !== "off") {
      const label = edit.row === "compose-focus" ? "compose focus" : "word wrap";
      return { kind: "error", message: `${label} must be on or off` };
    }
    overlay.edit = null;
    return { kind: "local", row: edit.row, value };
  }
  if (edit.row === "api-key") {
    const result = applyStoredApiKeyEdit(overlay, rawValue);
    if (result !== null) return { kind: "error", message: result };
    overlay.edit = null;
    if (!settingsDraftChanged(overlay)) overlay.conflict = null;
    return { kind: "draft" };
  }
  if (edit.row === "allow-insecure-http") {
    return { kind: "error", message: "insecure HTTP is a selector" };
  }
  if (edit.row === "profile") {
    if (overlay.draft.document === null || overlay.draft.selectedProfileId === null) {
      return { kind: "error", message: "legacy settings are read-only" };
    }
    const renamed = renameSettingsProfile(
      overlay.draft.document,
      overlay.draft.selectedProfileId,
      rawValue
    );
    if ("error" in renamed) return { kind: "error", message: renamed.error };
    replaceSettingsDraft(
      overlay,
      settingsTextDraftForDocument(renamed, overlay.draft.selectedProfileId)
    );
    overlay.edit = null;
    overlay.result = null;
    return { kind: "draft" };
  }
  if (isConnectionTimeoutRow(edit.row)) {
    const applied = applyConnectionTimeoutEdit(overlay, edit.row, value);
    if (applied.kind === "error") return applied;
    if (!settingsDraftChanged(overlay)) overlay.conflict = null;
    overlay.edit = null;
    overlay.result = null;
    return { kind: "draft" };
  }
  const fieldKey = settingsFieldKey(edit.row);
  if (fieldKey === undefined) return { kind: "error", message: "this row is a selector" };
  const parsed = parseSettings(
    `${fieldKey}: ${value}`,
    overlay.draft
  );
  if ("error" in parsed) return { kind: "error", message: parsed.error };
  const modelChanged = edit.row === "model"
    && parsed.generation.model !== overlay.draft.generation.model;
  const identityChanged = (
    edit.row === "base-url"
      && parsed.generation.baseUrl !== overlay.draft.generation.baseUrl
  ) || modelChanged;
  const next = identityChanged
    ? {
        ...parsed,
        generation: { ...parsed.generation, contextWindow: null }
      }
    : parsed;
  try {
    if (edit.row === "model") {
      applySettingsModelChoice(overlay, {
        remoteId: next.generation.model,
        contextWindow: modelChanged ? null : next.generation.contextWindow
      }, undefined, { kind: "typed" });
    } else {
      if (edit.row === "context-window"
        && next.generation.contextWindow !== null) {
        applySettingsManualContextDraft(overlay, next.generation);
      } else {
        replaceSettingsDraft(
          overlay,
          settingsTextDraftWithGeneration(overlay.draft, next.generation)
        );
      }
    }
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
  if (edit.row === "model") {
    const error = applyCachedSettingsModelChoice(
      overlay,
      settingsModelChoices(overlay),
      settingsModelSelectionTargetIdentity(overlay)
    );
    if (error !== null) return { kind: "error", message: error };
  }
  if (edit.row === "api-key-env") discardUnreferencedConnectionSecretWrites(overlay);
  if (!settingsDraftChanged(overlay)) overlay.conflict = null;
  overlay.edit = null;
  overlay.result = null;
  return { kind: "draft" };
}

export function applySystemPromptDraft(
  overlay: SettingsOverlayState,
  systemPrompt: string
): void {
  disarmSettingsConflict(overlay);
  replaceSettingsDraft(
    overlay,
    settingsTextDraftWithGeneration(overlay.draft, {
      ...overlay.draft.generation,
      systemPrompt
    })
  );
  if (sameSettingsDraft(overlay.draft, overlay.base)) overlay.conflict = null;
  overlay.result = null;
}

/** One spelling for every surface that reports why an activation failed. */
export function settingsActivationFailureText(
  errorCode: SettingsActivationErrorCodeV2
): string {
  switch (errorCode) {
    case "credential_unresolved":
      return "credential not found (env var or stored key)";
    case "candidate_invalid":
      return "provider check failed";
    case "activation_crashed":
      return "activation was interrupted";
    case "activation_failed":
    case "readiness_failed":
      return "rolled back after an interruption";
  }
}

/** Local-only rows live in the user config; every other row edits a
 * server-backed settings revision. */
export function settingsRowUsesServer(row: SettingsRowId): boolean {
  return !settingsRowIsLocal(row);
}

export function cycleSettingsProvider(
  overlay: SettingsOverlayState,
  step: -1 | 1
): SettingsProviderChoice {
  const cursorRow = settingsCursorRowIdentity(overlay);
  const choice = nextSettingsProviderChoice(
    overlay.draft.generation,
    step,
    selectedConnectionPreset(overlay)
  );
  const preserveStoredApiKey = hasStoredApiKey(overlay);
  const generation = {
    ...overlay.draft.generation,
    provider: choice.provider,
    ...choice.defaults,
    ...(preserveStoredApiKey ? { apiKeyEnv: null } : {})
  };
  if (choice.id === "chatgpt-plan" || choice.id === "claude-plan") {
    replaceSettingsProviderDraft(
      overlay,
      settingsTextDraftWithSubscriptionPlan(overlay.draft, choice.id, generation)
    );
  } else {
    replaceSettingsProviderDraft(
      overlay,
      settingsTextDraftWithGeneration(overlay.draft, generation)
    );
  }
  const textPreset = textPresetForChoice(choice);
  if (textPreset !== null) {
    replaceSettingsDraft(
      overlay,
      settingsTextDraftWithTextPreset(overlay.draft, textPreset)
    );
  }
  rekeyPendingStoredSecret(overlay);
  discardUnreferencedConnectionSecretWrites(overlay);
  restoreSettingsCursor(overlay, cursorRow);
  overlay.result = null;
  if (!settingsDraftChanged(overlay)) overlay.conflict = null;
  else disarmSettingsConflict(overlay);
  return choice;
}

function selectedConnectionPreset(
  overlay: SettingsOverlayState
): SettingsPresetV2 | undefined {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null) return undefined;
  return resolveSettingsProfile(document, profileId).connection.preset;
}

function textPresetForChoice(
  choice: SettingsProviderChoice
): "custom" | "llama-cpp" | "koboldcpp" | null {
  if (choice.id === "llama-cpp-text") return "llama-cpp";
  if (choice.id === "koboldcpp-text") return "koboldcpp";
  return choice.id === "text-completion" ? "custom" : null;
}

export function cycleSettingsModel(
  overlay: SettingsOverlayState,
  step: -1 | 1
): string | null {
  const choices = settingsModelChoices(overlay);
  if (choices.length === 0) return null;
  const current = choices.findIndex(
    (choice) => choice.remoteId === overlay.draft.generation.model
  );
  const index = current < 0
    ? step === 1 ? 0 : choices.length - 1
    : (current + step + choices.length) % choices.length;
  const choice = choices[index]!;
  applySettingsModelChoice(overlay, choice);
  return choice.remoteId;
}

function maskSecretText(value: string): string {
  return graphemeCells(value)
    .map((cell) => /[\r\n]/u.test(cell.text) ? cell.text : "•")
    .join("");
}

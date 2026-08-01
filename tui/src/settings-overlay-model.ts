import { type SettingsActivationErrorCodeV2, type SettingsView } from "../../shared/settings-v2-types.js";
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
import { settingsModelChoices } from "./settings-model-discovery.js";
import { samplingSummary } from "./sampling-model.js";
import {
  parseSettings,
  settingsTextDraftForDocument,
  settingsTextDraftForView,
  settingsTextDraftWithGeneration
} from "./settings-text.js";
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

export {
  promptCacheRowValue,
  settingsModelDisplayText,
  settingsRows,
  type SettingsRowPresentation
} from "./settings-profile-controls.js";

export const SETTINGS_ROW_IDS = [
  "theme",
  "compose-focus",
  "provider",
  "base-url",
  "allow-insecure-http",
  "api-key",
  "api-key-env",
  "profile",
  "model",
  "temperature",
  "max-tokens",
  "sampling",
  "context-window",
  "effort",
  "cache-policy",
  "default-route",
  "prose-route",
  "utility-route",
  "system-prompt"
] as const satisfies readonly SettingsRowId[];

export {
  reconcileSettingsOverlay,
  sameGenerationSettings,
  sameSettingsDraft,
  settingsDraftChanged,
  settleSettingsOverlaySave
} from "./settings-overlay-reconciliation.js";

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
    connectionSecrets: {},
    cursor: 0,
    edit: null,
    sampling: null,
    conflict: null,
    checking: false,
    probing: false,
    discoveringModels: false,
    modelDiscovery: null,
    modelDiscoveryIdentity: null,
    modelDiscoveryGeneration: 0,
    modelDiscoveryAbortController: null,
    modelDiscoveryTargetIdentity: null,
    result: null,
    deleteArmedProfileId: null
  };
}

export function settingsRowEditValue(
  overlay: SettingsOverlayState,
  config: UserConfig,
  row: SettingsRowId
): string {
  if (row === "theme") return config.theme;
  if (row === "compose-focus") return config.composeFocus;
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
  if (row === "sampling") return samplingSummary(overlay.draft.sampling);
  return draftRowEditValue(overlay.draft, row);
}

export function beginSettingsRowEdit(
  overlay: SettingsOverlayState,
  config: UserConfig
): void {
  const row = SETTINGS_ROW_IDS[boundedSettingsCursor(overlay.cursor)]!;
  if (row === "system-prompt" || row === "sampling") return;
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
  const row = SETTINGS_ROW_IDS[boundedSettingsCursor(overlay.cursor)]!;
  if (row === "system-prompt") return false;
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
  | { kind: "compose-focus"; value: UserConfig["composeFocus"] }
  | { kind: "draft" }
  | { kind: "error"; message: string } {
  const edit = overlay.edit;
  if (edit?.kind !== "inline") {
    return { kind: "error", message: "no settings row is being edited" };
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
  if (edit.row === "compose-focus") {
    if (value !== "on" && value !== "off") {
      return { kind: "error", message: "compose focus must be on or off" };
    }
    overlay.edit = null;
    return { kind: "compose-focus", value };
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
    overlay.draft = settingsTextDraftForDocument(renamed, overlay.draft.selectedProfileId);
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
  const identityChanged = (
    edit.row === "base-url"
      && parsed.generation.baseUrl !== overlay.draft.generation.baseUrl
  ) || (
    edit.row === "model"
      && parsed.generation.model !== overlay.draft.generation.model
  );
  const next = identityChanged
    ? {
        ...parsed,
        generation: { ...parsed.generation, contextWindow: null }
      }
    : parsed;
  try {
    overlay.draft = settingsTextDraftWithGeneration(overlay.draft, next.generation);
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
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
  overlay.draft = settingsTextDraftWithGeneration(overlay.draft, {
    ...overlay.draft.generation,
    systemPrompt
  });
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

export function boundedSettingsCursor(value: number): number {
  return Math.max(0, Math.min(SETTINGS_ROW_IDS.length - 1, value));
}

/** Rows whose value is a closed choice: `←→` cycles them in place and their
 * value's brackets are click targets. Everything else is free text the row
 * editor owns. One spelling of the set, read by the panel and the key handler.
 * Deliberately not the inverse of `settingsRowUsesServer`: provider cycles and
 * is server-backed, while theme and compose focus cycle and are local. */
export function settingsRowCycles(row: SettingsRowId): boolean {
  return row === "theme"
    || row === "compose-focus"
    || row === "provider"
    || row === "allow-insecure-http"
    || row === "profile"
    || row === "effort"
    || row === "cache-policy"
    || row === "default-route"
    || row === "prose-route"
    || row === "utility-route";
}

export function settingsRowHasArrows(
  overlay: SettingsOverlayState,
  row: SettingsRowId
): boolean {
  return settingsRowCycles(row)
    || row === "model" && settingsModelChoices(overlay).length > 0;
}

/** Local-only rows live in the user config; every other row edits a
 * server-backed settings revision. */
export function settingsRowUsesServer(row: SettingsRowId): boolean {
  return row !== "theme" && row !== "compose-focus";
}

export function cycleSettingsProvider(
  overlay: SettingsOverlayState,
  step: -1 | 1
): SettingsProviderChoice {
  const choice = nextSettingsProviderChoice(overlay.draft.generation, step);
  const preserveStoredApiKey = hasStoredApiKey(overlay);
  overlay.draft = settingsTextDraftWithGeneration(overlay.draft, {
    ...overlay.draft.generation,
    provider: choice.provider,
    ...choice.defaults,
    ...(preserveStoredApiKey ? { apiKeyEnv: null } : {})
  });
  rekeyPendingStoredSecret(overlay);
  discardUnreferencedConnectionSecretWrites(overlay);
  overlay.result = null;
  if (!settingsDraftChanged(overlay)) overlay.conflict = null;
  else disarmSettingsConflict(overlay);
  return choice;
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
  if (choice.remoteId === overlay.draft.generation.model) {
    return choice.remoteId;
  }
  overlay.draft = settingsTextDraftWithGeneration(overlay.draft, {
    ...overlay.draft.generation,
    model: choice.remoteId,
    contextWindow: choice.contextWindow
  });
  overlay.result = null;
  if (!settingsDraftChanged(overlay)) overlay.conflict = null;
  else disarmSettingsConflict(overlay);
  return choice.remoteId;
}

export function cycleAllowInsecureHttp(overlay: SettingsOverlayState): boolean {
  const allowInsecureHttp = overlay.draft.generation.allowInsecureHttp !== true;
  const generation = { ...overlay.draft.generation };
  if (allowInsecureHttp) generation.allowInsecureHttp = true;
  else delete generation.allowInsecureHttp;
  overlay.draft = settingsTextDraftWithGeneration(overlay.draft, generation);
  overlay.result = null;
  if (!settingsDraftChanged(overlay)) overlay.conflict = null;
  else disarmSettingsConflict(overlay);
  return allowInsecureHttp;
}

function maskSecretText(value: string): string {
  return graphemeCells(value)
    .map((cell) => /[\r\n]/u.test(cell.text) ? cell.text : "•")
    .join("");
}

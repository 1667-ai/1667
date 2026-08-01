import type { SettingsView } from "../../shared/settings-v2-types.js";
import type { GenerationSettings } from "../../shared/types.js";
import { setComposerText } from "./composer-model.js";
import type { ActiveSettingsEdit } from "./settings-edit-state.js";
import { renameSettingsProfile } from "./settings-profile-draft.js";
import { sameConnectionSecrets } from "./settings-secret-sidecar.js";
import {
  parseSettings,
  settingsTextDraftForDocument,
  settingsTextDraftForView,
  settingsTextDraftProjectionIdentity,
  settingsTextDraftWithGeneration,
  type SettingsTextDraft
} from "./settings-text.js";
import type { SettingsOverlayState, SettingsRowId } from "./state.js";

type EditableSettingsFieldRow =
  | "provider"
  | "base-url"
  | "model"
  | "api-key-env"
  | "temperature"
  | "max-tokens"
  | "context-window"
  | "system-prompt";

const SETTINGS_FIELD_KEYS = {
  provider: "provider",
  "base-url": "baseUrl",
  model: "model",
  "api-key-env": "apiKeyEnv",
  temperature: "temperature",
  "max-tokens": "maxTokens",
  "context-window": "contextWindow",
  "system-prompt": "systemPrompt"
} as const satisfies Record<EditableSettingsFieldRow, string>;

export function settingsDraftChanged(overlay: SettingsOverlayState): boolean {
  return !sameSettingsDraft(overlay.draft, overlay.base)
    || Object.keys(overlay.connectionSecrets).length > 0;
}

export function sameSettingsDraft(
  left: SettingsTextDraft,
  right: SettingsTextDraft
): boolean {
  if (left.document !== null || right.document !== null) {
    return left.document !== null
      && right.document !== null
      && JSON.stringify(left.document) === JSON.stringify(right.document)
      && settingsTextDraftProjectionIdentity(left)
        === settingsTextDraftProjectionIdentity(right);
  }
  return left.cachePolicy === right.cachePolicy
    && sameGenerationSettings(left.generation, right.generation);
}

/** Rebase a clean menu refresh. Preserve dirty row drafts. Require an
 * explicit overwrite when the authoritative document changes below them. */
export function reconcileSettingsOverlay(
  overlay: SettingsOverlayState,
  view: SettingsView,
  edit: ActiveSettingsEdit | null
): string | null {
  const nextBase = settingsTextDraftForView(view, overlay.draft.selectedProfileId);
  const baseChanged = !sameSettingsDraft(overlay.base, nextBase);
  if (!baseChanged) {
    overlay.base = nextBase;
    return null;
  }

  const draftWasClean = !settingsDraftChanged(overlay);
  const editRow = edit?.row ?? null;
  const editAffectsServer = edit !== null
    && editRow !== "theme"
    && editRow !== "compose-focus";
  const editWasClean = !editAffectsServer
    || edit.composer.text === edit.initialText();
  const activeEditBase = draftWasClean ? nextBase : overlay.draft;
  const activeDraft = editAffectsServer && !editWasClean
    ? draftWithActiveEdit(activeEditBase, edit)
    : overlay.draft;
  const converged = activeDraft !== null && sameSettingsDraft(activeDraft, nextBase);
  if (draftWasClean || converged) overlay.draft = nextBase;
  overlay.base = nextBase;

  if (edit !== null && (draftWasClean || converged) && editWasClean
    && editRow !== null
    && settingsDraftTextRow(editRow)) {
    const refreshed = draftRowEditValue(overlay.draft, editRow);
    setComposerText(edit.composer, refreshed);
    if (refreshed.length > 0) edit.composer.anchor = 0;
    edit.setInitialText(refreshed);
  }

  if (converged) {
    if (editAffectsServer && !editWasClean) edit.setInitialText(edit.composer.text);
    overlay.conflict = null;
    return "settings changed during refresh · draft now current";
  }
  if (draftWasClean && editWasClean) {
    overlay.conflict = null;
    return "settings changed during refresh · menu refreshed";
  }
  overlay.conflict = {
    message: "settings changed during refresh · draft kept",
    armed: false
  };
  return overlay.conflict.message;
}

export function settleSettingsOverlaySave(
  overlay: SettingsOverlayState,
  acknowledged: SettingsTextDraft,
  edit: ActiveSettingsEdit | null,
  acknowledgedSecrets: Readonly<Record<string, string | null>> = {}
): boolean {
  const newerDraft = !sameSettingsDraft(overlay.draft, acknowledged)
    || !sameConnectionSecrets(overlay.connectionSecrets, acknowledgedSecrets);
  if (sameConnectionSecrets(overlay.connectionSecrets, acknowledgedSecrets)) {
    overlay.connectionSecrets = {};
  }
  const nextBase = settingsTextDraftForView(
    overlay.view,
    overlay.draft.selectedProfileId
  );
  overlay.base = nextBase;
  if (!newerDraft) overlay.draft = nextBase;
  overlay.conflict = null;
  return newerDraft || (
    edit !== null && edit.composer.text !== edit.initialText()
  );
}

export function sameGenerationSettings(
  left: GenerationSettings,
  right: GenerationSettings
): boolean {
  return left.provider === right.provider
    && left.baseUrl === right.baseUrl
    && left.model === right.model
    && left.apiKeyEnv === right.apiKeyEnv
    && left.allowInsecureHttp === right.allowInsecureHttp
    && left.temperature === right.temperature
    && left.maxTokens === right.maxTokens
    && left.contextWindow === right.contextWindow
    && left.systemPrompt === right.systemPrompt;
}

export function draftRowEditValue(
  draft: SettingsTextDraft,
  row: Exclude<SettingsRowId, "theme" | "compose-focus" | "allow-insecure-http" | "profile">
): string {
  const settings = draft.generation;
  if (row === "provider") return settings.provider;
  if (row === "base-url") return settings.baseUrl;
  if (row === "model") return settings.model;
  if (row === "api-key") return "";
  if (row === "api-key-env") return settings.apiKeyEnv ?? "";
  if (row === "temperature") return settings.temperature?.toString() ?? "";
  if (row === "max-tokens") return settings.maxTokens.toString();
  if (row === "context-window") return settings.contextWindow?.toString() ?? "";
  return settings.systemPrompt;
}

export function settingsFieldKey(row: SettingsRowId): string | undefined {
  return Object.hasOwn(SETTINGS_FIELD_KEYS, row)
    ? SETTINGS_FIELD_KEYS[row as EditableSettingsFieldRow]
    : undefined;
}

function draftWithActiveEdit(
  draft: SettingsTextDraft,
  edit: ActiveSettingsEdit
): SettingsTextDraft | null {
  const row = edit.row;
  if (row === "theme" || row === "compose-focus") return draft;
  if (row === "profile") {
    if (draft.document === null || draft.selectedProfileId === null) return null;
    const renamed = renameSettingsProfile(
      draft.document,
      draft.selectedProfileId,
      edit.composer.text
    );
    return "error" in renamed
      ? null
      : settingsTextDraftForDocument(renamed, draft.selectedProfileId);
  }
  if (row === "api-key" || row === "allow-insecure-http") {
    return edit.composer.text === edit.initialText() ? draft : null;
  }
  if (row === "system-prompt") {
    return settingsTextDraftWithGeneration(draft, {
      ...draft.generation,
      systemPrompt: edit.composer.text
    });
  }
  const fieldKey = settingsFieldKey(row);
  if (fieldKey === undefined) return draft;
  const parsed = parseSettings(`${fieldKey}: ${edit.composer.text}`, draft);
  return "error" in parsed
    ? null
    : settingsTextDraftWithGeneration(draft, parsed.generation);
}

function settingsDraftTextRow(
  row: SettingsRowId
): row is Exclude<
  SettingsRowId,
  "theme" | "compose-focus" | "allow-insecure-http" | "profile"
> {
  return row !== "theme"
    && row !== "compose-focus"
    && row !== "allow-insecure-http"
    && row !== "profile";
}

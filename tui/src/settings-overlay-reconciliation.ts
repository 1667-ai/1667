import type { SettingsView } from "../../shared/settings-v2-types.js";
import type { GenerationSettings } from "../../shared/types.js";
import { samplingSettingsEqual } from "../../shared/sampling-capabilities.js";
import {
  isWritingPromptRow,
  writingPromptFieldDefinitionForRow
} from "../../shared/settings-v5-writing.js";
import { setComposerText } from "./composer-model.js";
import type { ActiveSettingsEdit } from "./settings-edit-state.js";
import {
  settingsRowIsLocal,
  type LocalConfigRow
} from "./settings-local-rows.js";
import {
  draftWriting,
  settingsTextDraftWithMergedWriting,
  settingsTextDraftWithWritingField
} from "./settings-writing-draft.js";
import { renameSettingsProfile } from "./settings-profile-draft.js";
import {
  connectionTimeoutEditValueForDraft,
  draftWithConnectionTimeoutEditText,
  isConnectionTimeoutRow
} from "./settings-connection-timeouts.js";
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
import {
  acknowledgeSettingsModelSelection,
  replaceAuthoritativeSettingsDraft,
  replaceSettingsDraft,
  settingsAutomaticModelSelectionForProfile
} from "./settings-draft-transition.js";
import { settingsModelTargetFingerprint } from "./settings-provider-probe.js";
import {
  restoreSettingsCursor,
  settingsCursorRowIdentity
} from "./settings-row-navigation.js";

type EditableSettingsFieldRow =
  | "provider"
  | "base-url"
  | "model"
  | "api-key-env"
  | "temperature"
  | "max-tokens"
  | "context-window";

const SETTINGS_FIELD_KEYS = {
  provider: "provider",
  "base-url": "baseUrl",
  model: "model",
  "api-key-env": "apiKeyEnv",
  temperature: "temperature",
  "max-tokens": "maxTokens",
  "context-window": "contextWindow"
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
        === settingsTextDraftProjectionIdentity(right)
      && samplingSettingsEqual(left.sampling, right.sampling);
  }
  return left.cachePolicy === right.cachePolicy
    && samplingSettingsEqual(left.sampling, right.sampling)
    && sameGenerationSettings(left.generation, right.generation);
}

/** Rebase a clean menu refresh. Preserve dirty row drafts. Require an
 * explicit overwrite when the authoritative document changes below them. */
export function reconcileSettingsOverlay(
  overlay: SettingsOverlayState,
  view: SettingsView,
  edit: ActiveSettingsEdit | null
): string | null {
  const cursorRow = settingsCursorRowIdentity(overlay);
  const nextBase = settingsTextDraftForView(view, overlay.draft.selectedProfileId);
  const baseChanged = !sameSettingsDraft(overlay.base, nextBase);
  if (!baseChanged) {
    overlay.base = nextBase;
    restoreSettingsCursor(overlay, cursorRow);
    return null;
  }
  const samplingWasOpen = overlay.sampling !== null;
  const draftWasClean = !settingsDraftChanged(overlay);
  if (!draftWasClean) {
    overlay.draft = settingsTextDraftWithMergedWriting(overlay.draft, overlay.base, nextBase);
  }
  const editAffectsServer = edit !== null && (
    edit.kind === "sampling"
    || !settingsRowIsLocal(edit.row)
  );
  const editWasClean = !editAffectsServer
    || edit.composer.text === edit.initialText();
  const activeEditBase = draftWasClean ? nextBase : overlay.draft;
  const activeDraft = editAffectsServer && !editWasClean
    ? draftWithActiveEdit(activeEditBase, edit)
    : overlay.draft;
  const converged = activeDraft !== null && sameSettingsDraft(activeDraft, nextBase);
  if (draftWasClean || converged) {
    replaceAuthoritativeSettingsDraft(
      overlay,
      nextBase,
      reconciledModelProvenance(overlay, nextBase, view)
    );
  }
  overlay.base = nextBase;

  if (edit !== null && edit.kind === "row" && isWritingPromptRow(edit.row) && editWasClean) {
    const refreshed = draftRowEditValue(overlay.draft, edit.row);
    setComposerText(edit.composer, refreshed);
    if (refreshed.length > 0) edit.composer.anchor = 0;
    edit.setInitialText(refreshed);
  } else if (edit !== null && (draftWasClean || converged) && editWasClean) {
    if (edit.kind === "sampling") {
      edit.close();
    } else if (settingsDraftTextRow(edit.row)) {
      const refreshed = draftRowEditValue(overlay.draft, edit.row);
      setComposerText(edit.composer, refreshed);
      if (refreshed.length > 0) edit.composer.anchor = 0;
      edit.setInitialText(refreshed);
    }
  }

  // The nested panel is a separate owner from its optional field buffer. A
  // clean authoritative refresh closes both owners; a dirty buffer keeps the
  // panel open so the conflict remains actionable.
  if (samplingWasOpen && (draftWasClean || converged) && editWasClean) {
    overlay.sampling = null;
  }

  restoreSettingsCursor(overlay, cursorRow);

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
  acknowledgeSavedAutomaticModels(overlay, acknowledged, acknowledgedSecrets);
  if (sameConnectionSecrets(overlay.connectionSecrets, acknowledgedSecrets)) {
    overlay.connectionSecrets = {};
  }
  const nextBase = settingsTextDraftForView(
    overlay.view,
    overlay.draft.selectedProfileId
  );
  overlay.base = nextBase;
  if (!newerDraft) {
    replaceSettingsDraft(overlay, nextBase);
  }
  overlay.conflict = null;
  return newerDraft || (
    edit !== null && edit.composer.text !== edit.initialText()
  );
}

function reconciledModelProvenance(
  overlay: SettingsOverlayState,
  next: SettingsTextDraft,
  view: SettingsView
): SettingsOverlayState["modelSelectionByProfile"] {
  return Object.fromEntries(
    Object.keys(overlay.modelSelectionByProfile).flatMap((key) => {
      const current = overlay.modelSelectionByProfile[key] ?? {};
      const profileId = overlay.draft.document === null ? null : key;
      const previousDraft = draftForProfile(overlay.draft, profileId);
      const nextDraft = draftForProfile(next, profileId);
      if (previousDraft === null || nextDraft === null) return [];
      const reconciled = {
        ...(current.automaticModel !== undefined
          && nextDraft.generation.model === current.automaticModel.remoteId
          && modelTargetIdentityForView(
            view,
            nextDraft,
            overlay.connectionSecrets
          ) === current.automaticModel.targetIdentity
          ? { automaticModel: current.automaticModel }
          : {}),
      };
      return Object.keys(reconciled).length === 0
        ? []
        : [[key, reconciled]];
    })
  );
}

function acknowledgeSavedAutomaticModels(
  overlay: SettingsOverlayState,
  acknowledged: SettingsTextDraft,
  acknowledgedSecrets: Readonly<Record<string, string | null>>
): void {
  const profileIds: readonly (string | null)[] = acknowledged.document === null
    ? [null]
    : Object.keys(acknowledged.document.profiles);
  for (const profileId of profileIds) {
    const automatic = settingsAutomaticModelSelectionForProfile(
      overlay,
      profileId
    );
    if (automatic === null) continue;
    const saved = draftForProfile(acknowledged, profileId);
    const current = draftForProfile(overlay.draft, profileId);
    if (saved === null || current === null
      || saved.generation.model !== automatic.remoteId
      || current.generation.model !== automatic.remoteId) continue;
    const currentTarget = modelTargetIdentityForView(
      overlay.view,
      current,
      overlay.connectionSecrets
    );
    if (currentTarget !== null
      && currentTarget === modelTargetIdentityForView(
        overlay.view,
        saved,
        acknowledgedSecrets
      )) {
      acknowledgeSettingsModelSelection(overlay, profileId, automatic.remoteId);
    }
  }
}

function draftForProfile(
  draft: SettingsTextDraft,
  profileId: string | null
): SettingsTextDraft | null {
  if (profileId === null) {
    return draft.selectedProfileId === null ? draft : null;
  }
  if (draft.document?.profiles[profileId] === undefined) return null;
  return settingsTextDraftForDocument(
    draft.document,
    profileId
  );
}

function modelTargetIdentityForView(
  view: SettingsView,
  draft: SettingsTextDraft,
  connectionSecrets: Readonly<Record<string, string | null>>
): string | null {
  try {
    return settingsModelTargetFingerprint(
      view,
      draft.generation,
      connectionSecrets,
      draft.document,
      draft.selectedProfileId
    );
  } catch {
    return null;
  }
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
  row: Exclude<SettingsRowId, LocalConfigRow | "allow-insecure-http" | "profile" | "sampling">
): string {
  if (isConnectionTimeoutRow(row)) return connectionTimeoutEditValueForDraft(row, draft);
  const settings = draft.generation;
  if (row === "provider") return settings.provider;
  if (row === "base-url") return settings.baseUrl;
  if (row === "model") return settings.model;
  if (row === "api-key") return "";
  if (row === "api-key-env") return settings.apiKeyEnv ?? "";
  if (row === "temperature") return settings.temperature?.toString() ?? "";
  if (row === "max-tokens") return settings.maxTokens.toString();
  if (row === "context-window") return settings.contextWindow?.toString() ?? "";
  if (isWritingPromptRow(row)) {
    return draftWriting(draft)[writingPromptFieldDefinitionForRow(row).field];
  }
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
  if (edit.kind === "sampling") {
    return edit.composer.text === edit.initialText() ? draft : null;
  }
  const row = edit.row;
  if (settingsRowIsLocal(row)) return draft;
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
  if (isWritingPromptRow(row)) {
    return settingsTextDraftWithWritingField(
      draft,
      writingPromptFieldDefinitionForRow(row).field,
      edit.composer.text
    );
  }
  if (isConnectionTimeoutRow(row)) {
    return draftWithConnectionTimeoutEditText(draft, row, edit.composer.text);
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
  LocalConfigRow | "allow-insecure-http" | "profile" | "sampling"
> {
  return !settingsRowIsLocal(row)
    && row !== "allow-insecure-http"
    && row !== "profile"
    && row !== "sampling";
}

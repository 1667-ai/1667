import { isSubscriptionPresetV2, type SettingsPresetV2 } from "../../../shared/settings-v2-types.js";
import {
  selectableSettingsProviderChoices,
  settingsProviderChoice,
  type SettingsProviderChoice
} from "../../../shared/settings-provider-choices.js";
import type { ProviderProbeTarget } from "../../../shared/provider-probe-route-v1.js";
import { settingsModelTargetFingerprint, settingsProviderProbeTarget } from "../../../shared/settings-provider-probe.js";
import type { SettingsDocumentV5 } from "../../../shared/settings-v5-types.js";
import { settingsDraftContextWindowIsManual } from "../../../shared/settings-save-document.js";
import { isolateSettingsProfileModel } from "../../../shared/settings-profile-draft.js";
import {
  applyStoredApiKeyEdit,
  discardUnreferencedConnectionSecretWrites,
  hasStoredApiKey,
  rekeyPendingStoredSecret,
  type SettingsSecretSidecarState
} from "../../../shared/settings-secret-sidecar.js";
import { settingsScalar, scalarInvalidReason, typedScalarValue } from "../../../shared/settings-scalar.js";
import { resolveSettingsProfile } from "../../../shared/settings-route.js";
import { storedCredentialSecretId } from "../../../shared/settings-stored-credential.js";
import {
  settingsTextDraftProjectionIdentity,
  settingsTextDraftWithDetectedContext,
  settingsTextDraftWithGeneration,
  settingsTextDraftWithSubscriptionPlan,
  settingsTextDraftWithTextPreset,
  type SettingsTextDraft
} from "../../../shared/settings-text-draft.js";
import {
  draftWriting,
  settingsTextDraftWithWritingField,
  validateWritingPromptValue
} from "../../../shared/settings-writing-draft.js";
import {
  WRITING_PROMPT_FIELD_IDS,
  writingPromptFieldDefinition,
  type WritingPromptFieldId
} from "../../../shared/settings-v5-writing.js";
import type { GenerationSettings } from "../../../shared/types.js";
import type { LoadedSettings } from "./state.js";

/** The draft and the key material that goes with it: what every edit changes. */
export interface SettingsEdit {
  readonly draft: SettingsTextDraft;
  readonly secrets: Readonly<Record<string, string | null>>;
}

export type EditResult =
  | { readonly edit: SettingsEdit }
  | { readonly error: string };

/** The provider choices the picker lists, in the TUI's order. */
export const PROVIDER_CHOICES = selectableSettingsProviderChoices();

export function selectedPreset(draft: SettingsTextDraft): SettingsPresetV2 | undefined {
  if (draft.document === null || draft.selectedProfileId === null) return undefined;
  try {
    return resolveSettingsProfile(draft.document, draft.selectedProfileId).connection.preset;
  } catch {
    return undefined;
  }
}

export function currentProviderChoice(draft: SettingsTextDraft): SettingsProviderChoice {
  return settingsProviderChoice(draft.generation, selectedPreset(draft));
}

/** The fixed plan connections have no URL and no key, so those rows go away. */
export function isSubscriptionDraft(draft: SettingsTextDraft): boolean {
  const preset = selectedPreset(draft);
  return preset !== undefined && isSubscriptionPresetV2(preset);
}

function withSidecar(edit: SettingsEdit, change: (state: SettingsSecretSidecarState) => string | null): EditResult {
  const state: SettingsSecretSidecarState = { draft: edit.draft, secrets: edit.secrets };
  const error = change(state);
  return error === null ? { edit: { draft: state.draft, secrets: state.secrets } } : { error };
}

/** Port of the terminal's provider cycle: the choice's defaults replace the
 * connection, a pending key follows the connection, and a key that is no
 * longer used is dropped. */
export function applyProviderChoice(edit: SettingsEdit, choice: SettingsProviderChoice): SettingsEdit {
  const result = withSidecar(edit, (state) => {
    const preserveStoredApiKey = hasStoredApiKey(state);
    const generation: GenerationSettings = {
      ...state.draft.generation,
      provider: choice.provider,
      ...choice.defaults,
      ...(preserveStoredApiKey ? { apiKeyEnv: null } : {})
    };
    state.draft = choice.id === "chatgpt-plan" || choice.id === "claude-plan"
      ? settingsTextDraftWithSubscriptionPlan(state.draft, choice.id, generation)
      : settingsTextDraftWithGeneration(state.draft, generation);
    const textPreset = choice.id === "llama-cpp-text" ? "llama-cpp"
      : choice.id === "koboldcpp-text" ? "koboldcpp"
        : choice.id === "text-completion" ? "custom" : null;
    if (textPreset !== null) state.draft = settingsTextDraftWithTextPreset(state.draft, textPreset);
    rekeyPendingStoredSecret(state);
    discardUnreferencedConnectionSecretWrites(state);
    return null;
  });
  return "edit" in result ? result.edit : edit;
}

export function applyBaseUrl(edit: SettingsEdit, text: string): SettingsEdit {
  const generation = edit.draft.generation;
  const baseUrl = text.trim();
  if (baseUrl === generation.baseUrl) return edit;
  return {
    ...edit,
    draft: settingsTextDraftWithGeneration(edit.draft, { ...generation, baseUrl, contextWindow: null })
  };
}

export function applyAllowInsecureHttp(edit: SettingsEdit, on: boolean): SettingsEdit {
  const generation = { ...edit.draft.generation };
  if ((generation.allowInsecureHttp === true) === on) return edit;
  if (on) generation.allowInsecureHttp = true;
  else delete generation.allowInsecureHttp;
  return { ...edit, draft: settingsTextDraftWithGeneration(edit.draft, generation) };
}

/** A model the writer typed or picked. A different model starts without the
 * context size of the old one; `contextWindow` is what the provider listed. */
export function applyModel(edit: SettingsEdit, remoteId: string, contextWindow: number | null = null): SettingsEdit {
  const generation = edit.draft.generation;
  if (remoteId === generation.model) return edit;
  let draft = settingsTextDraftWithGeneration(edit.draft, { ...generation, model: remoteId, contextWindow: null });
  if (contextWindow !== null) draft = settingsTextDraftWithDetectedContext(draft, contextWindow);
  return { ...edit, draft };
}

export function applyDetectedContext(edit: SettingsEdit, contextWindow: number): SettingsEdit {
  return { ...edit, draft: settingsTextDraftWithDetectedContext(edit.draft, contextWindow) };
}

/** The context size as typed: empty means "auto", anything else must be a
 * whole number the shared scalar rules accept. */
export function applyContextText(edit: SettingsEdit, text: string): EditResult {
  const scalar = settingsScalar("context-window", edit.draft.generation);
  const typed = typedScalarValue(scalar, text);
  if ("refused" in typed) return { error: typed.refused };
  const reason = scalarInvalidReason(typed.scalar);
  if (reason !== null) return { error: reason };
  const value = typed.scalar.value;
  const generation = edit.draft.generation;
  if (value === generation.contextWindow) return { edit };
  const draft = edit.draft;
  if (value === null || draft.document === null || draft.selectedProfileId === null) {
    return { edit: { ...edit, draft: settingsTextDraftWithGeneration(draft, { ...generation, contextWindow: value }) } };
  }
  const isolated = { ...draft, document: isolateSettingsProfileModel(draft.document, draft.selectedProfileId) };
  return {
    edit: { ...edit, draft: settingsTextDraftWithGeneration(isolated, { ...generation, contextWindow: value }, true) }
  };
}

/** A typed key goes to the sidecar under a fresh secret id; empty removes it. */
export function applyApiKey(edit: SettingsEdit, value: string): EditResult {
  return withSidecar(edit, (state) => applyStoredApiKeyEdit(state, value));
}

export function applyWritingText(edit: SettingsEdit, field: WritingPromptFieldId, text: string): EditResult {
  const reason = validateWritingPromptValue(writingPromptFieldDefinition(field), text, draftWriting(edit.draft));
  if (reason !== null) return { error: reason };
  return { edit: { ...edit, draft: settingsTextDraftWithWritingField(edit.draft, field, text) } };
}

export type KeyStatus =
  | { readonly kind: "none" }
  | { readonly kind: "stored" }
  | { readonly kind: "pending" }
  | { readonly kind: "env"; readonly name: string };

/** What the key row says. It never carries a key, or anything that would
 * tell a key's length. */
export function keyStatus(edit: SettingsEdit): KeyStatus {
  const { draft } = edit;
  if (draft.generation.apiKeyEnv !== null) return { kind: "env", name: draft.generation.apiKeyEnv };
  if (draft.document === null || draft.selectedProfileId === null) return { kind: "none" };
  const secretId = storedCredentialSecretId(resolveSettingsProfile(draft.document, draft.selectedProfileId).connection.auth);
  if (secretId === null) return { kind: "none" };
  return typeof edit.secrets[secretId] === "string" ? { kind: "pending" } : { kind: "stored" };
}

/** The draft's document as a probe may read it. A model the writer has not
 * named yet (a new provider, no model chosen) has an empty name in the draft;
 * the server refuses that, and the probe is how the writer finds the name. */
function probeDocument(draft: SettingsTextDraft): SettingsDocumentV5 | null {
  const document = draft.document;
  if (document === null) return null;
  const models = Object.fromEntries(Object.entries(document.models).map(([id, model]) => [
    id,
    model.name.trim().length > 0 ? model : { ...model, name: model.remoteId.length > 0 ? model.remoteId : "Model" }
  ]));
  return { ...document, models };
}

/** What a model list, a check, and a context probe send to the server. A key
 * that is typed but not saved goes along, so a provider that needs one can
 * answer before the save. */
export function probeTargetFor(loaded: LoadedSettings): ProviderProbeTarget {
  return settingsProviderProbeTarget(
    loaded.view,
    loaded.draft.generation,
    loaded.secrets,
    probeDocument(loaded.draft),
    loaded.draft.selectedProfileId
  );
}

/** The connection target a model list and a check belong to. */
export function targetIdentity(loaded: LoadedSettings): string {
  try {
    return settingsModelTargetFingerprint(
      loaded.view,
      loaded.draft.generation,
      loaded.secrets,
      probeDocument(loaded.draft),
      loaded.draft.selectedProfileId
    );
  } catch {
    return JSON.stringify(["invalid", loaded.draft.generation.provider, loaded.draft.generation.baseUrl]);
  }
}

export function draftsEqual(left: SettingsTextDraft, right: SettingsTextDraft): boolean {
  if (left.document === null || right.document === null) {
    return left.document === right.document
      && JSON.stringify(left.generation) === JSON.stringify(right.generation);
  }
  return JSON.stringify(left.document) === JSON.stringify(right.document)
    && settingsTextDraftProjectionIdentity(left) === settingsTextDraftProjectionIdentity(right);
}

/** Refused text of a field that is not a key. It exists only in `invalid`, so
 * it counts as an unsaved change: leaving or reloading must keep it. */
function refusedFieldText(loaded: LoadedSettings): string[] {
  return Object.entries(loaded.invalid).filter(([key]) => key !== "api-key").map(([key]) => key);
}

export function isDirty(loaded: LoadedSettings): boolean {
  return loaded.view.editable
    && (Object.keys(loaded.secrets).length > 0 || refusedFieldText(loaded).length > 0
      || !draftsEqual(loaded.draft, loaded.base));
}

export function invalidCount(loaded: LoadedSettings): number {
  return Object.keys(loaded.invalid).length;
}

/** "N changes": one per row that differs from what is saved. */
export function changeCount(loaded: LoadedSettings): number {
  if (!isDirty(loaded)) return 0;
  const draft = loaded.draft;
  const base = loaded.base;
  let count = 0;
  if (currentProviderChoice(draft).id !== currentProviderChoice(base).id) count += 1;
  if (draft.generation.baseUrl !== base.generation.baseUrl) count += 1;
  if (Object.keys(loaded.secrets).length > 0) count += 1;
  if (draft.generation.model !== base.generation.model) count += 1;
  if (draft.generation.contextWindow !== base.generation.contextWindow) count += 1;
  if (draft.document !== null && base.document !== null) {
    for (const field of WRITING_PROMPT_FIELD_IDS) {
      if (draft.document.writing[field] !== base.document.writing[field]) count += 1;
    }
  }
  return Math.max(count, 1);
}

/** The prompt text the writer changed, for the Copy button of the unsaved
 * bar. Prompts only: nothing here can hold a key. */
export function changedPromptText(loaded: LoadedSettings): string {
  const draft = loaded.draft;
  const base = loaded.base;
  if (draft.document === null || base.document === null) return "";
  const parts: string[] = [];
  for (const field of WRITING_PROMPT_FIELD_IDS) {
    // Refused text is the writer's latest; it never reached the draft.
    const text = loaded.invalid[field]?.text ?? draft.document.writing[field];
    if (text === base.document.writing[field]) continue;
    parts.push(`${writingPromptFieldDefinition(field).title}:\n${text}`);
  }
  return parts.join("\n\n");
}

export function canDiscoverModels(draft: SettingsTextDraft): boolean {
  if (isSubscriptionDraft(draft)) return true;
  if (draft.generation.provider === "dry-run") return false;
  try {
    const protocol = new URL(draft.generation.baseUrl).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function contextIsManual(draft: SettingsTextDraft): boolean {
  return settingsDraftContextWindowIsManual(draft);
}

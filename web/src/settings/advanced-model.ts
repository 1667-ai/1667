import {
  PROMPT_CACHE_POLICY_V2_VALUES,
  type GenerationEffortV2,
  type PromptCachePolicyV2,
  type ReasoningDisplayV2,
  type SettingsRoutePurpose,
  type TextPromptFormatV2
} from "../../../shared/settings-v2-types.js";
import { withSettingsProfileEffort } from "../../../shared/settings-document-update.js";
import {
  createSettingsProfile,
  deleteSettingsProfile,
  duplicateSettingsProfile,
  renameSettingsProfile,
  settingsProfileIds
} from "../../../shared/settings-profile-draft.js";
import { discardUnreferencedConnectionSecretWrites } from "../../../shared/settings-secret-sidecar.js";
import { settingsScalar, scalarInvalidReason, typedScalarValue } from "../../../shared/settings-scalar.js";
import {
  settingsTextDraftForDocument,
  settingsTextDraftWithCachePolicy,
  settingsTextDraftWithGeneration,
  type SettingsTextDraft
} from "../../../shared/settings-text-draft.js";
import {
  draftWithConnectionTimeoutText,
  draftWithProfile,
  draftWithSplitThinkTags,
  draftWithTextPromptFormat,
  profileWithContinuationPromptOptimization,
  profileWithKeepThoughts,
  profileWithReasoning,
  profileWithTokenProbabilities,
  type ConnectionTimeoutRow
} from "../../../shared/settings-profile-fields.js";
import { updateSettingsDocumentV5 } from "../../../shared/settings-document-update.js";
import type { EditResult, SettingsEdit } from "./model.js";

/** The edits the advanced view makes. Each takes the draft and its keys and
 * returns the next pair, or the reason the value is refused. The rules are the
 * shared ones the terminal uses (`shared/settings-profile-fields.ts`,
 * `shared/settings-profile-draft.ts`). */

function withDraft(edit: SettingsEdit, draft: SettingsTextDraft | null): SettingsEdit {
  return draft === null ? edit : { ...edit, draft };
}

export function profileNames(draft: SettingsTextDraft): readonly { readonly id: string; readonly name: string }[] {
  const document = draft.document;
  return document === null
    ? []
    : settingsProfileIds(document).map((id) => ({ id, name: document.profiles[id]!.name }));
}

export function applyProfileSelect(edit: SettingsEdit, profileId: string): SettingsEdit {
  const document = edit.draft.document;
  if (document === null || document.profiles[profileId] === undefined || edit.draft.selectedProfileId === profileId) {
    return edit;
  }
  return { ...edit, draft: settingsTextDraftForDocument(document, profileId) };
}

export function applyProfileCreate(edit: SettingsEdit, duplicate: boolean): EditResult {
  const { document, selectedProfileId } = edit.draft;
  if (document === null || selectedProfileId === null) return { error: "These settings are read-only." };
  const created = duplicate
    ? duplicateSettingsProfile(document, selectedProfileId)
    : createSettingsProfile(document, selectedProfileId);
  if ("error" in created) return { error: created.error };
  return { edit: { ...edit, draft: settingsTextDraftForDocument(created.document, created.profileId) } };
}

export function applyProfileDelete(edit: SettingsEdit): EditResult {
  const { document, selectedProfileId } = edit.draft;
  if (document === null || selectedProfileId === null) return { error: "These settings are read-only." };
  const deleted = deleteSettingsProfile(document, selectedProfileId);
  if ("error" in deleted) return { error: deleted.error };
  const state = { draft: settingsTextDraftForDocument(deleted.document, deleted.profileId), secrets: { ...edit.secrets } };
  discardUnreferencedConnectionSecretWrites(state);
  return { edit: { draft: state.draft, secrets: state.secrets } };
}

export function applyProfileRename(edit: SettingsEdit, name: string): EditResult {
  const { document, selectedProfileId } = edit.draft;
  if (document === null || selectedProfileId === null) return { error: "These settings are read-only." };
  const renamed = renameSettingsProfile(document, selectedProfileId, name);
  if ("error" in renamed) return { error: renamed.error };
  return { edit: { ...edit, draft: settingsTextDraftForDocument(renamed, selectedProfileId) } };
}

/** `null` makes the prose or utility route follow the default. */
export function applyRoute(edit: SettingsEdit, purpose: SettingsRoutePurpose, profileId: string | null): SettingsEdit {
  const document = edit.draft.document;
  if (document === null || edit.draft.selectedProfileId === null) return edit;
  let routing = { ...document.routing };
  if (purpose === "default") {
    if (profileId === null || document.profiles[profileId] === undefined || routing.default === profileId) return edit;
    routing = { ...routing, default: profileId };
  } else if (profileId === null) {
    if (routing[purpose] === undefined) return edit;
    delete routing[purpose];
  } else {
    if (document.profiles[profileId] === undefined || routing[purpose] === profileId) return edit;
    routing = { ...routing, [purpose]: profileId };
  }
  return {
    ...edit,
    draft: settingsTextDraftForDocument(updateSettingsDocumentV5(document, { routing }), edit.draft.selectedProfileId)
  };
}

/** Temperature or max tokens as typed. Empty temperature means the default. */
export function applyGenerationScalarText(edit: SettingsEdit, row: "temperature" | "max-tokens", text: string): EditResult {
  const generation = edit.draft.generation;
  const typed = typedScalarValue(settingsScalar(row, generation), text);
  if ("refused" in typed) return { error: typed.refused };
  const reason = scalarInvalidReason(typed.scalar);
  if (reason !== null) return { error: reason };
  const value = typed.scalar.value;
  if (row === "temperature") {
    if (value === generation.temperature) return { edit };
    return { edit: withDraft(edit, settingsTextDraftWithGeneration(edit.draft, { ...generation, temperature: value })) };
  }
  if (value === null) return { error: "this row needs a number" };
  if (value === generation.maxTokens) return { edit };
  return { edit: withDraft(edit, settingsTextDraftWithGeneration(edit.draft, { ...generation, maxTokens: value })) };
}

export function applyEffortChoice(edit: SettingsEdit, effort: GenerationEffortV2): SettingsEdit {
  return withDraft(edit, draftWithProfile(edit.draft, (profile) => withSettingsProfileEffort(profile, effort)));
}

export function applyCachePolicyChoice(edit: SettingsEdit, policy: PromptCachePolicyV2): SettingsEdit {
  if (!PROMPT_CACHE_POLICY_V2_VALUES.includes(policy) || edit.draft.cachePolicy === policy) return edit;
  return withDraft(edit, settingsTextDraftWithCachePolicy(edit.draft, policy));
}

export function applyPromptLayout(edit: SettingsEdit, on: boolean): SettingsEdit {
  return withDraft(edit, draftWithProfile(edit.draft, (profile) => (
    profileWithContinuationPromptOptimization(profile, on ? "late-cache-stable" : null)
  )));
}

export function applyReasoningDisplay(edit: SettingsEdit, display: ReasoningDisplayV2): SettingsEdit {
  return withDraft(edit, draftWithProfile(edit.draft, (profile) => profileWithReasoning(profile, display)));
}

export function applyKeepThoughts(edit: SettingsEdit, keep: boolean): SettingsEdit {
  return withDraft(edit, draftWithProfile(edit.draft, (profile) => profileWithKeepThoughts(profile, keep)));
}

export function applyTokenProbabilities(edit: SettingsEdit, count: number | null): SettingsEdit {
  return withDraft(edit, draftWithProfile(edit.draft, (profile) => profileWithTokenProbabilities(profile, count)));
}

export function applyTextPromptFormat(edit: SettingsEdit, format: TextPromptFormatV2): SettingsEdit {
  return withDraft(edit, draftWithTextPromptFormat(edit.draft, format));
}

export function applySplitThinkTags(edit: SettingsEdit, on: boolean): SettingsEdit {
  return withDraft(edit, draftWithSplitThinkTags(edit.draft, on));
}

export function applyTimeoutText(edit: SettingsEdit, row: ConnectionTimeoutRow, text: string): EditResult {
  const result = draftWithConnectionTimeoutText(edit.draft, row, text);
  return "error" in result ? result : { edit: { ...edit, draft: result.draft } };
}

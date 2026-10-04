import {
  applyBasicModelDiscovery,
  applyBasicSettingsDraft
} from "./settings-basic-draft.js";
import { promptCacheContextForProfile, promptCachePolicyPresentation } from "./prompt-cache-capabilities.js";
import {
  applySamplingSettings,
  resolveConfiguredSamplingKnobs,
  samplingContextForRoute,
  samplingKnobLabel,
  samplingUnavailableReasonCompact
} from "./sampling-capabilities.js";
import { resolveSettingsProfile } from "./settings-route.js";
import { EMPTY_SAMPLING_V2 } from "./settings-v2-types.js";
import type { ModelDiscoveryResultV2 } from "./settings-v2-types.js";
import type { SettingsDocumentV5 } from "./settings-v5-types.js";
import { isolateSettingsProfileModel } from "./settings-profile-draft.js";
import type { SettingsTextDraft } from "./settings-text-draft.js";
import { WRITING_PROMPT_FIELD_DEFINITIONS } from "./settings-v5-writing.js";
import { draftWriting, validateWritingPromptValue } from "./settings-writing-draft.js";

/** True when the draft's context window is a value the writer set, not one the
 * server detected. */
export function settingsDraftContextWindowIsManual(draft: SettingsTextDraft): boolean {
  const document = draft.document;
  const profileId = draft.selectedProfileId;
  if (document === null || profileId === null
    || draft.generation.contextWindow === null) return false;
  return resolveSettingsProfile(document, profileId).model.overrides.contextWindow
    === draft.generation.contextWindow;
}

/** Build the document a save sends: basic draft, model discovery, sampling,
 * availability checks, then prompt checks. Throws an `Error` whose message is
 * safe to show when the draft cannot be saved. `discovery` is the model list
 * that was taken for the draft's current connection, or null. */
export function buildSettingsSaveDocument(
  draft: SettingsTextDraft,
  discovery: ModelDiscoveryResultV2 | null
): SettingsDocumentV5 {
  if (draft.document === null || draft.selectedProfileId === null) {
    throw new Error("Editable settings document is unavailable");
  }
  const writing = draftWriting(draft);
  for (const definition of WRITING_PROMPT_FIELD_DEFINITIONS) {
    const writingError = validateWritingPromptValue(
      definition,
      writing[definition.field],
      writing
    );
    if (writingError !== null) throw new Error(writingError);
  }
  const savedDocument = applyBasicSettingsDraft(
    draft.document as never,
    draft.generation,
    draft.selectedProfileId,
    settingsDraftContextWindowIsManual(draft)
  ) as unknown as SettingsDocumentV5;
  const selectedRemoteId = resolveSettingsProfile(
    savedDocument,
    draft.selectedProfileId
  ).model.remoteId;
  const discoveryMatchesSelectedModel = discovery?.models.some(
    (model) => model.remoteId === selectedRemoteId
  ) === true;
  let document = applyBasicModelDiscovery(
    (discoveryMatchesSelectedModel
      ? isolateSettingsProfileModel(savedDocument, draft.selectedProfileId)
      : savedDocument) as never,
    discovery,
    draft.generation.contextWindow,
    draft.selectedProfileId,
    settingsDraftContextWindowIsManual(draft)
  ) as unknown as SettingsDocumentV5;
  document = applySamplingSettings(
    document as unknown as never,
    draft.sampling,
    draft.selectedProfileId
  ) as unknown as SettingsDocumentV5;
  assertSamplingDraftAvailable(document, draft.selectedProfileId);
  const cacheContext = promptCacheContextForProfile(document, draft.selectedProfileId);
  const presentation = promptCachePolicyPresentation(cacheContext, draft.cachePolicy);
  if (!presentation.available) {
    throw new Error(presentation.unavailableReason);
  }
  return document;
}

function assertSamplingDraftAvailable(document: SettingsDocumentV5, profileId: string): void {
  const route = resolveSettingsProfile(document, profileId);
  const context = samplingContextForRoute(route as never);
  const sampling = route.profile.sampling ?? EMPTY_SAMPLING_V2;
  for (const { knob, resolution } of resolveConfiguredSamplingKnobs(context, sampling)) {
    if (resolution.kind === "unavailable") {
      throw new Error(
        `${samplingKnobLabel(knob)} is unavailable · ${samplingUnavailableReasonCompact(resolution.reason)}`
      );
    }
  }
}

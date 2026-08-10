import { resolveSettingsProfile } from "../../shared/settings-route.js";
import type { DiscoveredModelV2 } from "../../shared/settings-v2-types.js";
import { isolateSettingsProfileModel } from "./settings-profile-draft.js";
import { settingsModelTargetFingerprint } from "./settings-provider-probe.js";
import {
  settingsTextDraftWithDetectedContext,
  settingsTextDraftWithGeneration,
  type SettingsTextDraft
} from "./settings-text.js";
import type {
  SettingsModelSelectionByProfile,
  SettingsOverlayState,
  SettingsProfileModelSelection
} from "./state.js";

export type SettingsModelChoiceOrigin =
  | { kind: "automatic"; targetIdentity: string }
  | { kind: "manual" }
  | { kind: "typed" };

/** Replace an unrelated draft value without bypassing selection ownership. */
export function replaceSettingsDraft(
  overlay: SettingsOverlayState,
  next: SettingsTextDraft
): void {
  updateDraft(overlay, next);
}

/** Apply a provider preset. Its model default is an explicit candidate. */
export function replaceSettingsProviderDraft(
  overlay: SettingsOverlayState,
  next: SettingsTextDraft
): void {
  updateDraft(overlay, next, true);
}

/** Apply manual context ownership and isolate a shared model first. */
export function applySettingsManualContextDraft(
  overlay: SettingsOverlayState,
  generation: SettingsTextDraft["generation"]
): void {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  const isolated = document === null || profileId === null
    ? overlay.draft
    : {
        ...overlay.draft,
        document: isolateSettingsProfileModel(document, profileId)
      };
  const next = generation.contextWindow === null
    ? settingsTextDraftWithGeneration(overlay.draft, generation)
    : settingsTextDraftWithGeneration(isolated, generation, true);
  updateDraft(overlay, next);
}

/** Atomically update the draft and automatic-selection ownership. */
export function applySettingsModelChoiceDraft(
  overlay: SettingsOverlayState,
  model: Pick<DiscoveredModelV2, "remoteId" | "contextWindow">,
  contextWindow: number | null = model.contextWindow,
  origin: SettingsModelChoiceOrigin = { kind: "manual" }
): void {
  const manualContext = (origin.kind === "automatic"
      || model.remoteId === overlay.draft.generation.model)
    && settingsContextWindowIsManual(overlay);
  const selectedContext = manualContext
    ? overlay.draft.generation.contextWindow
    : contextWindow;
  let next = overlay.draft;
  if (model.remoteId !== overlay.draft.generation.model
    || selectedContext !== overlay.draft.generation.contextWindow) {
    next = settingsTextDraftWithGeneration(overlay.draft, {
      ...overlay.draft.generation,
      model: model.remoteId,
      contextWindow: manualContext ? overlay.draft.generation.contextWindow : null
    }, manualContext);
    if (!manualContext && contextWindow !== null) {
      next = settingsTextDraftWithDetectedContext(next, contextWindow);
    }
  }
  const key = settingsModelSelectionKey(next.selectedProfileId);
  let provenance = pruneRemovedProfiles(overlay.modelSelectionByProfile, next);
  if (settingsDraftTargetChanged(overlay, next)) {
    ({ next, provenance } = withoutStaleAutomaticSelection(
      overlay,
      next,
      provenance
    ));
  }
  const selected = { ...provenance[key] };
  if (origin.kind === "automatic") {
    selected.automaticModel = {
      remoteId: next.generation.model,
      targetIdentity: origin.targetIdentity
    };
  } else {
    delete selected.automaticModel;
  }
  commitSettingsDraft(
    overlay,
    next,
    withProfileProvenance(provenance, key, selected)
  );
}

export function clearSettingsModelChoiceDraft(
  overlay: SettingsOverlayState
): void {
  const manualContext = settingsContextWindowIsManual(overlay);
  applySettingsModelChoiceDraft(overlay, {
    remoteId: "",
    contextWindow: manualContext ? overlay.draft.generation.contextWindow : null
  });
}

export function replaceAuthoritativeSettingsDraft(
  overlay: SettingsOverlayState,
  next: SettingsTextDraft,
  modelSelectionByProfile: SettingsModelSelectionByProfile
): void {
  commitSettingsDraft(overlay, next, modelSelectionByProfile);
}

export function cloneSettingsProfileDraft(
  overlay: SettingsOverlayState,
  next: SettingsTextDraft,
  sourceProfileId: string
): void {
  cloneProfileDraft(overlay, next, sourceProfileId);
}

function updateDraft(
  overlay: SettingsOverlayState,
  candidate: SettingsTextDraft,
  candidateModelIsExplicit = false
): void {
  let next = candidate;
  let provenance = pruneRemovedProfiles(overlay.modelSelectionByProfile, next);
  if (next.selectedProfileId === overlay.draft.selectedProfileId) {
    if (settingsDraftTargetChanged(overlay, next)) {
      ({ next, provenance } = withoutStaleAutomaticSelection(
        overlay,
        next,
        provenance,
        candidateModelIsExplicit
      ));
    } else if (next.generation.model !== overlay.draft.generation.model) {
      provenance = withoutAutomaticSelection(
        provenance,
        next.selectedProfileId
      );
    }
  }
  commitSettingsDraft(overlay, next, provenance);
}

function cloneProfileDraft(
  overlay: SettingsOverlayState,
  next: SettingsTextDraft,
  sourceProfileId: string
): void {
  let provenance = pruneRemovedProfiles(overlay.modelSelectionByProfile, next);
  const source = profileProvenance(provenance, sourceProfileId);
  if (source?.automaticModel?.remoteId === next.generation.model) {
    provenance = withProfileProvenance(
      provenance,
      settingsModelSelectionKey(next.selectedProfileId),
      { automaticModel: source.automaticModel }
    );
  }
  commitSettingsDraft(overlay, next, provenance);
}

export function settingsAutomaticModelSelection(
  overlay: SettingsOverlayState
): NonNullable<SettingsProfileModelSelection["automaticModel"]> | null {
  const selection = settingsAutomaticModelSelectionForProfile(
    overlay,
    overlay.draft.selectedProfileId
  );
  return selection?.remoteId === overlay.draft.generation.model
    ? selection
    : null;
}

export function settingsAutomaticModelSelectionForProfile(
  overlay: SettingsOverlayState,
  profileId: string | null
): NonNullable<SettingsProfileModelSelection["automaticModel"]> | null {
  return profileProvenance(overlay.modelSelectionByProfile, profileId)?.automaticModel ?? null;
}

export function settingsContextWindowIsManual(
  overlay: SettingsOverlayState
): boolean {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null
    || overlay.draft.generation.contextWindow === null) return false;
  return resolveSettingsProfile(document, profileId).model.overrides.contextWindow
    === overlay.draft.generation.contextWindow;
}

export function settingsHasAutomaticModelSelections(
  overlay: SettingsOverlayState
): boolean {
  return Object.values(overlay.modelSelectionByProfile).some(
    ({ automaticModel }) => automaticModel !== undefined
  );
}

export function acknowledgeSettingsModelSelection(
  overlay: SettingsOverlayState,
  profileId: string | null,
  model: string
): void {
  const key = settingsModelSelectionKey(profileId);
  const selected = overlay.modelSelectionByProfile[key];
  if (selected?.automaticModel?.remoteId !== model) return;
  overlay.modelSelectionByProfile = withoutAutomaticSelection(
    overlay.modelSelectionByProfile,
    profileId
  );
}

export function acknowledgeAllSettingsModelSelections(
  overlay: SettingsOverlayState
): void {
  overlay.modelSelectionByProfile = {};
}

function withoutStaleAutomaticSelection(
  overlay: SettingsOverlayState,
  candidate: SettingsTextDraft,
  provenance: SettingsModelSelectionByProfile,
  candidateModelIsExplicit = false
): { next: SettingsTextDraft; provenance: SettingsModelSelectionByProfile } {
  const key = settingsModelSelectionKey(candidate.selectedProfileId);
  const automatic = provenance[key]?.automaticModel;
  const withoutAutomatic = withoutAutomaticSelection(
    provenance,
    candidate.selectedProfileId
  );
  if (automatic?.remoteId !== overlay.draft.generation.model
    || candidateModelIsExplicit
    || candidate.generation.model !== overlay.draft.generation.model) {
    return { next: candidate, provenance: withoutAutomatic };
  }
  const manualContext = settingsContextWindowIsManual(overlay);
  return {
    next: settingsTextDraftWithGeneration(candidate, {
      ...candidate.generation,
      model: "",
      contextWindow: manualContext
        ? overlay.draft.generation.contextWindow
        : null
    }, manualContext),
    provenance: withoutAutomatic
  };
}

function withoutAutomaticSelection(
  current: SettingsModelSelectionByProfile,
  profileId: string | null
): SettingsModelSelectionByProfile {
  const key = settingsModelSelectionKey(profileId);
  const next = { ...current };
  delete next[key];
  return next;
}

function settingsModelSelectionKey(profileId: string | null): string {
  return profileId ?? "legacy";
}

function profileProvenance(
  provenance: SettingsModelSelectionByProfile,
  profileId: string | null
): SettingsProfileModelSelection | undefined {
  return provenance[settingsModelSelectionKey(profileId)];
}

function withProfileProvenance(
  current: SettingsModelSelectionByProfile,
  key: string,
  provenance: SettingsProfileModelSelection
): SettingsModelSelectionByProfile {
  return { ...current, [key]: provenance };
}

function pruneRemovedProfiles(
  current: SettingsModelSelectionByProfile,
  next: SettingsTextDraft
): SettingsModelSelectionByProfile {
  if (next.document === null) return current;
  const keep = new Set(Object.keys(next.document.profiles));
  return Object.fromEntries(
    Object.entries(current).filter(([key]) => keep.has(key))
  );
}

function commitSettingsDraft(
  overlay: SettingsOverlayState,
  next: SettingsTextDraft,
  provenance: SettingsModelSelectionByProfile
): void {
  overlay.modelSelectionByProfile = provenance;
  overlay.draft = next;
}

function settingsDraftTargetChanged(
  overlay: SettingsOverlayState,
  next: SettingsTextDraft
): boolean {
  return settingsDraftTargetIdentity(overlay, overlay.draft)
    !== settingsDraftTargetIdentity(overlay, next);
}

function settingsDraftTargetIdentity(
  overlay: SettingsOverlayState,
  draft: SettingsTextDraft
): string {
  try {
    return settingsModelTargetFingerprint(
      overlay.view,
      draft.generation,
      overlay.connectionSecrets,
      draft.document,
      draft.selectedProfileId
    );
  } catch {
    return JSON.stringify([
      draft.selectedProfileId,
      draft.generation.provider,
      draft.generation.baseUrl,
      draft.generation.apiKeyEnv,
      draft.generation.allowInsecureHttp === true,
      draft.document
    ]);
  }
}

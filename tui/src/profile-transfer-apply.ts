import {
  fitProfileToRoute,
  type FittedProfileTransfer,
  type ProfileTransferFitOptions,
  type ProfileTransferCandidate
} from "../../shared/generation-profile-transfer.js";
import type { SettingsDocumentV2 } from "../../shared/settings-v2-types.js";
import {
  duplicateSettingsProfile,
  renameSettingsProfile,
  uniqueSettingsProfileName
} from "./settings-profile-draft.js";

/** Duplicate a selected profile, choose a unique imported name, then fit it. */
export function applyProfileTransfer(
  document: SettingsDocumentV2,
  sourceProfileId: string,
  candidate: ProfileTransferCandidate,
  options: ProfileTransferFitOptions = {}
): FittedProfileTransfer | { readonly error: string } {
  const name = uniqueSettingsProfileName(document, candidate.name);
  const duplicate = duplicateSettingsProfile(document, sourceProfileId);
  if ("error" in duplicate) return duplicate;
  const renamed = renameSettingsProfile(duplicate.document, duplicate.profileId, name);
  if ("error" in renamed) return renamed;
  return fitProfileToRoute(renamed, duplicate.profileId, { ...candidate, name }, options);
}

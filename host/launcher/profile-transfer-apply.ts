import {
  fitProfileToRoute,
  type FittedProfileTransfer,
  type ProfileTransferFitOptions,
  type ProfileTransferCandidate
} from "../../shared/generation-profile-transfer.js";
import type { SettingsDocumentV5 as SettingsDocumentV2 } from "../../shared/settings-v5-types.js";
import {
  duplicateSettingsProfile,
  renameImportedSettingsProfile,
  uniqueSettingsProfileName
} from "./settings-profile-draft.js";

/** Duplicate a selected profile, choose a unique imported name, then fit it. */
export function applyProfileTransfer(
  document: SettingsDocumentV2,
  sourceProfileId: string,
  candidate: ProfileTransferCandidate,
  options: ProfileTransferFitOptions = {}
): FittedProfileTransfer | { readonly error: string } {
  const name = uniqueSettingsProfileName(document as never, candidate.name);
  const duplicate = duplicateSettingsProfile(document as never, sourceProfileId);
  if ("error" in duplicate) return duplicate;
  const renamed = renameImportedSettingsProfile(duplicate.document as never, duplicate.profileId, name);
  if ("error" in renamed) return renamed;
  return fitProfileToRoute(renamed as never, duplicate.profileId, { ...candidate, name }, options);
}

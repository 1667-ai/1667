import { randomUUID } from "node:crypto";
import { readProfileTransferFile } from "../server/profile-transfer-decoder.js";
import { exportGenerationProfile } from "../server/import-profile-export.js";
import { createDurableMutationId } from "../shared/durable-mutation-id.js";
import type { SaveSettingsCommand, SettingsMutationResult } from "../shared/settings-v2-types.js";
import type { SettingsView } from "../shared/settings-v2-view.js";
import type { SettingsDocumentV5 } from "../shared/settings-v5-types.js";
import { selectSettingsRoute } from "../shared/settings-route.js";
import { applyProfileTransfer } from "./launcher/profile-transfer-apply.js";
import { writeExportFile } from "./launcher/export-file.js";

export interface ProfileLauncherApi {
  getSettings(): Promise<SettingsView>;
  saveSettings(command: SaveSettingsCommand): Promise<SettingsMutationResult>;
}

export interface ProfileExportRequest {
  readonly api: ProfileLauncherApi;
  readonly directory: string;
  readonly profile: string | null;
  readonly force: boolean;
}

export interface ProfileExportResult {
  readonly file: string;
  readonly fidelity: readonly string[];
}

export interface ProfileImportRequest {
  readonly api: ProfileLauncherApi;
  readonly file: string;
  readonly profile: string | null;
}

export interface ProfileImportResult {
  readonly file: string;
  readonly profileId: string;
  readonly name: string;
  readonly importedCount: number;
  readonly candidateCount: number;
  readonly fidelity: readonly string[];
  readonly mutation: SettingsMutationResult;
}

/** Export one Generation Profile without CLI output. */
export async function exportProfile(
  request: ProfileExportRequest
): Promise<ProfileExportResult> {
  const view = await request.api.getSettings();
  if (!view.editable || view.document === null) {
    throw new Error("Generation Profiles require settings format 2");
  }
  const document = view.document;
  const profileId = selectProfileId(document, request.profile);
  const archive = exportGenerationProfile(document as never, profileId);
  const file = await writeExportFile({
    directory: request.directory,
    title: document.profiles[profileId]!.name,
    extension: archive.extension,
    content: archive.text,
    force: request.force
  });
  return { file, fidelity: archive.fidelity };
}

/** Import one Generation Profile without CLI output. */
export async function importProfile(
  request: ProfileImportRequest
): Promise<ProfileImportResult> {
  const candidate = await readProfileTransferFile(request.file);
  const view = await request.api.getSettings();
  if (!view.editable || view.document === null) {
    throw new Error("Generation Profiles require settings format 2");
  }
  const document = view.document;
  const sourceProfileId = selectProfileId(document, request.profile);
  const fitted = applyProfileTransfer(document, sourceProfileId, candidate);
  if ("error" in fitted) throw new Error(fitted.error);
  const mutation = await request.api.saveSettings({
    transportOperationId: randomUUID(),
    mutationId: createDurableMutationId(),
    expectedStateGeneration: view.stateGeneration,
    document: fitted.document as never
  });
  return {
    file: request.file,
    profileId: fitted.profileId,
    name: fitted.document.profiles[fitted.profileId]!.name,
    importedCount: fitted.importedCount,
    candidateCount: fitted.candidateCount,
    fidelity: fitted.fidelity,
    mutation
  };
}

function selectProfileId(
  document: SettingsDocumentV5,
  selector: string | null
): string {
  if (selector === null) return selectSettingsRoute(document, "prose").profileId;
  if (Object.hasOwn(document.profiles, selector)) return selector;
  const matches = Object.entries(document.profiles)
    .filter(([, profile]) => profile.name === selector);
  if (matches.length === 1) return matches[0]![0];
  throw new Error(`unknown Generation Profile: ${selector}`);
}

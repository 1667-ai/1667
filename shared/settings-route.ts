import type {
  GenerationProfileV2,
  ModelConnectionV2,
  ModelDefinitionV2,
  SettingsDocumentV2,
  SettingsRoutePurpose
} from "./settings-v2-types.js";

export interface SelectedSettingsRouteV2 {
  readonly profileId: string;
  readonly profile: GenerationProfileV2;
  readonly model: ModelDefinitionV2;
  readonly connection: ModelConnectionV2;
}

/** Resolve one explicit Generation Profile. Route fallback belongs in
 * `selectSettingsRoute`; callers that already have a profile identity must
 * not duplicate that policy. */
export function resolveSettingsProfile(
  document: SettingsDocumentV2,
  profileId: string
): SelectedSettingsRouteV2 {
  const profile = document.profiles[profileId];
  if (profile === undefined) throw new Error(`Generation route references missing profile ${profileId}`);
  const model = document.models[profile.modelId];
  if (model === undefined) throw new Error(`Generation profile references missing model ${profile.modelId}`);
  const connection = document.connections[model.connectionId];
  if (connection === undefined) {
    throw new Error(`Generation model references missing connection ${model.connectionId}`);
  }
  return { profileId, profile, model, connection };
}

/** Canonical route selection for every projection derived from one settings
 * document. Keeping fallback resolution here prevents provider and capability
 * views from drifting onto different profiles. */
export function selectSettingsRoute(
  document: SettingsDocumentV2,
  purpose: SettingsRoutePurpose = "default"
): SelectedSettingsRouteV2 {
  const profileId = purpose === "default"
    ? document.routing.default
    : document.routing[purpose] ?? document.routing.default;
  return resolveSettingsProfile(document, profileId);
}

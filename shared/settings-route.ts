import type {
  GenerationProfileV2,
  ModelConnectionV2,
  ModelDefinitionV2,
  SettingsDocumentV2,
  SettingsRoutingV2,
  SettingsRoutePurpose
} from "./settings-v2-types.js";

export interface SettingsRouteDocument<
  TProfile extends { readonly modelId: string },
  TModel extends { readonly connectionId: string },
  TConnection
> {
  readonly profiles: Readonly<Record<string, TProfile>>;
  readonly models: Readonly<Record<string, TModel>>;
  readonly connections: Readonly<Record<string, TConnection>>;
  readonly routing: SettingsRoutingV2;
}

export interface SelectedSettingsRoute<
  TProfile extends { readonly modelId: string },
  TModel extends { readonly connectionId: string },
  TConnection
> {
  readonly profileId: string;
  readonly profile: TProfile;
  readonly model: TModel;
  readonly connection: TConnection;
}

export type SelectedSettingsRouteV2 = SelectedSettingsRoute<
  GenerationProfileV2,
  ModelDefinitionV2,
  ModelConnectionV2
>;

/** Resolve one explicit Generation Profile. Route fallback belongs in
 * `selectSettingsRoute`; callers that already have a profile identity must
 * not duplicate that policy. */
export function resolveSettingsProfile<
  TProfile extends { readonly modelId: string },
  TModel extends { readonly connectionId: string },
  TConnection
>(
  document: SettingsRouteDocument<TProfile, TModel, TConnection>,
  profileId: string
): SelectedSettingsRoute<TProfile, TModel, TConnection> {
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
export function selectSettingsRoute<
  TProfile extends { readonly modelId: string },
  TModel extends { readonly connectionId: string },
  TConnection
>(
  document: SettingsRouteDocument<TProfile, TModel, TConnection>,
  purpose: SettingsRoutePurpose = "default"
): SelectedSettingsRoute<TProfile, TModel, TConnection> {
  const profileId = purpose === "default"
    ? document.routing.default
    : document.routing[purpose] ?? document.routing.default;
  return resolveSettingsProfile(document, profileId);
}

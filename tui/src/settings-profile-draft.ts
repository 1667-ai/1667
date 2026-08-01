import type {
  SettingsDocumentV2,
  SettingsRoutePurpose
} from "../../shared/settings-v2-types.js";
import { resolveSettingsProfile } from "../../shared/settings-route.js";
import type { GenerationSettings } from "../../shared/types.js";

const MAX_PROFILES = 64;
const MAX_PROFILE_NAME_SCALARS = 256;

export interface ProfileDraftResult {
  readonly document: SettingsDocumentV2;
  readonly profileId: string;
}

export type ProfileDeleteResult =
  | ProfileDraftResult
  | { readonly error: string };

/** Keep an existing selection when an authoritative refresh still has it.
 * The default route is the one durable fallback for a vanished profile. */
export function selectedSettingsProfileId(
  document: SettingsDocumentV2,
  preferred: string | null | undefined
): string {
  return preferred !== null && preferred !== undefined && document.profiles[preferred] !== undefined
    ? preferred
    : document.routing.default;
}

export function settingsProfileIds(document: SettingsDocumentV2): readonly string[] {
  return Object.keys(document.profiles);
}

export function cycleSettingsProfile(
  document: SettingsDocumentV2,
  selectedProfileId: string,
  step: -1 | 1
): string {
  const ids = settingsProfileIds(document);
  const current = ids.indexOf(selectedProfileId);
  const index = current < 0
    ? 0
    : (current + step + ids.length) % ids.length;
  return ids[index] ?? document.routing.default;
}

export function cycleSettingsRoute(
  document: SettingsDocumentV2,
  purpose: SettingsRoutePurpose,
  step: -1 | 1
): SettingsDocumentV2 {
  const ids = settingsProfileIds(document);
  const choices: readonly (string | null)[] = purpose === "default" ? ids : [null, ...ids];
  const current = purpose === "default"
    ? document.routing.default
    : document.routing[purpose] ?? null;
  const currentIndex = choices.indexOf(current);
  const next = choices[(currentIndex + step + choices.length) % choices.length]!;
  if (purpose === "default") {
    return next === document.routing.default
      ? document
      : { ...document, routing: { ...document.routing, default: next! } };
  }
  if (next === null) {
    if (document.routing[purpose] === undefined) return document;
    const routing = { ...document.routing };
    delete routing[purpose];
    return { ...document, routing };
  }
  return document.routing[purpose] === next
    ? document
    : { ...document, routing: { ...document.routing, [purpose]: next } };
}

export function createSettingsProfile(
  document: SettingsDocumentV2,
  selectedProfileId: string
): ProfileDraftResult | { readonly error: string } {
  if (settingsProfileIds(document).length >= MAX_PROFILES) {
    return { error: "the profile limit is 64" };
  }
  const selected = resolveSettingsProfile(document, selectedProfileId).profile;
  const profileId = freshSettingsId(document.profiles, "profile");
  const name = freshProfileName(document, "Profile");
  return {
    document: {
      ...document,
      profiles: {
        ...document.profiles,
        [profileId]: { ...selected, name }
      }
    },
    profileId
  };
}

export function duplicateSettingsProfile(
  document: SettingsDocumentV2,
  selectedProfileId: string
): ProfileDraftResult | { readonly error: string } {
  if (settingsProfileIds(document).length >= MAX_PROFILES) {
    return { error: "the profile limit is 64" };
  }
  const selected = resolveSettingsProfile(document, selectedProfileId).profile;
  const profileId = freshSettingsId(document.profiles, "profile");
  return {
    document: {
      ...document,
      profiles: {
        ...document.profiles,
        [profileId]: {
          ...selected,
          name: freshProfileName(document, selected.name, " copy")
        }
      }
    },
    profileId
  };
}

export function renameSettingsProfile(
  document: SettingsDocumentV2,
  profileId: string,
  rawName: string
): SettingsDocumentV2 | { readonly error: string } {
  const name = rawName.trim();
  if (name.length === 0) return { error: "profile name cannot be blank" };
  if ([...name].length > MAX_PROFILE_NAME_SCALARS) {
    return { error: "profile name must be at most 256 characters" };
  }
  // The schema permits duplicate names. This surface does not: route cyclers
  // show names, so uniqueness keeps their selected target unambiguous.
  if (Object.entries(document.profiles).some(
    ([id, profile]) => id !== profileId && profile.name === name
  )) {
    return { error: "profile names must be unique" };
  }
  const profile = document.profiles[profileId];
  if (profile === undefined) return { error: "profile no longer exists" };
  return profile.name === name
    ? document
    : {
        ...document,
        profiles: { ...document.profiles, [profileId]: { ...profile, name } }
      };
}

/** Delete the selected profile and resources that only it can reach. Preserve
 * shared and unrelated imported records. */
export function deleteSettingsProfile(
  document: SettingsDocumentV2,
  profileId: string
): ProfileDeleteResult {
  const ids = settingsProfileIds(document);
  if (ids.length === 1) return { error: "the last profile cannot be removed" };
  if (document.profiles[profileId] === undefined) return { error: "profile no longer exists" };
  const remaining = ids.filter((id) => id !== profileId);
  const fallback = remaining[0]!;
  const profiles = { ...document.profiles };
  const deletedModelId = profiles[profileId]!.modelId;
  delete profiles[profileId];
  const routing = { ...document.routing };
  if (routing.default === profileId) routing.default = fallback;
  if (routing.prose === profileId) delete routing.prose;
  if (routing.utility === profileId) delete routing.utility;
  const models = { ...document.models };
  const modelStillUsed = Object.values(profiles).some(
    (profile) => profile.modelId === deletedModelId
  );
  const deletedConnectionId = models[deletedModelId]?.connectionId;
  if (!modelStillUsed) delete models[deletedModelId];
  const connections = { ...document.connections };
  if (deletedConnectionId !== undefined
    && !Object.values(models).some((model) => model.connectionId === deletedConnectionId)) {
    delete connections[deletedConnectionId];
  }
  const next = { ...document, connections, models, profiles, routing };
  return {
    document: next,
    profileId: selectedSettingsProfileId(next, profileId)
  };
}

/** Copy-on-write before a profile changes model-owned fields. New profiles may
 * intentionally share a model until an edit needs independent behavior. */
export function isolateSettingsProfileModel(
  document: SettingsDocumentV2,
  profileId: string
): SettingsDocumentV2 {
  const selected = resolveSettingsProfile(document, profileId);
  const shared = Object.entries(document.profiles).some(
    ([id, profile]) => id !== profileId && profile.modelId === selected.profile.modelId
  );
  if (!shared) return document;
  if (Object.keys(document.models).length >= MAX_PROFILES) {
    throw new Error("the model record limit is 64");
  }
  const modelId = freshSettingsId(document.models, "model");
  return {
    ...document,
    models: { ...document.models, [modelId]: { ...selected.model } },
    profiles: {
      ...document.profiles,
      [profileId]: { ...selected.profile, modelId }
    }
  };
}

/** A connection changes only after its selected model has become private.
 * Check reachable profile models, not all imported records. */
export function isolateSettingsProfileConnection(
  document: SettingsDocumentV2,
  profileId: string
): SettingsDocumentV2 {
  const modelIsolated = isolateSettingsProfileModel(document, profileId);
  const selected = resolveSettingsProfile(modelIsolated, profileId);
  const shared = Object.entries(modelIsolated.profiles).some(([id, profile]) => {
    if (id === profileId) return false;
    return modelIsolated.models[profile.modelId]?.connectionId === selected.model.connectionId;
  });
  if (!shared) return modelIsolated;
  if (Object.keys(modelIsolated.connections).length >= MAX_PROFILES) {
    throw new Error("the connection record limit is 64");
  }
  const connectionId = freshSettingsId(modelIsolated.connections, "connection");
  return {
    ...modelIsolated,
    connections: {
      ...modelIsolated.connections,
      [connectionId]: { ...selected.connection }
    },
    models: {
      ...modelIsolated.models,
      [selected.profile.modelId]: { ...selected.model, connectionId }
    }
  };
}

/** Prepare the canonical document before basic-editor projection mutates its
 * selected profile. Profile scalars do not require copy-on-write. */
export function prepareSettingsProfileGenerationEdit(
  document: SettingsDocumentV2,
  profileId: string,
  current: GenerationSettings,
  next: GenerationSettings
): SettingsDocumentV2 {
  const connectionChanged = current.provider !== next.provider
    || current.baseUrl !== next.baseUrl
    || current.apiKeyEnv !== next.apiKeyEnv
    || current.allowInsecureHttp !== next.allowInsecureHttp;
  if (connectionChanged) return isolateSettingsProfileConnection(document, profileId);
  const modelChanged = current.model !== next.model
    || current.contextWindow !== next.contextWindow;
  return modelChanged ? isolateSettingsProfileModel(document, profileId) : document;
}

export function profileRouteState(
  document: SettingsDocumentV2,
  profileId: string
): "default" | "prose" | "utility" | "unrouted" {
  if (document.routing.default === profileId) return "default";
  if (document.routing.prose === profileId) return "prose";
  if (document.routing.utility === profileId) return "utility";
  return "unrouted";
}

function freshSettingsId(
  records: Readonly<Record<string, unknown>>,
  prefix: "profile" | "model" | "connection"
): string {
  for (let number = 1; ; number += 1) {
    const candidate = `${prefix}.${number}`;
    if (records[candidate] === undefined) return candidate;
  }
}

function freshProfileName(
  document: SettingsDocumentV2,
  base: string,
  suffix = ""
): string {
  const names = new Set(Object.values(document.profiles).map((profile) => profile.name));
  const candidate = boundedProfileName(base, suffix);
  if (!names.has(candidate)) return candidate;
  for (let number = 2; ; number += 1) {
    const numbered = boundedProfileName(base, `${suffix} ${number}`);
    if (!names.has(numbered)) return numbered;
  }
}

function boundedProfileName(base: string, suffix: string): string {
  const suffixScalars = [...suffix];
  return [...base].slice(0, MAX_PROFILE_NAME_SCALARS - suffixScalars.length).join("")
    + suffix;
}

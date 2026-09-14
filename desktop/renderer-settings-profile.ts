import type { DiscoveredModelV2, ModelConnectionV2 } from "../shared/settings-v2-types.js";
import { defaultModelCapabilitiesV3 } from "../shared/settings-provider-defaults.js";
import { providerProbeRouteFromV5Route, type ProviderProbeTarget } from "../shared/provider-probe-route-v1.js";
import { resolveSettingsProfile } from "../shared/settings-route.js";
import { MAX_SETTINGS_HEADERS } from "../shared/settings-validation-scalars.js";
import { validateSettingsDocumentV5 } from "../shared/settings-v5-validation.js";
import type { ModelDefinitionV5, SettingsDocumentV5 } from "../shared/settings-v5-types.js";
import {
  draftForDocument,
  editSettingsField,
  isolateProfileModel,
  profileRoute,
  type SettingsEditResult,
  type SettingsEditorDraft
} from "./renderer-settings-model.js";

export function createSettingsProfile(document: SettingsDocumentV5, sourceProfileId: string): SettingsEditorDraft | string {
  const source = document.profiles[sourceProfileId];
  if (source === undefined) return "The selected profile no longer exists.";
  const id = nextId(document.profiles, "profile");
  const name = nextName(document, source.name, " copy");
  const next = {
    ...document,
    profiles: { ...document.profiles, [id]: { ...source, name, generationReasoning: { ...source.generationReasoning } } }
  };
  return draftForDocument(next, id);
}

/** Create an isolated provider route and a profile that points to it. */
export function createSettingsConnection(document: SettingsDocumentV5, sourceProfileId: string): SettingsEditorDraft | string {
  const source = resolveSettingsProfile(document, sourceProfileId);
  const connectionId = nextId(document.connections, "connection");
  const modelId = nextId(document.models, "model");
  const profileId = nextId(document.profiles, "profile");
  const profileName = nextName(document, source.profile.name, " connection");
  const connection = source.connection.auth.type === "bearer-stored" || source.connection.auth.type === "header-stored"
    ? { ...source.connection, auth: { type: "none" as const } }
    : { ...source.connection };
  const next: SettingsDocumentV5 = {
    ...document,
    connections: { ...document.connections, [connectionId]: connection },
    models: { ...document.models, [modelId]: { ...source.model, connectionId } },
    profiles: {
      ...document.profiles,
      [profileId]: { ...source.profile, name: profileName, modelId, generationReasoning: { ...source.profile.generationReasoning } }
    }
  };
  return draftForDocument(next, profileId);
}

export function deleteSettingsProfile(document: SettingsDocumentV5, profileId: string): SettingsEditorDraft | string {
  const ids = Object.keys(document.profiles);
  if (ids.length <= 1) return "The last profile cannot be removed.";
  if (document.profiles[profileId] === undefined) return "The selected profile no longer exists.";
  const fallback = ids.find((id) => id !== profileId)!;
  const profiles = { ...document.profiles };
  const modelId = profiles[profileId]!.modelId;
  delete profiles[profileId];
  const routing = { ...document.routing };
  if (routing.default === profileId) routing.default = fallback;
  if (routing.prose === profileId) delete routing.prose;
  if (routing.utility === profileId) delete routing.utility;
  const models = { ...document.models };
  const connections = { ...document.connections };
  if (!Object.values(profiles).some((profile) => profile.modelId === modelId)) {
    const connectionId = models[modelId]?.connectionId;
    delete models[modelId];
    if (connectionId !== undefined && !Object.values(models).some((model) => model.connectionId === connectionId)) delete connections[connectionId];
  }
  return draftForDocument({ ...document, profiles, models, connections, routing }, fallback);
}

export function renameSettingsProfile(document: SettingsDocumentV5, profileId: string, rawName: string): SettingsEditResult {
  const name = rawName.trim();
  if (name.length === 0) return { document, error: "Profile name cannot be blank." };
  if (Object.entries(document.profiles).some(([id, profile]) => id !== profileId && profile.name === name)) return { document, error: "Profile names must be unique." };
  return editSettingsField(document, profileId, "profile.name", name);
}

export function ensurePrivateProfileConnection(document: SettingsDocumentV5, profileId: string): SettingsDocumentV5 {
  const route = resolveSettingsProfile(document, profileId);
  const shared = Object.entries(document.profiles).some(([id, profile]) => id !== profileId && document.models[profile.modelId]?.connectionId === route.model.connectionId);
  if (!shared) return document;
  const connectionId = nextId(document.connections, "connection");
  const modelId = nextId(document.models, "model");
  return {
    ...document,
    connections: { ...document.connections, [connectionId]: { ...route.connection } },
    models: { ...document.models, [modelId]: { ...route.model, connectionId } },
    profiles: { ...document.profiles, [profileId]: { ...route.profile, modelId } }
  };
}

export function addConnectionHeader(document: SettingsDocumentV5, profileId: string): SettingsEditResult {
  const isolated = ensurePrivateProfileConnection(document, profileId);
  const route = resolveSettingsProfile(isolated, profileId);
  if (route.connection.protocol === "dry-run"
    || route.connection.protocol === "openai-codex-responses"
    || route.connection.protocol === "anthropic-subscription-messages") {
    return { document, error: "This provider protocol does not accept custom headers." };
  }
  if (route.connection.headers.length >= MAX_SETTINGS_HEADERS) {
    return { document, error: `A connection can have at most ${MAX_SETTINGS_HEADERS} custom headers.` };
  }
  const number = route.connection.headers.length + 1;
  return replaceConnection(isolated, profileId, {
    ...route.connection,
    headers: [
      ...route.connection.headers,
      { name: `X-Desktop-Header-${number}`, value: { type: "env", env: `DESKTOP_HEADER_${number}` } }
    ]
  });
}

export function editConnectionHeader(
  document: SettingsDocumentV5,
  profileId: string,
  index: number,
  name: string,
  env: string
): SettingsEditResult {
  const isolated = ensurePrivateProfileConnection(document, profileId);
  const route = resolveSettingsProfile(isolated, profileId);
  if (index < 0 || index >= route.connection.headers.length) return { document, error: "The selected header no longer exists." };
  return replaceConnection(isolated, profileId, {
    ...route.connection,
    headers: route.connection.headers.map((header, headerIndex) => headerIndex === index
      ? { name, value: { type: "env" as const, env } }
      : header)
  });
}

export function removeConnectionHeader(document: SettingsDocumentV5, profileId: string, index: number): SettingsEditResult {
  const isolated = ensurePrivateProfileConnection(document, profileId);
  const route = resolveSettingsProfile(isolated, profileId);
  if (index < 0 || index >= route.connection.headers.length) return { document, error: "The selected header no longer exists." };
  return replaceConnection(isolated, profileId, {
    ...route.connection,
    headers: route.connection.headers.filter((_header, headerIndex) => headerIndex !== index)
  });
}

function replaceConnection(
  document: SettingsDocumentV5,
  profileId: string,
  connection: ModelConnectionV2
): SettingsEditResult {
  const route = resolveSettingsProfile(document, profileId);
  return {
    document: { ...document, connections: { ...document.connections, [route.model.connectionId]: connection } },
    error: null
  };
}

export function setConnectionSecret(draft: SettingsEditorDraft, value: string): SettingsEditorDraft {
  const route = profileRoute(draft);
  const auth = route.connection.auth;
  if (auth.type !== "bearer-stored" && auth.type !== "header-stored") return draft;
  const connectionSecrets = { ...draft.connectionSecrets };
  if (value.length === 0) delete connectionSecrets[auth.secretId];
  else connectionSecrets[auth.secretId] = value;
  return { ...draft, connectionSecrets };
}

/** Remove the selected stored credential and queue its machine-tier deletion. */
export function clearConnectionSecret(draft: SettingsEditorDraft): SettingsEditorDraft {
  const privateDocument = ensurePrivateProfileConnection(draft.document, draft.selectedProfileId);
  const route = profileRoute({ ...draft, document: privateDocument });
  const auth = route.connection.auth;
  if (auth.type !== "bearer-stored" && auth.type !== "header-stored") return draft;
  const connectionSecrets = { ...draft.connectionSecrets };
  const document = {
    ...privateDocument,
    connections: {
      ...privateDocument.connections,
      [route.model.connectionId]: { ...route.connection, auth: { type: "none" as const } }
    }
  };
  const stillReferenced = Object.values(document.connections).some((connection) =>
    (connection.auth.type === "bearer-stored" || connection.auth.type === "header-stored")
      && connection.auth.secretId === auth.secretId
  );
  if (stillReferenced) {
    // The old connection still uses this key. Keep its sidecar intent intact.
  } else if (typeof connectionSecrets[auth.secretId] === "string") delete connectionSecrets[auth.secretId];
  else connectionSecrets[auth.secretId] = null;
  return { ...draft, document, connectionSecrets };
}

export function providerProbeTarget(draft: SettingsEditorDraft): ProviderProbeTarget {
  const route = profileRoute(draft);
  const auth = route.connection.auth;
  const secretId = auth.type === "bearer-stored" || auth.type === "header-stored" ? auth.secretId : null;
  const pending = secretId === null ? undefined : draft.connectionSecrets[secretId];
  if (secretId === null || typeof pending !== "string") return providerProbeRouteFromV5Route(route);
  return providerProbeRouteFromV5Route(route, { [secretId]: pending });
}

export function validateSettingsDraft(document: SettingsDocumentV5): string | null {
  try {
    validateSettingsDocumentV5(document);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function applyDiscoveredModel(draft: SettingsEditorDraft, discovered: DiscoveredModelV2): SettingsEditorDraft {
  const isolatedDraft = { ...draft, document: isolateProfileModel(draft.document, draft.selectedProfileId) };
  const route = profileRoute(isolatedDraft);
  const next = {
    ...route.model,
    remoteId: discovered.remoteId,
    name: discovered.name,
    discovered: {
      ...(discovered.contextWindow === null ? {} : { contextWindow: discovered.contextWindow }),
      ...(discovered.maxOutputTokens === null ? {} : { maxOutputTokens: discovered.maxOutputTokens })
    }
  };
  return {
    ...isolatedDraft,
    document: { ...isolatedDraft.document, models: { ...isolatedDraft.document.models, [route.profile.modelId]: next } }
  };
}

export function ensureModelForRemoteId(document: SettingsDocumentV5, profileId: string, remoteId: string, name = remoteId): SettingsDocumentV5 {
  const route = resolveSettingsProfile(document, profileId);
  return {
    ...document,
    models: {
      ...document.models,
      [route.profile.modelId]: {
        ...route.model,
        remoteId,
        name,
        discovered: {},
        overrides: {},
        capabilities: defaultModelCapabilitiesV3(connectionProvider(route.connection))
      }
    }
  };
}

function connectionProvider(connection: ModelConnectionV2): "dry-run" | "openai-compatible" | "anthropic" | "text-completion" {
  if (connection.protocol === "dry-run") return "dry-run";
  if (connection.protocol === "anthropic-messages" || connection.protocol === "anthropic-subscription-messages") return "anthropic";
  if (connection.protocol === "text-completions") return "text-completion";
  return "openai-compatible";
}

function nextId(records: Readonly<Record<string, unknown>>, prefix: string): string {
  for (let number = 1; ; number += 1) {
    const id = `${prefix}.${number}`;
    if (records[id] === undefined) return id;
  }
}

function nextName(document: SettingsDocumentV5, base: string, suffix: string): string {
  const names = new Set(Object.values(document.profiles).map((profile) => profile.name));
  const first = `${base}${suffix}`;
  if (!names.has(first)) return first;
  for (let index = 2; ; index += 1) {
    const next = `${base}${suffix} ${index}`;
    if (!names.has(next)) return next;
  }
}

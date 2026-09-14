import type {
  ModelConnectionV2,
  ModelDiscoveryResultV2,
  SamplingPhraseBiasEntryV2,
  SamplingScalarKnobV2,
  SamplingSettingsV2,
  SettingsPresetV2,
  SettingsProtocolV2,
  SettingsRoutePurpose,
  SettingsView,
  TextPromptFormatV2
} from "../shared/settings-v2-types.js";
import {
  EMPTY_SAMPLING_V2,
  SETTINGS_PRESET_V2_VALUES,
  SETTINGS_PROTOCOL_V2_VALUES,
  SAMPLING_SCALAR_KNOB_V2_VALUES,
  TEXT_PROMPT_FORMAT_V2_VALUES
} from "../shared/settings-v2-types.js";
import type { GenerationEffortV4, ThinkingModeV4 } from "../shared/settings-v4-types.js";
import { GENERATION_EFFORT_V4_VALUES, THINKING_MODE_V4_VALUES } from "../shared/settings-v4-types.js";
import type { GenerationReasoningV5 } from "../shared/settings-v5-reasoning.js";
import { independentGenerationReasoningV5 } from "../shared/settings-v5-reasoning.js";
import type { SettingsDocumentV5, GenerationProfileV5, ModelDefinitionV5 } from "../shared/settings-v5-types.js";
import type { WritingPromptFieldId } from "../shared/settings-v5-writing.js";
import { resolveSettingsProfile } from "../shared/settings-route.js";
import { SAMPLING_SCALAR_DESCRIPTORS } from "../shared/sampling-validation-policy.js";
import { MAX_ALTERNATIVE_TOKENS } from "../shared/token-probability-policy.js";
import {
  MAX_SETTINGS_ID_SCALARS,
  MAX_SETTINGS_TOKEN_COUNT,
  MAX_SETTINGS_TIMEOUT_MS
} from "../shared/settings-validation-scalars.js";

export type SettingsEditorField =
  | "profile.name"
  | "profile.modelId"
  | "profile.temperature"
  | "profile.maxOutputTokens"
  | "profile.effort"
  | "profile.thinkingMode"
  | "profile.reasoning"
  | "profile.cachePolicy"
  | "profile.tokenProbabilities"
  | "profile.discardReasoning"
  | "profile.continuationPromptOptimization"
  | "model.contextWindow"
  | "model.remoteId"
  | "model.name"
  | "model.maxOutputTokens"
  | "model.imageInput"
  | "model.imageTokenCeiling"
  | "model.temperature"
  | "model.assistantPrefill"
  | "model.reasoningEffort"
  | "model.reasoningContent"
  | "model.promptCaching"
  | "connection.name"
  | "connection.preset"
  | "connection.protocol"
  | "connection.baseUrl"
  | "connection.textPromptFormat"
  | "connection.allowInsecureHttp"
  | "connection.splitThinkTags"
  | "connection.authType"
  | "connection.authEnv"
  | "connection.authHeader"
  | "connection.responseHeaderMs"
  | "connection.firstTokenMs"
  | "connection.idleMs"
  | "connection.totalMs"
  | `writing.${WritingPromptFieldId}`
  | `route.${SettingsRoutePurpose}`;

export interface SettingsEditResult {
  readonly document: SettingsDocumentV5;
  readonly error: string | null;
}

export interface SettingsEditorDraft {
  readonly document: SettingsDocumentV5;
  readonly selectedProfileId: string;
  readonly connectionSecrets: Readonly<Record<string, string | null>>;
}

export interface SettingsEditorSnapshot {
  readonly view: SettingsView;
  readonly draft: SettingsEditorDraft | null;
  readonly discovery: ModelDiscoveryResultV2 | null;
}

export const SETTINGS_PRESETS = SETTINGS_PRESET_V2_VALUES;
export const SETTINGS_PROTOCOLS = SETTINGS_PROTOCOL_V2_VALUES;
export const SETTINGS_TEXT_FORMATS = TEXT_PROMPT_FORMAT_V2_VALUES;
export const SETTINGS_EFFORTS = GENERATION_EFFORT_V4_VALUES;
export const SETTINGS_THINKING_MODES = THINKING_MODE_V4_VALUES;
export const SETTINGS_SAMPLING_SCALARS = SAMPLING_SCALAR_KNOB_V2_VALUES;

export function createSettingsEditorDraft(
  view: SettingsView,
  preferredProfileId?: string | null
): SettingsEditorDraft | null {
  if (!view.editable || view.document === null) return null;
  return draftForDocument(view.document, preferredProfileId);
}

export function draftForDocument(
  document: SettingsDocumentV5,
  preferredProfileId: string | null | undefined,
  connectionSecrets: Readonly<Record<string, string | null>> = {}
): SettingsEditorDraft {
  const selectedProfileId = preferredProfileId !== undefined
    && preferredProfileId !== null
    && document.profiles[preferredProfileId] !== undefined
    ? preferredProfileId
    : document.routing.default;
  return { document, selectedProfileId, connectionSecrets };
}

export function profileRoute(
  draft: SettingsEditorDraft
): ReturnType<typeof resolveSettingsProfile<GenerationProfileV5, ModelDefinitionV5, ModelConnectionV2>> {
  return resolveSettingsProfile(draft.document, draft.selectedProfileId);
}

export function samplingForProfile(profile: GenerationProfileV5): SamplingSettingsV2 {
  return profile.sampling ?? EMPTY_SAMPLING_V2;
}

export function editSettingsField(
  document: SettingsDocumentV5,
  profileId: string,
  field: SettingsEditorField,
  raw: string
): SettingsEditResult {
  try {
    const isolated = field.startsWith("connection.")
      ? isolateProfileConnection(document, profileId)
      : field.startsWith("model.")
        ? isolateProfileModel(document, profileId)
        : document;
    const route = resolveSettingsProfile(isolated, profileId);
    document = isolated;
    if (field.startsWith("writing.")) {
      const writingField = field.slice("writing.".length) as WritingPromptFieldId;
      return { document: { ...document, writing: { ...document.writing, [writingField]: raw } }, error: null };
    }
    if (field.startsWith("route.")) {
      const purpose = field.slice("route.".length) as SettingsRoutePurpose;
      const routing = { ...document.routing };
      if (purpose === "default") {
        if (!document.profiles[raw]) return { document, error: "Default route must name an existing profile." };
        routing.default = raw;
      } else if (raw.trim().length === 0) {
        delete routing[purpose];
      } else if (!document.profiles[raw]) {
        return { document, error: `${purpose} route must name an existing profile.` };
      } else {
        routing[purpose] = raw;
      }
      return { document: { ...document, routing }, error: null };
    }
    if (field.startsWith("profile.")) {
      const key = field.slice("profile.".length);
      const profile = route.profile;
      const next = editProfile(profile, key, raw);
      if (typeof next === "string") return { document, error: next };
      if (key === "modelId" && document.models[next.modelId] === undefined) {
        return { document, error: "Select an existing model record." };
      }
      return replaceProfile(document, profileId, next);
    }
    if (field.startsWith("model.")) {
      const key = field.slice("model.".length);
      const next = editModel(route.model, key, raw);
      if (typeof next === "string") return { document, error: next };
      return {
        document: {
          ...document,
          models: { ...document.models, [route.profile.modelId]: next }
        },
        error: null
      };
    }
    const key = field.slice("connection.".length);
    const next = editConnection(route.connection, key, raw);
    if (typeof next === "string") return { document, error: next };
    return {
      document: {
        ...document,
        connections: { ...document.connections, [route.model.connectionId]: next }
      },
      error: null
    };
  } catch (error) {
    return { document, error: error instanceof Error ? error.message : String(error) };
  }
}

function editProfile(profile: GenerationProfileV5, key: string, raw: string): GenerationProfileV5 | string {
  if (key === "name") return raw.trim().length === 0 ? "Profile name cannot be blank." : { ...profile, name: raw.trim() };
  if (key === "modelId") return { ...profile, modelId: raw.trim() };
  if (key === "temperature") {
    const value = optionalNumber(raw, -100, 100);
    return value.error ?? { ...profile, temperature: value.value };
  }
  if (key === "maxOutputTokens") {
    const value = positiveInteger(raw, MAX_SETTINGS_TOKEN_COUNT);
    return value.error ?? { ...profile, maxOutputTokens: value.value! };
  }
  if (key === "effort") {
    if (!(SETTINGS_EFFORTS as readonly string[]).includes(raw)) return "Select a supported reasoning effort.";
    return { ...profile, generationReasoning: reasoningWith(profile.generationReasoning, raw as GenerationEffortV4) };
  }
  if (key === "thinkingMode") {
    if (!(SETTINGS_THINKING_MODES as readonly string[]).includes(raw)) return "Select a supported thinking mode.";
    return { ...profile, generationReasoning: reasoningWith(profile.generationReasoning, undefined, raw as ThinkingModeV4) };
  }
  if (key === "reasoning") {
    if (!(["off", "marker", "open"] as readonly string[]).includes(raw)) return "Select a reasoning display mode.";
    return optionalProfileField(profile, "reasoning", raw === "marker" ? undefined : raw);
  }
  if (key === "cachePolicy") {
    if (!(<[string, ...string[]]>["off", "auto", "long"] as readonly string[]).includes(raw)) return "Select a prompt cache policy.";
    return { ...profile, cachePolicy: raw as GenerationProfileV5["cachePolicy"] };
  }
  if (key === "tokenProbabilities") {
    const value = optionalInteger(raw, MAX_ALTERNATIVE_TOKENS);
    if (value.error !== null) return value.error;
    const { tokenProbabilities: _removed, ...rest } = profile;
    return value.value === null ? rest : { ...rest, tokenProbabilities: value.value };
  }
  if (key === "discardReasoning") return raw === "true" ? { ...profile, discardReasoning: true } : withoutKey(profile, "discardReasoning");
  if (key === "continuationPromptOptimization") {
    if (raw !== "" && raw !== "late-cache-stable") return "Select a supported prompt layout.";
    return raw === "" ? withoutKey(profile, "continuationPromptOptimization") : { ...profile, continuationPromptOptimization: "late-cache-stable" };
  }
  return `Unknown profile field: ${key}`;
}

function editModel(model: ModelDefinitionV5, key: string, raw: string): ModelDefinitionV5 | string {
  if (key === "remoteId") return raw.trim().length === 0 ? "Model identifier cannot be blank." : { ...model, remoteId: raw.trim() };
  if (key === "name") return raw.trim().length === 0 ? "Model name cannot be blank." : { ...model, name: raw.trim() };
  if (key === "contextWindow" || key === "maxOutputTokens") {
    const value = optionalInteger(raw, MAX_SETTINGS_TOKEN_COUNT);
    if (value.error !== null) return value.error;
    const overrides = { ...model.overrides };
    if (value.value === null) delete overrides[key];
    else overrides[key] = value.value;
    return { ...model, overrides };
  }
  if (key === "imageTokenCeiling") {
    const value = optionalInteger(raw, MAX_SETTINGS_TOKEN_COUNT);
    if (value.error !== null) return value.error;
    const capabilities = { ...model.capabilities };
    if (value.value === null) delete capabilities.imageTokenCeiling;
    else capabilities.imageTokenCeiling = value.value;
    return { ...model, capabilities };
  }
  if (["imageInput", "temperature", "assistantPrefill", "reasoningEffort", "reasoningContent", "promptCaching"].includes(key)) {
    if (!(<[string, ...string[]]>["supported", "unsupported", "unknown"] as readonly string[]).includes(raw)) return "Select supported, unsupported, or unknown.";
    return { ...model, capabilities: { ...model.capabilities, [key]: raw } };
  }
  return `Unknown model field: ${key}`;
}

function editConnection(connection: ModelConnectionV2, key: string, raw: string): ModelConnectionV2 | string {
  if (key === "name") return raw.trim().length === 0 ? "Connection name cannot be blank." : { ...connection, name: raw.trim() };
  if (key === "preset") {
    if (!(SETTINGS_PRESETS as readonly string[]).includes(raw)) return "Select a supported provider preset.";
    return { ...connection, preset: raw as SettingsPresetV2 };
  }
  if (key === "protocol") {
    if (!(SETTINGS_PROTOCOLS as readonly string[]).includes(raw)) return "Select a supported provider protocol.";
    return { ...connection, protocol: raw as SettingsProtocolV2 };
  }
  if (key === "baseUrl") return { ...connection, baseUrl: raw.trim().length === 0 ? null : raw.trim().replace(/\/+$/u, "") };
  if (key === "textPromptFormat") {
    if (raw === "") return withoutKey(connection, "textPromptFormat");
    if (!(SETTINGS_TEXT_FORMATS as readonly string[]).includes(raw)) return "Select a supported text prompt format.";
    return { ...connection, textPromptFormat: raw as TextPromptFormatV2 };
  }
  if (key === "allowInsecureHttp") return raw === "true" ? { ...connection, allowInsecureHttp: true } : withoutKey(connection, "allowInsecureHttp");
  if (key === "splitThinkTags") return raw === "true" ? { ...connection, splitThinkTags: true } : withoutKey(connection, "splitThinkTags");
  if (key === "authType") return changeAuthType(connection, raw);
  if (key === "authEnv") return changeAuthEnv(connection, raw);
  if (key === "authHeader") return changeAuthHeader(connection, raw);
  if (["responseHeaderMs", "firstTokenMs", "idleMs", "totalMs"].includes(key)) {
    const value = positiveInteger(raw, MAX_SETTINGS_TIMEOUT_MS);
    if (value.error !== null) return value.error;
    return { ...connection, timeouts: { ...connection.timeouts, [key]: value.value } };
  }
  return `Unknown connection field: ${key}`;
}

function changeAuthType(connection: ModelConnectionV2, raw: string): ModelConnectionV2 | string {
  if (raw === "none") return { ...connection, auth: { type: "none" } };
  if (raw === "bearer-env") return { ...connection, auth: { type: "bearer-env", env: "OPENAI_API_KEY" } };
  if (raw === "bearer-stored") return { ...connection, auth: { type: "bearer-stored", secretId: storedSecretId(connection) } };
  if (raw === "header-env") return { ...connection, auth: { type: "header-env", name: "x-api-key", env: "API_KEY" } };
  if (raw === "header-stored") return { ...connection, auth: { type: "header-stored", name: "x-api-key", secretId: storedSecretId(connection) } };
  return "Select a supported authentication mode.";
}

function storedSecretId(connection: ModelConnectionV2): string {
  if (connection.auth.type === "bearer-stored" || connection.auth.type === "header-stored") {
    return connection.auth.secretId;
  }
  const suffix = `.k${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`}`;
  const prefix = safeId(connection.name).slice(0, Math.max(1, MAX_SETTINGS_ID_SCALARS - suffix.length));
  return `${prefix}${suffix}`;
}

function changeAuthEnv(connection: ModelConnectionV2, raw: string): ModelConnectionV2 | string {
  const env = raw.trim();
  if (env.length === 0) return "Environment variable name cannot be blank.";
  const auth = connection.auth;
  if (auth.type === "bearer-env") return { ...connection, auth: { ...auth, env } };
  if (auth.type === "header-env") return { ...connection, auth: { ...auth, env } };
  return connection;
}

function changeAuthHeader(connection: ModelConnectionV2, raw: string): ModelConnectionV2 | string {
  const name = raw.trim();
  if (name.length === 0) return "Authentication header cannot be blank.";
  const auth = connection.auth;
  if (auth.type === "header-env" || auth.type === "header-stored") return { ...connection, auth: { ...auth, name } };
  return connection;
}

function replaceProfile(document: SettingsDocumentV5, profileId: string, profile: GenerationProfileV5): SettingsEditResult {
  return { document: { ...document, profiles: { ...document.profiles, [profileId]: profile } }, error: null };
}

function reasoningWith(current: GenerationReasoningV5, effort?: GenerationEffortV4, thinkingMode?: ThinkingModeV4): GenerationReasoningV5 {
  return independentGenerationReasoningV5(
    effort ?? (current.kind === "independent" ? current.effort : "default"),
    thinkingMode ?? (current.kind === "independent" ? current.thinkingMode : "default")
  );
}

function optionalProfileField(profile: GenerationProfileV5, key: "reasoning", value: string | undefined): GenerationProfileV5;
function optionalProfileField(profile: GenerationProfileV5, key: never, value: never): GenerationProfileV5;
function optionalProfileField(profile: GenerationProfileV5, key: string, value: unknown): GenerationProfileV5 {
  const next = { ...profile } as Record<string, unknown>;
  if (value === undefined) delete next[key]; else next[key] = value;
  return next as unknown as GenerationProfileV5;
}

function withoutKey<T extends object>(value: T, key: string): T {
  const next = { ...value } as Record<string, unknown>;
  delete next[key];
  return next as T;
}

export function editSamplingScalar(
  document: SettingsDocumentV5,
  profileId: string,
  knob: SamplingScalarKnobV2,
  raw: string
): SettingsEditResult {
  const route = resolveSettingsProfile(document, profileId);
  const descriptor = SAMPLING_SCALAR_DESCRIPTORS[knob];
  const value = optionalNumber(raw, descriptor.minimum, descriptor.maximum, descriptor.integer);
  if (value.error !== null) return { document, error: value.error };
  const sampling = { ...samplingForProfile(route.profile), [knob]: value.value } as SamplingSettingsV2;
  return replaceProfile(document, profileId, { ...route.profile, sampling });
}

export type SamplingListName = "stop" | "dryBreakers" | "bannedStrings" | "phraseBias" | "logitBias";

export function editSamplingList(
  document: SettingsDocumentV5,
  profileId: string,
  list: SamplingListName,
  raw: string
): SettingsEditResult {
  const route = resolveSettingsProfile(document, profileId);
  const sampling = samplingForProfile(route.profile);
  if (list === "phraseBias") {
    const entries: SamplingPhraseBiasEntryV2[] = [];
    for (const line of raw.split("\n").map((item) => item.trim()).filter(Boolean)) {
      const separator = line.lastIndexOf("|");
      const phrase = (separator < 0 ? line : line.slice(0, separator)).trim();
      const weight = Number(separator < 0 ? "" : line.slice(separator + 1).trim());
      if (phrase.length === 0 || !Number.isSafeInteger(weight) || weight < -100 || weight > 100) return { document, error: "Phrase bias uses one integer weight from -100 to 100 per line." };
      entries.push({ phrase, weight });
    }
    return replaceProfile(document, profileId, { ...route.profile, sampling: { ...sampling, phraseBias: entries } });
  }
  if (list === "logitBias") {
    const entries: Record<string, number> = {};
    for (const line of raw.split("\n").map((item) => item.trim()).filter(Boolean)) {
      const separator = line.lastIndexOf("|");
      const token = (separator < 0 ? line : line.slice(0, separator)).trim();
      const weight = Number(separator < 0 ? "" : line.slice(separator + 1).trim());
      if (!/^-?\d+$/u.test(token) || !Number.isSafeInteger(weight) || weight < -100 || weight > 100) return { document, error: "Logit bias uses one token ID and integer weight from -100 to 100 per line." };
      entries[token] = weight;
    }
    return replaceProfile(document, profileId, { ...route.profile, sampling: { ...sampling, logitBias: entries } });
  }
  const values = raw.split("\n").map((item) => item.trim()).filter(Boolean);
  return replaceProfile(document, profileId, {
    ...route.profile,
    sampling: { ...sampling, [list]: values }
  });
}

function safeId(value: string): string {
  const id = value.trim().toLowerCase().replace(/[^a-z0-9._:-]+/gu, "-");
  return id.length > 0 ? id.slice(0, 80) : "connection";
}

export function isolateProfileModel(document: SettingsDocumentV5, profileId: string): SettingsDocumentV5 {
  const route = resolveSettingsProfile(document, profileId);
  const shared = Object.entries(document.profiles).some(([id, profile]) => id !== profileId && profile.modelId === route.profile.modelId);
  if (!shared) return document;
  const modelId = nextRecordId(document.models, "model");
  return {
    ...document,
    models: { ...document.models, [modelId]: { ...route.model } },
    profiles: { ...document.profiles, [profileId]: { ...route.profile, modelId } }
  };
}

function isolateProfileConnection(document: SettingsDocumentV5, profileId: string): SettingsDocumentV5 {
  const modelDocument = isolateProfileModel(document, profileId);
  const route = resolveSettingsProfile(modelDocument, profileId);
  const shared = Object.entries(modelDocument.profiles).some(([id, profile]) => id !== profileId && modelDocument.models[profile.modelId]?.connectionId === route.model.connectionId);
  if (!shared) return modelDocument;
  const connectionId = nextRecordId(modelDocument.connections, "connection");
  const modelId = nextRecordId(modelDocument.models, "model");
  return {
    ...modelDocument,
    connections: { ...modelDocument.connections, [connectionId]: { ...route.connection } },
    models: { ...modelDocument.models, [modelId]: { ...route.model, connectionId } },
    profiles: { ...modelDocument.profiles, [profileId]: { ...route.profile, modelId } }
  };
}

function nextRecordId(records: Readonly<Record<string, unknown>>, prefix: string): string {
  for (let number = 1; ; number += 1) {
    const candidate = `${prefix}.${number}`;
    if (records[candidate] === undefined) return candidate;
  }
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

function optionalNumber(raw: string, min: number, max: number, integer = false): { value: number | null; error: string | null } {
  const text = raw.trim();
  if (text.length === 0) return { value: null, error: null };
  const value = Number(text);
  return Number.isFinite(value) && (!integer || Number.isSafeInteger(value)) && value >= min && value <= max
    ? { value, error: null }
    : { value: null, error: integer
      ? `Enter a whole number from ${min} to ${max}, or leave it blank.`
      : `Enter a number from ${min} to ${max}, or leave it blank.` };
}

function optionalInteger(raw: string, max: number): { value: number | null; error: string | null } {
  const text = raw.trim();
  if (text.length === 0) return { value: null, error: null };
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 1 && value <= max
    ? { value, error: null }
    : { value: null, error: `Enter a whole number from 1 to ${max}, or leave it blank.` };
}

function positiveInteger(raw: string, max: number): { value: number | null; error: string | null } {
  const value = optionalInteger(raw, max);
  return value.value === null ? { value: null, error: value.error ?? "Enter a positive whole number." } : value;
}

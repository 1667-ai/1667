import {
  FEATURE_SUPPORT_V2_VALUES,
  GENERATION_EFFORT_V2_VALUES,
  PROMPT_CACHE_POLICY_V2_VALUES,
  SETTINGS_PRESET_V2_VALUES,
  SETTINGS_PROTOCOL_V2_VALUES,
  type CredentialReferenceV2,
  type GenerationProfileV2,
  type ModelCapabilitiesV2,
  type ModelConnectionV2,
  type ModelDefinitionV2,
  type ModelScalarMetadataV2,
  type SettingsDocumentV2,
  type SettingsPresetV2,
  type SettingsProtocolV2
} from "../shared/settings-v2-types.js";
import { boundedArray, closedRecord, closedShape, literal } from "./story-wire-validation.js";
import {
  MAX_SETTINGS_AUTHOR_BRIEF_SCALARS,
  MAX_SETTINGS_CREDENTIAL_NAMES,
  MAX_SETTINGS_HEADERS,
  MAX_SETTINGS_NAME_SCALARS,
  MAX_SETTINGS_RECORDS,
  MAX_SETTINGS_REMOTE_ID_SCALARS,
  MAX_SETTINGS_TIMEOUT_MS,
  MAX_SETTINGS_TOKEN_COUNT,
  SettingsFormatError,
  classifyHttpHost,
  normalizeSettingsBaseUrl,
  requireBoundedSettingsString,
  requireCredentialName,
  requireFiniteTemperature,
  requireHeaderName,
  requirePositiveSettingsInteger,
  requireSecretId,
  requireSettingsId
} from "./settings-v2-scalars.js";

const DOCUMENT = closedShape(["schemaVersion", "connections", "models", "profiles", "routing", "writing"]);
const CONNECTION = closedShape(
  ["name", "preset", "protocol", "baseUrl", "auth", "headers", "timeouts"],
  ["allowInsecureHttp"]
);
const TIMEOUTS = closedShape(["responseHeaderMs", "firstTokenMs", "idleMs", "totalMs"]);
const AUTH_NONE = closedShape(["type"]);
const AUTH_BEARER = closedShape(["type", "env"]);
const AUTH_HEADER = closedShape(["type", "name", "env"]);
const AUTH_BEARER_STORED = closedShape(["type", "secretId"]);
const AUTH_HEADER_STORED = closedShape(["type", "name", "secretId"]);
const HEADER = closedShape(["name", "value"]);
const HEADER_VALUE = closedShape(["type", "env"]);
const MODEL = closedShape(["connectionId", "remoteId", "name", "discovered", "overrides", "capabilities"]);
const METADATA = closedShape([], ["contextWindow", "maxOutputTokens"]);
const CAPABILITIES = closedShape(["temperature", "assistantPrefill", "reasoningEffort", "promptCaching"]);
const PROFILE = closedShape(["name", "modelId", "temperature", "maxOutputTokens", "effort", "cachePolicy"]);
const ROUTING = closedShape(["default"], ["prose", "utility"]);
const WRITING = closedShape(["defaultAuthorBrief"]);

export interface SettingsValidationOptions {
  readonly environmentCaseInsensitive?: boolean;
}

export function validateSettingsDocumentV2(
  value: unknown,
  options: SettingsValidationOptions = {}
): SettingsDocumentV2 {
  const root = closedRecord(value, "settings document", DOCUMENT);
  literal(root.schemaVersion, 2, "settings document.schemaVersion");
  const credentialNames = new Set<string>();
  const caseInsensitive = options.environmentCaseInsensitive ?? process.platform === "win32";
  const connections = parseConnections(root.connections, credentialNames, caseInsensitive);
  const models = parseModels(root.models, connections);
  const profiles = parseProfiles(root.profiles, models);
  const routing = parseRouting(root.routing, profiles);
  const writing = closedRecord(root.writing, "settings document.writing", WRITING);
  const defaultAuthorBrief = requireBoundedSettingsString(
    writing.defaultAuthorBrief,
    "settings document.writing.defaultAuthorBrief",
    MAX_SETTINGS_AUTHOR_BRIEF_SCALARS,
    1
  );
  if (credentialNames.size > MAX_SETTINGS_CREDENTIAL_NAMES) {
    throw new SettingsFormatError(
      `settings document exceeds the ${MAX_SETTINGS_CREDENTIAL_NAMES}-credential-name limit`
    );
  }
  return {
    schemaVersion: 2,
    connections,
    models,
    profiles,
    routing,
    writing: { defaultAuthorBrief }
  };
}

function parseConnections(
  value: unknown,
  credentialNames: Set<string>,
  caseInsensitive: boolean
): Record<string, ModelConnectionV2> {
  const record = settingsMap(value, "settings document.connections");
  const result: Record<string, ModelConnectionV2> = {};
  for (const [id, raw] of Object.entries(record)) {
    requireSettingsId(id, "connection ID");
    const connection = closedRecord(raw, `connection ${id}`, CONNECTION);
    const preset = oneOf(connection.preset, SETTINGS_PRESET_V2_VALUES, `connection ${id}.preset`);
    const protocol = oneOf(connection.protocol, SETTINGS_PROTOCOL_V2_VALUES, `connection ${id}.protocol`);
    const auth = parseAuth(connection.auth, `connection ${id}.auth`, credentialNames, caseInsensitive);
    const headers = parseHeaders(connection.headers, `connection ${id}.headers`, credentialNames, caseInsensitive);
    if (
      (auth.type === "header-env" || auth.type === "header-stored")
      && headers.some((header) => header.name.toLowerCase() === auth.name.toLowerCase())
    ) {
      throw new SettingsFormatError(
        `connection ${id}.headers collides with authentication header ${auth.name}`
      );
    }
    const timeouts = parseTimeouts(connection.timeouts, `connection ${id}.timeouts`);
    const allowInsecureHttp = connection.allowInsecureHttp === undefined
      ? undefined
      : literal(connection.allowInsecureHttp, true, `connection ${id}.allowInsecureHttp`);
    const baseUrl = protocol === "dry-run"
      ? parseDryRunConnection(id, preset, connection.baseUrl, auth, headers, allowInsecureHttp)
      : parseNetworkConnection(id, preset, protocol, connection.baseUrl, auth, headers, allowInsecureHttp);
    result[id] = {
      name: requireBoundedSettingsString(connection.name, `connection ${id}.name`, MAX_SETTINGS_NAME_SCALARS, 1),
      preset,
      protocol,
      baseUrl,
      auth,
      headers,
      timeouts,
      ...(allowInsecureHttp === true ? { allowInsecureHttp: true as const } : {})
    };
  }
  return result;
}

function parseDryRunConnection(
  id: string,
  preset: SettingsPresetV2,
  baseUrl: unknown,
  auth: CredentialReferenceV2,
  headers: readonly unknown[],
  allowInsecureHttp: true | undefined
): null {
  if (preset !== "dry-run" || baseUrl !== null || auth.type !== "none" || headers.length !== 0) {
    throw new SettingsFormatError(
      `connection ${id} dry-run protocol requires dry-run preset, null URL, no authentication, and no headers`
    );
  }
  if (allowInsecureHttp !== undefined) {
    throw new SettingsFormatError(`connection ${id}.allowInsecureHttp is invalid for dry-run`);
  }
  return null;
}

function parseNetworkConnection(
  id: string,
  preset: SettingsPresetV2,
  protocol: Exclude<SettingsProtocolV2, "dry-run">,
  rawUrl: unknown,
  auth: CredentialReferenceV2,
  headers: readonly unknown[],
  allowInsecureHttp: true | undefined
): string {
  if (preset === "dry-run") throw new SettingsFormatError(`connection ${id} dry-run preset requires dry-run protocol`);
  if (preset === "anthropic" && protocol !== "anthropic-messages") {
    throw new SettingsFormatError(`connection ${id} anthropic preset requires anthropic-messages`);
  }
  if (preset !== "anthropic" && preset !== "custom" && protocol !== "openai-chat-completions") {
    throw new SettingsFormatError(`connection ${id} preset requires openai-chat-completions`);
  }
  const baseUrl = normalizeSettingsBaseUrl(rawUrl, `connection ${id}.baseUrl`);
  const parsed = new URL(baseUrl);
  if (parsed.protocol === "https:") {
    if (allowInsecureHttp !== undefined) {
      throw new SettingsFormatError(`connection ${id}.allowInsecureHttp is only valid for LAN HTTP`);
    }
    return baseUrl;
  }
  if (auth.type !== "none" || headers.length !== 0) {
    throw new SettingsFormatError(`connection ${id} plain HTTP cannot carry authentication or secret headers`);
  }
  const hostClass = classifyHttpHost(baseUrl);
  if (hostClass === "loopback" && allowInsecureHttp === undefined) return baseUrl;
  if (
    (hostClass === "private-literal" || hostClass === "lan-hostname")
    && allowInsecureHttp === true
  ) return baseUrl;
  throw new SettingsFormatError(
    `connection ${id} plain HTTP requires loopback or allowInsecureHttp on a LAN host`
  );
}

function parseAuth(
  value: unknown,
  label: string,
  names: Set<string>,
  caseInsensitive: boolean
): CredentialReferenceV2 {
  const candidate = value as Record<string, unknown> | null;
  if (candidate?.type === "none") {
    closedRecord(value, label, AUTH_NONE);
    return { type: "none" };
  }
  if (candidate?.type === "bearer-env") {
    const auth = closedRecord(value, label, AUTH_BEARER);
    return { type: "bearer-env", env: credential(auth.env, `${label}.env`, names, caseInsensitive) };
  }
  if (candidate?.type === "header-env") {
    const auth = closedRecord(value, label, AUTH_HEADER);
    return {
      type: "header-env",
      name: requireHeaderName(auth.name, `${label}.name`),
      env: credential(auth.env, `${label}.env`, names, caseInsensitive)
    };
  }
  if (candidate?.type === "bearer-stored") {
    const auth = closedRecord(value, label, AUTH_BEARER_STORED);
    const secretId = requireSecretId(auth.secretId, `${label}.secretId`);
    names.add(`stored:${secretId}`);
    return {
      type: "bearer-stored",
      secretId
    };
  }
  if (candidate?.type === "header-stored") {
    const auth = closedRecord(value, label, AUTH_HEADER_STORED);
    const secretId = requireSecretId(auth.secretId, `${label}.secretId`);
    names.add(`stored:${secretId}`);
    return {
      type: "header-stored",
      name: requireHeaderName(auth.name, `${label}.name`),
      secretId
    };
  }
  throw new SettingsFormatError(`${label}.type is invalid`);
}

function parseHeaders(
  value: unknown,
  label: string,
  names: Set<string>,
  caseInsensitive: boolean
): ModelConnectionV2["headers"] {
  const values = boundedArray(value, label, MAX_SETTINGS_HEADERS);
  const seen = new Set<string>();
  return values.map((raw, index) => {
    const header = closedRecord(raw, `${label}[${index}]`, HEADER);
    const name = requireHeaderName(header.name, `${label}[${index}].name`);
    const compared = name.toLowerCase();
    if (seen.has(compared)) throw new SettingsFormatError(`${label} repeats header ${name}`);
    seen.add(compared);
    const reference = closedRecord(header.value, `${label}[${index}].value`, HEADER_VALUE);
    literal(reference.type, "env", `${label}[${index}].value.type`);
    return {
      name,
      value: {
        type: "env" as const,
        env: credential(reference.env, `${label}[${index}].value.env`, names, caseInsensitive)
      }
    };
  });
}

function parseTimeouts(value: unknown, label: string): ModelConnectionV2["timeouts"] {
  const raw = closedRecord(value, label, TIMEOUTS);
  const result = {
    responseHeaderMs: requirePositiveSettingsInteger(
      raw.responseHeaderMs,
      `${label}.responseHeaderMs`,
      MAX_SETTINGS_TIMEOUT_MS
    ),
    firstTokenMs: requirePositiveSettingsInteger(raw.firstTokenMs, `${label}.firstTokenMs`, MAX_SETTINGS_TIMEOUT_MS),
    idleMs: requirePositiveSettingsInteger(raw.idleMs, `${label}.idleMs`, MAX_SETTINGS_TIMEOUT_MS),
    totalMs: requirePositiveSettingsInteger(raw.totalMs, `${label}.totalMs`, MAX_SETTINGS_TIMEOUT_MS)
  };
  if (result.totalMs < Math.max(result.responseHeaderMs, result.firstTokenMs, result.idleMs)) {
    throw new SettingsFormatError(`${label}.totalMs must not be shorter than an individual deadline`);
  }
  return result;
}

function parseModels(
  value: unknown,
  connections: Readonly<Record<string, ModelConnectionV2>>
): Record<string, ModelDefinitionV2> {
  const record = settingsMap(value, "settings document.models");
  const result: Record<string, ModelDefinitionV2> = {};
  for (const [id, raw] of Object.entries(record)) {
    requireSettingsId(id, "model ID");
    const model = closedRecord(raw, `model ${id}`, MODEL);
    const connectionId = requireSettingsId(model.connectionId, `model ${id}.connectionId`);
    if (!Object.hasOwn(connections, connectionId)) {
      throw new SettingsFormatError(`model ${id}.connectionId does not resolve`);
    }
    result[id] = {
      connectionId,
      remoteId: requireBoundedSettingsString(model.remoteId, `model ${id}.remoteId`, MAX_SETTINGS_REMOTE_ID_SCALARS),
      name: requireBoundedSettingsString(model.name, `model ${id}.name`, MAX_SETTINGS_NAME_SCALARS, 1),
      discovered: parseMetadata(model.discovered, `model ${id}.discovered`),
      overrides: parseMetadata(model.overrides, `model ${id}.overrides`),
      capabilities: parseCapabilities(model.capabilities, `model ${id}.capabilities`)
    };
  }
  return result;
}

function parseMetadata(value: unknown, label: string): ModelScalarMetadataV2 {
  const metadata = closedRecord(value, label, METADATA);
  return {
    ...(metadata.contextWindow === undefined ? {} : {
      contextWindow: requirePositiveSettingsInteger(
        metadata.contextWindow,
        `${label}.contextWindow`,
        MAX_SETTINGS_TOKEN_COUNT
      )
    }),
    ...(metadata.maxOutputTokens === undefined ? {} : {
      maxOutputTokens: requirePositiveSettingsInteger(
        metadata.maxOutputTokens,
        `${label}.maxOutputTokens`,
        MAX_SETTINGS_TOKEN_COUNT
      )
    })
  };
}

function parseCapabilities(value: unknown, label: string): ModelCapabilitiesV2 {
  const capabilities = closedRecord(value, label, CAPABILITIES);
  return {
    temperature: oneOf(capabilities.temperature, FEATURE_SUPPORT_V2_VALUES, `${label}.temperature`),
    assistantPrefill: oneOf(capabilities.assistantPrefill, FEATURE_SUPPORT_V2_VALUES, `${label}.assistantPrefill`),
    reasoningEffort: oneOf(capabilities.reasoningEffort, FEATURE_SUPPORT_V2_VALUES, `${label}.reasoningEffort`),
    promptCaching: oneOf(capabilities.promptCaching, FEATURE_SUPPORT_V2_VALUES, `${label}.promptCaching`)
  };
}

function parseProfiles(
  value: unknown,
  models: Readonly<Record<string, ModelDefinitionV2>>
): Record<string, GenerationProfileV2> {
  const record = settingsMap(value, "settings document.profiles");
  const result: Record<string, GenerationProfileV2> = {};
  for (const [id, raw] of Object.entries(record)) {
    requireSettingsId(id, "profile ID");
    const profile = closedRecord(raw, `profile ${id}`, PROFILE);
    const modelId = requireSettingsId(profile.modelId, `profile ${id}.modelId`);
    const model = models[modelId];
    if (!Object.hasOwn(models, modelId) || model === undefined) {
      throw new SettingsFormatError(`profile ${id}.modelId does not resolve`);
    }
    const temperature = requireFiniteTemperature(profile.temperature, `profile ${id}.temperature`);
    const effort = oneOf(profile.effort, GENERATION_EFFORT_V2_VALUES, `profile ${id}.effort`);
    if (temperature !== null && model.capabilities.temperature === "unsupported") {
      throw new SettingsFormatError(`profile ${id} sets temperature for an unsupported model`);
    }
    if (effort !== "default" && model.capabilities.reasoningEffort !== "supported") {
      throw new SettingsFormatError(`profile ${id} sets effort without explicit model support`);
    }
    result[id] = {
      name: requireBoundedSettingsString(profile.name, `profile ${id}.name`, MAX_SETTINGS_NAME_SCALARS, 1),
      modelId,
      temperature,
      maxOutputTokens: requirePositiveSettingsInteger(
        profile.maxOutputTokens,
        `profile ${id}.maxOutputTokens`,
        MAX_SETTINGS_TOKEN_COUNT
      ),
      effort,
      cachePolicy: oneOf(profile.cachePolicy, PROMPT_CACHE_POLICY_V2_VALUES, `profile ${id}.cachePolicy`)
    };
  }
  return result;
}

function parseRouting(
  value: unknown,
  profiles: Readonly<Record<string, GenerationProfileV2>>
): SettingsDocumentV2["routing"] {
  const routing = closedRecord(value, "settings document.routing", ROUTING);
  const result: { default: string; prose?: string; utility?: string } = {
    default: routeReference(routing.default, "settings document.routing.default", profiles)
  };
  if (routing.prose !== undefined) {
    result.prose = routeReference(routing.prose, "settings document.routing.prose", profiles);
  }
  if (routing.utility !== undefined) {
    result.utility = routeReference(routing.utility, "settings document.routing.utility", profiles);
  }
  return result;
}

function settingsMap(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SettingsFormatError(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const count = Object.keys(record).length;
  if (count < 1 || count > MAX_SETTINGS_RECORDS) {
    throw new SettingsFormatError(`${label} must contain 1..${MAX_SETTINGS_RECORDS} entries`);
  }
  return record;
}

function credential(
  value: unknown,
  label: string,
  names: Set<string>,
  caseInsensitive: boolean
): string {
  const name = requireCredentialName(value, label, caseInsensitive);
  names.add(caseInsensitive ? name.toUpperCase() : name);
  return name;
}

function routeReference(
  value: unknown,
  label: string,
  profiles: Readonly<Record<string, GenerationProfileV2>>
): string {
  const id = requireSettingsId(value, label);
  if (!Object.hasOwn(profiles, id)) throw new SettingsFormatError(`${label} does not resolve`);
  return id;
}

function oneOf<const T extends readonly string[]>(value: unknown, choices: T, label: string): T[number] {
  if (typeof value !== "string" || !(choices as readonly string[]).includes(value)) {
    throw new SettingsFormatError(`${label} must be one of ${choices.join(" | ")}`);
  }
  return value as T[number];
}

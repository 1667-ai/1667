import {
  FEATURE_SUPPORT_V2_VALUES,
  type GenerationProfileV2,
  type ModelCapabilitiesV2,
  type ModelConnectionV2,
  type ModelDefinitionV2,
  type SettingsDocumentV2
} from "../shared/settings-v2-types.js";
import { closedRecord, closedShape, literal } from "./story-wire-validation.js";
import { parseProfiles } from "./settings-v2-profile-validation.js";
import { parseConnections, parseMetadata } from "../shared/settings-v2-connection-validation.js";
export { parseConnections, parseMetadata } from "../shared/settings-v2-connection-validation.js";
import { settingsMap } from "./settings-v2-validation-record.js";
import { oneOf } from "./settings-v2-validation-values.js";
import {
  MAX_SETTINGS_AUTHOR_BRIEF_SCALARS,
  MAX_SETTINGS_CREDENTIAL_NAMES,
  MAX_SETTINGS_NAME_SCALARS,
  MAX_SETTINGS_REMOTE_ID_SCALARS,
  MAX_SETTINGS_TOKEN_COUNT,
  SettingsFormatError,
  requireBoundedSettingsString,
  requirePositiveSettingsInteger,
  requireSettingsId
} from "./settings-v2-scalars.js";

const DOCUMENT = closedShape(["schemaVersion", "connections", "models", "profiles", "routing", "writing"]);
const MODEL = closedShape(["connectionId", "remoteId", "name", "discovered", "overrides", "capabilities"]);
const CAPABILITIES = closedShape(
  ["temperature", "assistantPrefill", "reasoningEffort", "promptCaching"],
  ["reasoningContent"]
);
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
  const profiles = parseProfiles(root.profiles, models, connections);
  const routing = parseRouting(root.routing, profiles);
  const writing = closedRecord(root.writing, "settings document.writing", WRITING);
  // Empty is a real choice: `renderContinuationPlan` already omits the system
  // block for a blank brief, so nothing downstream needs one. The minimum was
  // the only thing refusing a writer who wants the model unsteered.
  const defaultAuthorBrief = requireBoundedSettingsString(
    writing.defaultAuthorBrief,
    "settings document.writing.defaultAuthorBrief",
    MAX_SETTINGS_AUTHOR_BRIEF_SCALARS
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

/** Exported for reuse by server/settings-v3-validation.ts: connections,
 *  profiles, routing, and scalar metadata are identical between schema 2 and
 *  schema 3, so only the model/capabilities parser differs between them. */
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

function parseCapabilities(value: unknown, label: string): ModelCapabilitiesV2 {
  const capabilities = closedRecord(value, label, CAPABILITIES);
  const reasoningContent = capabilities.reasoningContent === undefined
    ? undefined
    : oneOf(capabilities.reasoningContent, FEATURE_SUPPORT_V2_VALUES, `${label}.reasoningContent`);
  return {
    temperature: oneOf(capabilities.temperature, FEATURE_SUPPORT_V2_VALUES, `${label}.temperature`),
    assistantPrefill: oneOf(capabilities.assistantPrefill, FEATURE_SUPPORT_V2_VALUES, `${label}.assistantPrefill`),
    reasoningEffort: oneOf(capabilities.reasoningEffort, FEATURE_SUPPORT_V2_VALUES, `${label}.reasoningEffort`),
    promptCaching: oneOf(capabilities.promptCaching, FEATURE_SUPPORT_V2_VALUES, `${label}.promptCaching`),
    ...(reasoningContent === undefined ? {} : { reasoningContent })
  };
}

export { parseProfiles } from "./settings-v2-profile-validation.js";

export function parseRouting(
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

export { settingsMap } from "./settings-v2-validation-record.js";

function routeReference(
  value: unknown,
  label: string,
  profiles: Readonly<Record<string, GenerationProfileV2>>
): string {
  const id = requireSettingsId(value, label);
  if (!Object.hasOwn(profiles, id)) throw new SettingsFormatError(`${label} does not resolve`);
  return id;
}

export { oneOf } from "./settings-v2-validation-values.js";

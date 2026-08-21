import {
  FEATURE_SUPPORT_V2_VALUES,
  type ModelCapabilitiesV3,
  type ModelDefinitionV3,
  type SettingsDocumentV3
} from "../shared/settings-v2-types.js";
import { closedRecord, closedShape, literal } from "./story-wire-validation.js";
import {
  oneOf,
  parseConnections,
  parseMetadata,
  parseProfiles,
  parseRouting,
  settingsMap,
  type SettingsValidationOptions
} from "./settings-v2-validation.js";
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

export type { SettingsValidationOptions };

/** Schema 3's document codec. Structural sibling of
 * server/settings-v2-validation.ts's `validateSettingsDocumentV2`: it reuses
 * that module's connection, profile, routing, and metadata parsers verbatim
 * (identical between the two schemas) and supplies only what differs:
 * models and capabilities, where `imageInput` is required. This release
 * reads and validates schema 3; nothing here writes one. */

const DOCUMENT = closedShape(["schemaVersion", "connections", "models", "profiles", "routing", "writing"]);
const MODEL = closedShape(["connectionId", "remoteId", "name", "discovered", "overrides", "capabilities"]);
const CAPABILITIES = closedShape(
  ["temperature", "assistantPrefill", "reasoningEffort", "promptCaching", "imageInput"],
  ["reasoningContent", "imageTokenCeiling"]
);
const WRITING = closedShape(["defaultAuthorBrief"]);

export function validateSettingsDocumentV3(
  value: unknown,
  options: SettingsValidationOptions = {}
): SettingsDocumentV3 {
  const root = closedRecord(value, "settings document", DOCUMENT);
  literal(root.schemaVersion, 3, "settings document.schemaVersion");
  const credentialNames = new Set<string>();
  const caseInsensitive = options.environmentCaseInsensitive ?? process.platform === "win32";
  const connections = parseConnections(root.connections, credentialNames, caseInsensitive);
  const models = parseModelsV3(root.models, connections);
  const profiles = parseProfiles(root.profiles, models, connections);
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
    schemaVersion: 3,
    connections,
    models,
    profiles,
    routing,
    writing: { defaultAuthorBrief }
  };
}

/** Parse the model and capability records shared by schema 3 and schema 4. */
export function parseModelsV3(
  value: unknown,
  connections: Readonly<Record<string, unknown>>
): Record<string, ModelDefinitionV3> {
  const record = settingsMap(value, "settings document.models");
  const result: Record<string, ModelDefinitionV3> = {};
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
      capabilities: parseCapabilitiesV3(model.capabilities, `model ${id}.capabilities`)
    };
  }
  return result;
}

/** `imageTokenCeiling` is valid only when `imageInput` is `"supported"`. This
 *  is a cross-field rule the JSON Schema `closed()` helper cannot express
 *  (no `dependentRequired`), so it is enforced only here. A document that
 *  carries a ceiling without `"supported"` is schema-valid and codec-invalid,
 *  the same shape as `document-reasoning-on-model-returning-none`. */
function parseCapabilitiesV3(value: unknown, label: string): ModelCapabilitiesV3 {
  const capabilities = closedRecord(value, label, CAPABILITIES);
  const reasoningContent = capabilities.reasoningContent === undefined
    ? undefined
    : oneOf(capabilities.reasoningContent, FEATURE_SUPPORT_V2_VALUES, `${label}.reasoningContent`);
  const imageInput = oneOf(capabilities.imageInput, FEATURE_SUPPORT_V2_VALUES, `${label}.imageInput`);
  const imageTokenCeiling = capabilities.imageTokenCeiling === undefined
    ? undefined
    : requirePositiveSettingsInteger(
        capabilities.imageTokenCeiling,
        `${label}.imageTokenCeiling`,
        MAX_SETTINGS_TOKEN_COUNT
      );
  if (imageTokenCeiling !== undefined && imageInput !== "supported") {
    throw new SettingsFormatError(`${label}.imageTokenCeiling requires imageInput to be "supported"`);
  }
  return {
    temperature: oneOf(capabilities.temperature, FEATURE_SUPPORT_V2_VALUES, `${label}.temperature`),
    assistantPrefill: oneOf(capabilities.assistantPrefill, FEATURE_SUPPORT_V2_VALUES, `${label}.assistantPrefill`),
    reasoningEffort: oneOf(capabilities.reasoningEffort, FEATURE_SUPPORT_V2_VALUES, `${label}.reasoningEffort`),
    promptCaching: oneOf(capabilities.promptCaching, FEATURE_SUPPORT_V2_VALUES, `${label}.promptCaching`),
    imageInput,
    ...(reasoningContent === undefined ? {} : { reasoningContent }),
    ...(imageTokenCeiling === undefined ? {} : { imageTokenCeiling })
  };
}

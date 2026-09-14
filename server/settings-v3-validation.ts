import type { SettingsDocumentV3 } from "../shared/settings-v2-types.js";
import { closedRecord, closedShape, literal } from "./story-wire-validation.js";
import {
  parseConnections,
  parseProfiles,
  parseRouting,
  type SettingsValidationOptions
} from "./settings-v2-validation.js";
import { parseModelsV3 } from "../shared/settings-v3-model-validation.js";
export { parseModelsV3 } from "../shared/settings-v3-model-validation.js";
import {
  MAX_SETTINGS_AUTHOR_BRIEF_SCALARS,
  MAX_SETTINGS_CREDENTIAL_NAMES,
  SettingsFormatError,
  requireBoundedSettingsString
} from "./settings-v2-scalars.js";

export type { SettingsValidationOptions };

/** Schema 3's document codec. Structural sibling of
 * server/settings-v2-validation.ts's `validateSettingsDocumentV2`: it reuses
 * that module's connection, profile, routing, and metadata parsers verbatim
 * (identical between the two schemas) and supplies only what differs:
 * models and capabilities, where `imageInput` is required. This release
 * reads and validates schema 3; nothing here writes one. */

const DOCUMENT = closedShape(["schemaVersion", "connections", "models", "profiles", "routing", "writing"]);
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

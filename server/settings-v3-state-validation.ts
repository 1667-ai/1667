import {
  type SettingsDocumentV3,
  type SettingsStateV3
} from "../shared/settings-v2-types.js";
import { hashCanonicalSettingsDocument } from "./settings-v2-hash.js";
import { INITIAL_SETTINGS_DOCUMENT_V3_HASH } from "./settings-v3-initial-vectors.js";
import {
  validateSettingsState,
  type SettingsStateSchema
} from "./settings-state-validation.js";
import { validateSettingsDocumentV3, type SettingsValidationOptions } from "./settings-v3-validation.js";

/**
 * Schema 3's aggregate state codec. It supplies only what differs from
 * schema 2: how to validate a schema-3 document, how to hash one, and the
 * hash of the exact canonical schema-3 initial document. Every other rule
 * (`server/settings-state-validation.ts`) is version-free and shared, so
 * this module has nothing left to duplicate.
 */
const SETTINGS_STATE_V3_SCHEMA: SettingsStateSchema<3, SettingsDocumentV3> = {
  schemaVersion: 3,
  validateDocument: validateSettingsDocumentV3,
  hashDocument: hashCanonicalSettingsDocument,
  initialDocumentHash: INITIAL_SETTINGS_DOCUMENT_V3_HASH
};

export function validateSettingsStateV3(
  value: unknown,
  options: SettingsValidationOptions = {}
): SettingsStateV3 {
  return validateSettingsState(value, SETTINGS_STATE_V3_SCHEMA, options);
}

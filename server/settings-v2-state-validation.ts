import {
  type SettingsDocumentV2,
  type SettingsStateV2
} from "../shared/settings-v2-types.js";
import { hashCanonicalSettingsDocument } from "./settings-v2-hash.js";
import { INITIAL_SETTINGS_DOCUMENT_V2_HASH } from "./settings-v2-initial-vectors.js";
import {
  validateSettingsState,
  type SettingsStateSchema
} from "./settings-state-validation.js";
import { validateSettingsDocumentV2, type SettingsValidationOptions } from "./settings-v2-validation.js";

/**
 * Schema 2's aggregate state codec. It supplies only what differs from
 * schema 3: how to validate a schema-2 document, how to hash one, and the
 * hash of the exact canonical schema-2 initial document. Every other rule
 * (`server/settings-state-validation.ts`) is version-free and shared, so
 * this module has nothing left to duplicate.
 */
const SETTINGS_STATE_V2_SCHEMA: SettingsStateSchema<2, SettingsDocumentV2> = {
  schemaVersion: 2,
  validateDocument: validateSettingsDocumentV2,
  hashDocument: hashCanonicalSettingsDocument,
  initialDocumentHash: INITIAL_SETTINGS_DOCUMENT_V2_HASH
};

export function validateSettingsStateV2(
  value: unknown,
  options: SettingsValidationOptions = {}
): SettingsStateV2 {
  return validateSettingsState(value, SETTINGS_STATE_V2_SCHEMA, options);
}

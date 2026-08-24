import type { SettingsDocumentV4, SettingsStateV4 } from "../shared/settings-v4-types.js";
import { hashCanonicalSettingsDocument } from "./settings-v2-hash.js";
import { INITIAL_SETTINGS_DOCUMENT_V4_HASH } from "./settings-v4-initial-vectors.js";
import {
  settingsStateEnvelopeBytes,
  effectiveSettingsStateRevision,
  settingsStateRelation,
  validateSettingsState,
  type SettingsStateRelation,
  type SettingsStateSchema
} from "./settings-state-validation.js";
import { validateSettingsDocumentV4, type SettingsValidationOptions } from "./settings-v4-validation.js";

/** Schema 4 supplies only its document validator and initial hash. The
 *  envelope rules stay shared with schemas 2 and 3 so state recovery cannot
 *  drift across release boundaries. */
const SETTINGS_STATE_V4_SCHEMA: SettingsStateSchema<4, SettingsDocumentV4> = {
  schemaVersion: 4,
  validateDocument: validateSettingsDocumentV4,
  hashDocument: hashCanonicalSettingsDocument,
  initialDocumentHash: INITIAL_SETTINGS_DOCUMENT_V4_HASH
};

export function validateSettingsStateV4(
  value: unknown,
  options: SettingsValidationOptions = {}
): SettingsStateV4 {
  return validateSettingsState(value, SETTINGS_STATE_V4_SCHEMA, options);
}

export type SettingsStateRelationV4 = SettingsStateRelation;

export function settingsStateRelationV4(state: SettingsStateV4): SettingsStateRelationV4 {
  return settingsStateRelation(state);
}

/** Return the document that readers may use at this activation phase. */
export function activeSettingsDocumentV4(state: SettingsStateV4): SettingsDocumentV4 {
  const revision = effectiveSettingsStateRevision(state);
  return state.documents[String(revision)]!;
}

export function settingsStateEnvelopeBytesV4(state: SettingsStateV4): number {
  return settingsStateEnvelopeBytes(state);
}

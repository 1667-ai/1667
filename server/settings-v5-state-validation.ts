import type { SettingsDocumentV5, SettingsStateV5 } from "../shared/settings-v5-types.js";
import { MAX_SETTINGS_DOCUMENT_V5_BYTES } from "../shared/settings-v5-limits.js";
import { hashCanonicalSettingsDocument } from "./settings-v2-hash.js";
import { INITIAL_SETTINGS_DOCUMENT_V5_HASH } from "./settings-v5-initial-vectors.js";
import {
  settingsStateEnvelopeBytes,
  effectiveSettingsStateRevision,
  settingsStateRelation,
  validateSettingsState,
  type SettingsStateRelation,
  type SettingsStateSchema
} from "./settings-state-validation.js";
import { validateSettingsDocumentV5, type SettingsValidationOptions } from "./settings-v5-validation.js";

const SETTINGS_STATE_V5_SCHEMA: SettingsStateSchema<5, SettingsDocumentV5> = {
  schemaVersion: 5,
  validateDocument: validateSettingsDocumentV5,
  hashDocument: hashCanonicalSettingsDocument,
  initialDocumentHash: INITIAL_SETTINGS_DOCUMENT_V5_HASH,
  maxDocumentBytes: MAX_SETTINGS_DOCUMENT_V5_BYTES
};

export function validateSettingsStateV5(
  value: unknown,
  options: SettingsValidationOptions = {}
): SettingsStateV5 {
  return validateSettingsState(value, SETTINGS_STATE_V5_SCHEMA, options);
}

export type SettingsStateRelationV5 = SettingsStateRelation;

export function settingsStateRelationV5(state: SettingsStateV5): SettingsStateRelationV5 {
  return settingsStateRelation(state);
}

export function activeSettingsDocumentV5(state: SettingsStateV5): SettingsDocumentV5 {
  const revision = effectiveSettingsStateRevision(state);
  return state.documents[String(revision)]!;
}

export function settingsStateEnvelopeBytesV5(state: SettingsStateV5): number {
  return settingsStateEnvelopeBytes(state);
}

import type { SettingsDocumentV3, SettingsStateV3 } from "../shared/settings-v2-types.js";
import {
  assertNfcJsonStrings,
  canonicalJson
} from "./canonical-json.js";
import { hashSettingsDocumentV2Bytes, hashSettingsStateV2Bytes } from "./settings-v2-hash.js";
import {
  MAX_SETTINGS_DOCUMENT_BYTES,
  MAX_SETTINGS_STATE_BYTES,
  SettingsFormatError
} from "./settings-v2-scalars.js";
import { settingsStateEnvelopeBytes } from "./settings-v2-state-validation.js";
import { validateSettingsStateV3 } from "./settings-v3-state-validation.js";
import {
  validateSettingsDocumentV3,
  type SettingsValidationOptions
} from "./settings-v3-validation.js";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";
import {
  assertSettingsDocumentSize,
  assertSettingsStateSize,
  deepFreezeSettings,
  encodeSettingsText,
  settingsCodecError
} from "./settings-codec-shared.js";

/** Schema 3's parse/format/hash surface. Structural sibling of
 * server/settings-v2-codec.ts, sharing its size, encode, freeze, and error
 * helpers (`server/settings-codec-shared.ts`) and its document/state hash
 * bytes functions (`server/settings-v2-hash.ts`): the hash domain separates
 * settings hashes from every other hashed kind, not one schema version from
 * another, so schema 3 hashes through the same bytes functions schema 2
 * does. This release only reads and validates through this module; nothing
 * writes a schema-3 document or state to disk
 * (`shared/image-input-release.ts`). */

export function parseSettingsDocumentV3(
  value: unknown,
  options: SettingsValidationOptions = {}
): SettingsDocumentV3 {
  try {
    assertNfcJsonStrings(value, "settings document");
    const document = validateSettingsDocumentV3(value, options);
    assertSettingsDocumentSize(canonicalJson(document));
    return deepFreezeSettings(document);
  } catch (error) {
    throw settingsCodecError("Settings document is invalid", error);
  }
}

export function parseSettingsDocumentV3Text(
  text: string,
  options: SettingsValidationOptions = {}
): SettingsDocumentV3 {
  const bytes = encodeSettingsText(text, "settings document");
  if (bytes.byteLength > MAX_SETTINGS_DOCUMENT_BYTES) {
    throw new SettingsFormatError(
      `Settings document exceeds its ${MAX_SETTINGS_DOCUMENT_BYTES}-byte size limit`
    );
  }
  const value = parseJsonRejectingDuplicateKeys(text, "settings document");
  const document = parseSettingsDocumentV3(value, options);
  if (canonicalJson(value) !== text) throw new SettingsFormatError("Settings document is not canonical JSON");
  return document;
}

/** Formatting validates shape, semantics, NFC, canonical bytes, and size. */
export function formatSettingsDocumentV3(document: SettingsDocumentV3): string {
  try {
    const parsed = parseSettingsDocumentV3(document);
    const text = canonicalJson(parsed);
    assertSettingsDocumentSize(text);
    return text;
  } catch (error) {
    throw settingsCodecError("Settings document cannot be formatted", error);
  }
}

export function formatSettingsDocumentV3Bytes(document: SettingsDocumentV3): Uint8Array {
  return Buffer.from(formatSettingsDocumentV3(document), "utf8");
}

export function hashSettingsDocumentV3(document: SettingsDocumentV3): string {
  return hashSettingsDocumentV2Bytes(formatSettingsDocumentV3Bytes(document));
}

export function parseSettingsStateV3(
  value: unknown,
  options: SettingsValidationOptions = {}
): SettingsStateV3 {
  try {
    assertNfcJsonStrings(value, "settings state");
    const state = validateSettingsStateV3(value, options);
    const text = canonicalJson(state);
    assertSettingsStateSize(text);
    settingsStateEnvelopeBytes(state);
    return deepFreezeSettings(state);
  } catch (error) {
    throw settingsCodecError("Settings state is invalid", error);
  }
}

export function parseSettingsStateV3Text(
  text: string,
  options: SettingsValidationOptions = {}
): SettingsStateV3 {
  const bytes = encodeSettingsText(text, "settings state");
  if (bytes.byteLength > MAX_SETTINGS_STATE_BYTES) {
    throw new SettingsFormatError(`Settings state exceeds its ${MAX_SETTINGS_STATE_BYTES}-byte size limit`);
  }
  const value = parseJsonRejectingDuplicateKeys(text, "settings state");
  const state = parseSettingsStateV3(value, options);
  if (canonicalJson(value) !== text) throw new SettingsFormatError("Settings state is not canonical JSON");
  return state;
}

export function formatSettingsStateV3(state: SettingsStateV3): string {
  try {
    const parsed = parseSettingsStateV3(state);
    const text = canonicalJson(parsed);
    assertSettingsStateSize(text);
    return text;
  } catch (error) {
    throw settingsCodecError("Settings state cannot be formatted", error);
  }
}

export function hashSettingsStateV3(state: SettingsStateV3): string {
  return hashSettingsStateV2Bytes(Buffer.from(formatSettingsStateV3(state), "utf8"));
}

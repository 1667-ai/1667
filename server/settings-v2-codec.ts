import type { SettingsDocumentV2, SettingsStateV2 } from "../shared/settings-v2-types.js";
import {
  assertNfcJsonStrings,
  canonicalJson
} from "./canonical-json.js";
import {
  hashSettingsDocumentV2Bytes,
  hashSettingsStateV2Bytes
} from "./settings-v2-hash.js";
import { MAX_SETTINGS_DOCUMENT_BYTES, MAX_SETTINGS_STATE_BYTES, SettingsFormatError } from "./settings-v2-scalars.js";
import {
  settingsStateEnvelopeBytes,
  validateSettingsStateV2
} from "./settings-v2-state-validation.js";
import {
  validateSettingsDocumentV2,
  type SettingsValidationOptions
} from "./settings-v2-validation.js";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";
import {
  assertSettingsDocumentSize,
  assertSettingsStateSize,
  decodeSettingsBytes,
  deepFreezeSettings,
  encodeSettingsText,
  settingsCodecError
} from "./settings-codec-shared.js";

export function parseSettingsDocumentV2(
  value: unknown,
  options: SettingsValidationOptions = {}
): SettingsDocumentV2 {
  try {
    assertNfcJsonStrings(value, "settings document");
    const document = validateSettingsDocumentV2(value, options);
    assertSettingsDocumentSize(canonicalJson(document));
    return deepFreezeSettings(document);
  } catch (error) {
    throw settingsCodecError("Settings document is invalid", error);
  }
}

export function parseSettingsDocumentV2Bytes(
  bytes: Uint8Array,
  options: SettingsValidationOptions = {}
): SettingsDocumentV2 {
  if (bytes.byteLength > MAX_SETTINGS_DOCUMENT_BYTES) {
    throw new SettingsFormatError(
      `Settings document exceeds its ${MAX_SETTINGS_DOCUMENT_BYTES}-byte size limit`
    );
  }
  return parseSettingsDocumentV2Text(decodeSettingsBytes(bytes, "settings document"), options);
}

export function parseSettingsDocumentV2Text(
  text: string,
  options: SettingsValidationOptions = {}
): SettingsDocumentV2 {
  const bytes = encodeSettingsText(text, "settings document");
  if (bytes.byteLength > MAX_SETTINGS_DOCUMENT_BYTES) {
    throw new SettingsFormatError(
      `Settings document exceeds its ${MAX_SETTINGS_DOCUMENT_BYTES}-byte size limit`
    );
  }
  const value = parseJsonRejectingDuplicateKeys(text, "settings document");
  const document = parseSettingsDocumentV2(value, options);
  if (canonicalJson(value) !== text) throw new SettingsFormatError("Settings document is not canonical JSON");
  return document;
}

/** Formatting validates shape, semantics, NFC, canonical bytes, and size. */
export function formatSettingsDocumentV2(document: SettingsDocumentV2): string {
  try {
    const parsed = parseSettingsDocumentV2(document);
    const text = canonicalJson(parsed);
    assertSettingsDocumentSize(text);
    return text;
  } catch (error) {
    throw settingsCodecError("Settings document cannot be formatted", error);
  }
}

export function formatSettingsDocumentV2Bytes(document: SettingsDocumentV2): Uint8Array {
  return Buffer.from(formatSettingsDocumentV2(document), "utf8");
}

export function hashSettingsDocumentV2(document: SettingsDocumentV2): string {
  return hashSettingsDocumentV2Bytes(formatSettingsDocumentV2Bytes(document));
}

export function parseSettingsStateV2(
  value: unknown,
  options: SettingsValidationOptions = {}
): SettingsStateV2 {
  try {
    assertNfcJsonStrings(value, "settings state");
    const state = validateSettingsStateV2(value, options);
    const text = canonicalJson(state);
    assertSettingsStateSize(text);
    settingsStateEnvelopeBytes(state);
    return deepFreezeSettings(state);
  } catch (error) {
    throw settingsCodecError("Settings state is invalid", error);
  }
}

export function parseSettingsStateV2Bytes(
  bytes: Uint8Array,
  options: SettingsValidationOptions = {}
): SettingsStateV2 {
  if (bytes.byteLength > MAX_SETTINGS_STATE_BYTES) {
    throw new SettingsFormatError(`Settings state exceeds its ${MAX_SETTINGS_STATE_BYTES}-byte size limit`);
  }
  return parseSettingsStateV2Text(decodeSettingsBytes(bytes, "settings state"), options);
}

export function parseSettingsStateV2Text(
  text: string,
  options: SettingsValidationOptions = {}
): SettingsStateV2 {
  const bytes = encodeSettingsText(text, "settings state");
  if (bytes.byteLength > MAX_SETTINGS_STATE_BYTES) {
    throw new SettingsFormatError(`Settings state exceeds its ${MAX_SETTINGS_STATE_BYTES}-byte size limit`);
  }
  const value = parseJsonRejectingDuplicateKeys(text, "settings state");
  const state = parseSettingsStateV2(value, options);
  if (canonicalJson(value) !== text) throw new SettingsFormatError("Settings state is not canonical JSON");
  return state;
}

/** Formatting is intentionally a validating operation, never blind stringify. */
export function formatSettingsStateV2(state: SettingsStateV2): string {
  try {
    const parsed = parseSettingsStateV2(state);
    const text = canonicalJson(parsed);
    assertSettingsStateSize(text);
    return text;
  } catch (error) {
    throw settingsCodecError("Settings state cannot be formatted", error);
  }
}

export function formatSettingsStateV2Bytes(state: SettingsStateV2): Uint8Array {
  return Buffer.from(formatSettingsStateV2(state), "utf8");
}

export function hashSettingsStateV2(state: SettingsStateV2): string {
  return hashSettingsStateV2Bytes(formatSettingsStateV2Bytes(state));
}

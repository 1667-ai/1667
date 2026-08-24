import type { SettingsDocumentV5, SettingsStateV5 } from "../shared/settings-v5-types.js";
import {
  MAX_SETTINGS_DOCUMENT_V5_BYTES,
  MAX_SETTINGS_STATE_V5_BYTES
} from "../shared/settings-v5-limits.js";
import { assertNfcJsonStrings, canonicalJson } from "./canonical-json.js";
import { hashSettingsDocumentBytes, hashSettingsStateBytes } from "./settings-v2-hash.js";
import { SettingsFormatError } from "./settings-v2-scalars.js";
import { settingsStateEnvelopeBytesV5, validateSettingsStateV5 } from "./settings-v5-state-validation.js";
import { validateSettingsDocumentV5, type SettingsValidationOptions } from "./settings-v5-validation.js";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";
import {
  assertSettingsDocumentSize,
  assertSettingsStateSize,
  deepFreezeSettings,
  decodeSettingsBytes,
  encodeSettingsText,
  settingsCodecError
} from "./settings-codec-shared.js";

export function parseSettingsDocumentV5(
  value: unknown,
  options: SettingsValidationOptions = {}
): SettingsDocumentV5 {
  try {
    assertNfcJsonStrings(value, "settings document");
    const document = validateSettingsDocumentV5(value, options);
    assertSettingsDocumentSize(canonicalJson(document), MAX_SETTINGS_DOCUMENT_V5_BYTES);
    return deepFreezeSettings(document);
  } catch (error) {
    throw settingsCodecError("Settings document is invalid", error);
  }
}

export function parseSettingsDocumentV5Bytes(
  bytes: Uint8Array,
  options: SettingsValidationOptions = {}
): SettingsDocumentV5 {
  if (bytes.byteLength > MAX_SETTINGS_DOCUMENT_V5_BYTES) {
    throw new SettingsFormatError(
      `Settings document exceeds its ${MAX_SETTINGS_DOCUMENT_V5_BYTES}-byte size limit`
    );
  }
  return parseSettingsDocumentV5Text(decodeSettingsBytes(bytes, "settings document"), options);
}

export function parseSettingsDocumentV5Text(
  text: string,
  options: SettingsValidationOptions = {}
): SettingsDocumentV5 {
  const bytes = encodeSettingsText(text, "settings document");
  if (bytes.byteLength > MAX_SETTINGS_DOCUMENT_V5_BYTES) {
    throw new SettingsFormatError(
      `Settings document exceeds its ${MAX_SETTINGS_DOCUMENT_V5_BYTES}-byte size limit`
    );
  }
  const value = parseJsonRejectingDuplicateKeys(text, "settings document");
  const document = parseSettingsDocumentV5(value, options);
  if (canonicalJson(value) !== text) throw new SettingsFormatError("Settings document is not canonical JSON");
  return document;
}

export function formatSettingsDocumentV5(document: SettingsDocumentV5): string {
  try {
    const parsed = parseSettingsDocumentV5(document);
    const text = canonicalJson(parsed);
    assertSettingsDocumentSize(text, MAX_SETTINGS_DOCUMENT_V5_BYTES);
    return text;
  } catch (error) {
    throw settingsCodecError("Settings document cannot be formatted", error);
  }
}

export function formatSettingsDocumentV5Bytes(document: SettingsDocumentV5): Uint8Array {
  return Buffer.from(formatSettingsDocumentV5(document), "utf8");
}

export function hashSettingsDocumentV5(document: SettingsDocumentV5): string {
  return hashSettingsDocumentBytes(formatSettingsDocumentV5Bytes(document));
}

export function parseSettingsStateV5(
  value: unknown,
  options: SettingsValidationOptions = {}
): SettingsStateV5 {
  try {
    assertNfcJsonStrings(value, "settings state");
    const state = validateSettingsStateV5(value, options);
    const text = canonicalJson(state);
    assertSettingsStateSize(text, MAX_SETTINGS_STATE_V5_BYTES);
    settingsStateEnvelopeBytesV5(state);
    return deepFreezeSettings(state);
  } catch (error) {
    throw settingsCodecError("Settings state is invalid", error);
  }
}

export function parseSettingsStateV5Bytes(
  bytes: Uint8Array,
  options: SettingsValidationOptions = {}
): SettingsStateV5 {
  if (bytes.byteLength > MAX_SETTINGS_STATE_V5_BYTES) {
    throw new SettingsFormatError(`Settings state exceeds its ${MAX_SETTINGS_STATE_V5_BYTES}-byte size limit`);
  }
  return parseSettingsStateV5Text(decodeSettingsBytes(bytes, "settings state"), options);
}

export function parseSettingsStateV5Text(
  text: string,
  options: SettingsValidationOptions = {}
): SettingsStateV5 {
  const bytes = encodeSettingsText(text, "settings state");
  if (bytes.byteLength > MAX_SETTINGS_STATE_V5_BYTES) {
    throw new SettingsFormatError(`Settings state exceeds its ${MAX_SETTINGS_STATE_V5_BYTES}-byte size limit`);
  }
  const value = parseJsonRejectingDuplicateKeys(text, "settings state");
  const state = parseSettingsStateV5(value, options);
  if (canonicalJson(value) !== text) throw new SettingsFormatError("Settings state is not canonical JSON");
  return state;
}

export function formatSettingsStateV5(state: SettingsStateV5): string {
  try {
    const parsed = parseSettingsStateV5(state);
    const text = canonicalJson(parsed);
    assertSettingsStateSize(text, MAX_SETTINGS_STATE_V5_BYTES);
    return text;
  } catch (error) {
    throw settingsCodecError("Settings state cannot be formatted", error);
  }
}

export function formatSettingsStateV5Bytes(state: SettingsStateV5): Uint8Array {
  return Buffer.from(formatSettingsStateV5(state), "utf8");
}

export function hashSettingsStateV5(state: SettingsStateV5): string {
  return hashSettingsStateBytes(formatSettingsStateV5Bytes(state));
}

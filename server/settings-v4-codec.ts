import type { SettingsDocumentV4, SettingsStateV4 } from "../shared/settings-v4-types.js";
import { assertNfcJsonStrings, canonicalJson } from "./canonical-json.js";
import { hashSettingsDocumentBytes, hashSettingsStateBytes } from "./settings-v2-hash.js";
import {
  MAX_SETTINGS_DOCUMENT_BYTES,
  MAX_SETTINGS_STATE_BYTES,
  SettingsFormatError
} from "./settings-v2-scalars.js";
import { settingsStateEnvelopeBytesV4, validateSettingsStateV4 } from "./settings-v4-state-validation.js";
import { validateSettingsDocumentV4, type SettingsValidationOptions } from "./settings-v4-validation.js";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";
import {
  assertSettingsDocumentSize,
  assertSettingsStateSize,
  deepFreezeSettings,
  decodeSettingsBytes,
  encodeSettingsText,
  settingsCodecError
} from "./settings-codec-shared.js";

export function parseSettingsDocumentV4(
  value: unknown,
  options: SettingsValidationOptions = {}
): SettingsDocumentV4 {
  try {
    assertNfcJsonStrings(value, "settings document");
    const document = validateSettingsDocumentV4(value, options);
    assertSettingsDocumentSize(canonicalJson(document));
    return deepFreezeSettings(document);
  } catch (error) {
    throw settingsCodecError("Settings document is invalid", error);
  }
}

export function parseSettingsDocumentV4Bytes(
  bytes: Uint8Array,
  options: SettingsValidationOptions = {}
): SettingsDocumentV4 {
  if (bytes.byteLength > MAX_SETTINGS_DOCUMENT_BYTES) {
    throw new SettingsFormatError(
      `Settings document exceeds its ${MAX_SETTINGS_DOCUMENT_BYTES}-byte size limit`
    );
  }
  return parseSettingsDocumentV4Text(decodeSettingsBytes(bytes, "settings document"), options);
}

export function parseSettingsDocumentV4Text(
  text: string,
  options: SettingsValidationOptions = {}
): SettingsDocumentV4 {
  const bytes = encodeSettingsText(text, "settings document");
  if (bytes.byteLength > MAX_SETTINGS_DOCUMENT_BYTES) {
    throw new SettingsFormatError(
      `Settings document exceeds its ${MAX_SETTINGS_DOCUMENT_BYTES}-byte size limit`
    );
  }
  const value = parseJsonRejectingDuplicateKeys(text, "settings document");
  const document = parseSettingsDocumentV4(value, options);
  if (canonicalJson(value) !== text) throw new SettingsFormatError("Settings document is not canonical JSON");
  return document;
}

export function formatSettingsDocumentV4(document: SettingsDocumentV4): string {
  try {
    const parsed = parseSettingsDocumentV4(document);
    const text = canonicalJson(parsed);
    assertSettingsDocumentSize(text);
    return text;
  } catch (error) {
    throw settingsCodecError("Settings document cannot be formatted", error);
  }
}

export function formatSettingsDocumentV4Bytes(document: SettingsDocumentV4): Uint8Array {
  return Buffer.from(formatSettingsDocumentV4(document), "utf8");
}

export function hashSettingsDocumentV4(document: SettingsDocumentV4): string {
  return hashSettingsDocumentBytes(formatSettingsDocumentV4Bytes(document));
}

export function parseSettingsStateV4(
  value: unknown,
  options: SettingsValidationOptions = {}
): SettingsStateV4 {
  try {
    assertNfcJsonStrings(value, "settings state");
    const state = validateSettingsStateV4(value, options);
    const text = canonicalJson(state);
    assertSettingsStateSize(text);
    settingsStateEnvelopeBytesV4(state);
    return deepFreezeSettings(state);
  } catch (error) {
    throw settingsCodecError("Settings state is invalid", error);
  }
}

export function parseSettingsStateV4Bytes(
  bytes: Uint8Array,
  options: SettingsValidationOptions = {}
): SettingsStateV4 {
  if (bytes.byteLength > MAX_SETTINGS_STATE_BYTES) {
    throw new SettingsFormatError(`Settings state exceeds its ${MAX_SETTINGS_STATE_BYTES}-byte size limit`);
  }
  return parseSettingsStateV4Text(decodeSettingsBytes(bytes, "settings state"), options);
}

export function parseSettingsStateV4Text(
  text: string,
  options: SettingsValidationOptions = {}
): SettingsStateV4 {
  const bytes = encodeSettingsText(text, "settings state");
  if (bytes.byteLength > MAX_SETTINGS_STATE_BYTES) {
    throw new SettingsFormatError(`Settings state exceeds its ${MAX_SETTINGS_STATE_BYTES}-byte size limit`);
  }
  const value = parseJsonRejectingDuplicateKeys(text, "settings state");
  const state = parseSettingsStateV4(value, options);
  if (canonicalJson(value) !== text) throw new SettingsFormatError("Settings state is not canonical JSON");
  return state;
}

export function formatSettingsStateV4(state: SettingsStateV4): string {
  try {
    const parsed = parseSettingsStateV4(state);
    const text = canonicalJson(parsed);
    assertSettingsStateSize(text);
    return text;
  } catch (error) {
    throw settingsCodecError("Settings state cannot be formatted", error);
  }
}

export function formatSettingsStateV4Bytes(state: SettingsStateV4): Uint8Array {
  return Buffer.from(formatSettingsStateV4(state), "utf8");
}

export function hashSettingsStateV4(state: SettingsStateV4): string {
  return hashSettingsStateBytes(formatSettingsStateV4Bytes(state));
}

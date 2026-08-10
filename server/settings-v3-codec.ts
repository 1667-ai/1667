import type { SettingsDocumentV3, SettingsStateV3 } from "../shared/settings-v2-types.js";
import {
  assertNfcJsonStrings,
  canonicalJson,
  encodeUtf8Strict
} from "./canonical-json.js";
import { hashSettingsDocumentV3Bytes, hashSettingsStateV3Bytes } from "./settings-v3-hash.js";
import {
  MAX_SETTINGS_DOCUMENT_BYTES,
  MAX_SETTINGS_STATE_BYTES,
  SettingsFormatError
} from "./settings-v2-scalars.js";
import {
  settingsStateEnvelopeBytesV3,
  validateSettingsStateV3
} from "./settings-v3-state-validation.js";
import {
  validateSettingsDocumentV3,
  type SettingsValidationOptions
} from "./settings-v3-validation.js";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";

/** Schema 3's parse/format/hash surface. Structural sibling of
 * server/settings-v2-codec.ts. This release only reads and validates
 * through this module; nothing writes a schema-3 document or state to disk
 * (`shared/image-input-release.ts`). */

export function parseSettingsDocumentV3(
  value: unknown,
  options: SettingsValidationOptions = {}
): SettingsDocumentV3 {
  try {
    assertNfcJsonStrings(value, "settings document");
    const document = validateSettingsDocumentV3(value, options);
    assertDocumentSize(canonicalJson(document));
    return deepFreeze(document);
  } catch (error) {
    throw settingsError("Settings document is invalid", error);
  }
}

export function parseSettingsDocumentV3Text(
  text: string,
  options: SettingsValidationOptions = {}
): SettingsDocumentV3 {
  const bytes = encode(text, "settings document");
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
    assertDocumentSize(text);
    return text;
  } catch (error) {
    throw settingsError("Settings document cannot be formatted", error);
  }
}

export function formatSettingsDocumentV3Bytes(document: SettingsDocumentV3): Uint8Array {
  return Buffer.from(formatSettingsDocumentV3(document), "utf8");
}

export function hashSettingsDocumentV3(document: SettingsDocumentV3): string {
  return hashSettingsDocumentV3Bytes(formatSettingsDocumentV3Bytes(document));
}

export function parseSettingsStateV3(
  value: unknown,
  options: SettingsValidationOptions = {}
): SettingsStateV3 {
  try {
    assertNfcJsonStrings(value, "settings state");
    const state = validateSettingsStateV3(value, options);
    const text = canonicalJson(state);
    assertStateSize(text);
    settingsStateEnvelopeBytesV3(state);
    return deepFreeze(state);
  } catch (error) {
    throw settingsError("Settings state is invalid", error);
  }
}

export function parseSettingsStateV3Text(
  text: string,
  options: SettingsValidationOptions = {}
): SettingsStateV3 {
  const bytes = encode(text, "settings state");
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
    assertStateSize(text);
    return text;
  } catch (error) {
    throw settingsError("Settings state cannot be formatted", error);
  }
}

export function hashSettingsStateV3(state: SettingsStateV3): string {
  return hashSettingsStateV3Bytes(Buffer.from(formatSettingsStateV3(state), "utf8"));
}

function assertDocumentSize(text: string): void {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_SETTINGS_DOCUMENT_BYTES) {
    throw new SettingsFormatError(
      `Settings document exceeds its ${MAX_SETTINGS_DOCUMENT_BYTES}-byte size limit`
    );
  }
}

function assertStateSize(text: string): void {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_SETTINGS_STATE_BYTES) {
    throw new SettingsFormatError(`Settings state exceeds its ${MAX_SETTINGS_STATE_BYTES}-byte size limit`);
  }
}

function encode(text: string, label: string): Uint8Array {
  try {
    return encodeUtf8Strict(text, label);
  } catch (error) {
    throw settingsError(`${label} contains invalid Unicode`, error);
  }
}

function settingsError(message: string, cause: unknown): SettingsFormatError {
  if (cause instanceof SettingsFormatError) return cause;
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  return new SettingsFormatError(`${message}${detail}`, { cause });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

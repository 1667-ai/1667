import { decodeCanonicalUtf8, encodeUtf8Strict } from "./canonical-json.js";
import {
  MAX_SETTINGS_DOCUMENT_BYTES,
  MAX_SETTINGS_STATE_BYTES,
  SettingsFormatError
} from "./settings-v2-scalars.js";

/**
 * The byte-level plumbing every settings schema's codec needs: size bounds,
 * strict UTF-8 encode/decode, error wrapping, and the frozen return
 * contract. None of it reads a document or a state, so none of it is
 * version-specific. `server/settings-v2-codec.ts` and
 * `server/settings-v3-codec.ts` both call this module instead of each
 * carrying its own private copy.
 */

export function assertSettingsDocumentSize(
  text: string,
  maxBytes = MAX_SETTINGS_DOCUMENT_BYTES
): void {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    throw new SettingsFormatError(
      `Settings document exceeds its ${maxBytes}-byte size limit`
    );
  }
}

export function assertSettingsStateSize(
  text: string,
  maxBytes = MAX_SETTINGS_STATE_BYTES
): void {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    throw new SettingsFormatError(`Settings state exceeds its ${maxBytes}-byte size limit`);
  }
}

export function decodeSettingsBytes(bytes: Uint8Array, label: string): string {
  try {
    return decodeCanonicalUtf8(bytes, label);
  } catch (error) {
    throw settingsCodecError(`${label} is not strict UTF-8`, error);
  }
}

export function encodeSettingsText(text: string, label: string): Uint8Array {
  try {
    return encodeUtf8Strict(text, label);
  } catch (error) {
    throw settingsCodecError(`${label} contains invalid Unicode`, error);
  }
}

export function settingsCodecError(message: string, cause: unknown): SettingsFormatError {
  if (cause instanceof SettingsFormatError) return cause;
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  return new SettingsFormatError(`${message}${detail}`, { cause });
}

export function deepFreezeSettings<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeSettings(child);
  }
  return value;
}

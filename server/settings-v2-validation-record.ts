import { MAX_SETTINGS_RECORDS, SettingsFormatError } from "./settings-v2-scalars.js";

/** Parse a persisted settings record with the common document-size limit. */
export function settingsMap(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SettingsFormatError(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const count = Object.keys(record).length;
  if (count < 1 || count > MAX_SETTINGS_RECORDS) {
    throw new SettingsFormatError(`${label} must contain 1..${MAX_SETTINGS_RECORDS} entries`);
  }
  return record;
}

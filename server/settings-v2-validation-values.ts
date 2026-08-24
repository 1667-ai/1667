import { SettingsFormatError } from "./settings-v2-scalars.js";

/** Parse one string from a closed persisted-settings choice set. */
export function oneOf<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  label: string
): T[number] {
  if (typeof value !== "string" || !(choices as readonly string[]).includes(value)) {
    throw new SettingsFormatError(`${label} must be one of ${choices.join(" | ")}`);
  }
  return value as T[number];
}

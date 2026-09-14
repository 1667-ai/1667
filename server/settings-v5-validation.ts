import type { SettingsDocumentV5 } from "../shared/settings-v5-types.js";
import {
  parseProfileV5,
  parseProfilesV5,
  validateSettingsDocumentV5 as validateSettingsDocumentV5Core,
  type SettingsValidationOptions
} from "../shared/settings-v5-validation.js";

export type { SettingsValidationOptions } from "../shared/settings-v5-validation.js";
export { parseProfileV5, parseProfilesV5 } from "../shared/settings-v5-validation.js";

/** Server entry point retains the host platform default used by old callers. */
export function validateSettingsDocumentV5(
  value: unknown,
  options: SettingsValidationOptions = {}
): SettingsDocumentV5 {
  return validateSettingsDocumentV5Core(value, {
    environmentCaseInsensitive: options.environmentCaseInsensitive ?? process.platform === "win32"
  });
}

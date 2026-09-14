export * from "../shared/settings-validation-scalars.js";
import {
  requireCredentialName as requireCredentialNameCore
} from "../shared/settings-validation-scalars.js";

/** Server callers retain the native platform default for environment names. */
export function requireCredentialName(
  value: unknown,
  label: string,
  caseInsensitive = process.platform === "win32"
): string {
  return requireCredentialNameCore(value, label, caseInsensitive);
}

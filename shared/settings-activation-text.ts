import type { SettingsActivationErrorCodeV2 } from "./settings-v2-types.js";

/** One spelling for every surface that reports why an activation failed. */
export function settingsActivationFailureText(
  errorCode: SettingsActivationErrorCodeV2
): string {
  switch (errorCode) {
    case "credential_unresolved":
      return "credential not found (env var or stored key)";
    case "candidate_invalid":
      return "provider check failed";
    case "activation_crashed":
      return "activation was interrupted";
    case "activation_failed":
    case "readiness_failed":
      return "rolled back after an interruption";
  }
}

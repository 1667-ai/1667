import type { SettingsViewReadOnlyReason } from "../../shared/settings-v2-types.js";

/** Read-only settings copy. Missing reason keeps older format-1 responses
 *  compatible and means the legacy migration path. */
export function settingsReadOnlyMessage(
  reason?: SettingsViewReadOnlyReason
): string {
  return reason === "successor-schema"
    ? "newer settings are read-only · successor owns settings · update 1667"
    : "legacy settings are read-only";
}

/** The banner names the exact recovery path before the settings rows. */
export function settingsReadOnlyBanner(
  reason?: SettingsViewReadOnlyReason
): string {
  return reason === "successor-schema"
    ? "  ▲ newer settings schema 4 · read-only · successor owns settings · update 1667"
    : "  ▲ legacy data format 1 · settings are read-only until migration";
}

/** Context probes keep their short legacy wording while naming the successor
 *  update path when the read-only view came from schema 4. */
export function settingsReadOnlyProbeSuffix(
  reason?: SettingsViewReadOnlyReason
): string {
  return reason === "successor-schema"
    ? "newer settings stay read-only · update 1667"
    : "legacy settings stay read-only";
}

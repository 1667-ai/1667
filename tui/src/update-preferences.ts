import type { UpdatePreferences } from "./config.js";

export interface UpdatePreferenceOverrides {
  mode?: UpdatePreferences["mode"];
  channel?: UpdatePreferences["channel"];
}

/**
 * Resolve update policy without consulting ambient state inside the policy
 * function. Callers pass their environment explicitly so tests and embedded
 * launches cannot accidentally inherit a different channel.
 */
export function resolveUpdatePreferences(
  configured: UpdatePreferences,
  environment: Readonly<Record<string, string | undefined>>,
  overrides: UpdatePreferenceOverrides = {}
): UpdatePreferences {
  const environmentMode = environment.AI_1667_NO_UPDATE_CHECK === "1"
    ? "off"
    : configured.mode;
  return {
    mode: overrides.mode ?? environmentMode,
    channel: overrides.channel ?? configured.channel,
    skippedVersion: configured.skippedVersion
  };
}

/**
 * Channel vocabulary for release installer scripts ("stable", "beta", "nightly").
 *
 * This list is wider than INSTALL_CHANNELS because an Installer names its own channel
 * in its file name and in the record it writes, and the Ownership Record vocabulary
 * gains nightly in the phase that teaches the upgrade command to serve it.
 */

import { INSTALL_CHANNELS } from "../shared/install-ownership-record.js";
import { NIGHTLY_CHANNEL } from "./release-nightly-version.js";

export const INSTALL_SCRIPT_CHANNELS = ["stable", "beta", NIGHTLY_CHANNEL] as const;
export type InstallScriptChannel = (typeof INSTALL_SCRIPT_CHANNELS)[number];

// Every channel the Ownership Record may name must be a channel an Installer can
// render, so the Ownership Record can never grow a channel with no Installer.
// This states the direction and fails the build if it reverses.
INSTALL_CHANNELS satisfies readonly InstallScriptChannel[];

export function isInstallScriptChannel(value: unknown): value is InstallScriptChannel {
  return typeof value === "string" && (INSTALL_SCRIPT_CHANNELS as readonly string[]).includes(value);
}

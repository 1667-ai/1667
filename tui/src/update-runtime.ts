import { createHash } from "node:crypto";
import {
  AI_1667_BUILD_IDENTITY,
  AI_1667_PRODUCT_VERSION
} from "../../shared/build-identity.js";
import {
  RELEASE_LAUNCHER_PACKAGE,
  releaseTargetForRuntime
} from "../../shared/release-targets.js";
import type { UserConfig } from "./config.js";
import {
  managedInstallationChannel,
  resolveInstallationAuthority,
} from "./install-ownership.js";
import { formatUpgradeApplyCommand } from "./upgrade-command.js";
import {
  startBackgroundUpdateCheck
} from "./background-update-check.js";
import {
  NPM_REGISTRY_ORIGIN,
  NpmUpgradeRegistry
} from "./npm-upgrade-registry.js";
import {
  readPersistedUpdateCache,
  writePersistedUpdateCache
} from "./update-cache-store.js";
import type { UpdateCacheKey } from "./update-cache.js";
import { resolveUpdatePreferences } from "./update-preferences.js";

export type BackgroundUpdateStarter = (
  onNotice: (message: string) => void
) => () => void;

export type ConfiguredUpdateStarter = (
  config: UserConfig,
  onNotice: (message: string) => void
) => () => void;

export interface UpdateCheckSession {
  synchronize(config: UserConfig): void;
  dispose(): void;
}

/** Keep one background checker aligned with the current local preference. */
export function createUpdateCheckSession(
  start: ConfiguredUpdateStarter | undefined,
  onNotice: (message: string) => void
): UpdateCheckSession {
  let active: UpdatePreferencesIdentity | null = null;
  let stop: (() => void) | null = null;
  let disposed = false;
  return {
    synchronize(config) {
      const next = updatePreferencesIdentity(config);
      if (sameUpdatePreferences(active, next)) return;
      active = next;
      stopUpdateCheck(stop);
      stop = null;
      if (disposed || start === undefined) return;
      try {
        stop = start(config, onNotice);
      } catch {
        // Update checking is advisory. Startup failures must stay silent.
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopUpdateCheck(stop);
      stop = null;
    }
  };
}

interface UpdatePreferencesIdentity {
  mode: UserConfig["updates"]["mode"];
  channel: UserConfig["updates"]["channel"];
  skippedVersion: string | null;
}

function updatePreferencesIdentity(config: UserConfig): UpdatePreferencesIdentity {
  return { ...config.updates };
}

function sameUpdatePreferences(
  left: UpdatePreferencesIdentity | null,
  right: UpdatePreferencesIdentity
): boolean {
  return left !== null
    && left.mode === right.mode
    && left.channel === right.channel
    && left.skippedVersion === right.skippedVersion;
}

function stopUpdateCheck(stop: (() => void) | null): void {
  try {
    stop?.();
  } catch {
    // Shutdown is also advisory. A broken stop hook must not close the app.
  }
}

/**
 * The runtime is a parameter for the same reason it is one in
 * `currentPlatformPackage`: whether a starter exists follows the target's
 * publication state, so a test that could only ask about its own host would
 * assert one branch and say nothing about the other.
 */
export function createBackgroundUpdateStarter(
  config: UserConfig,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform = process.platform,
  arch = process.arch
): BackgroundUpdateStarter | null {
  const configuredPreferences = resolveUpdatePreferences(config.updates, environment);
  if (configuredPreferences.mode === "off") return null;
  const releaseTarget = releaseTargetForRuntime(platform, arch);
  // A held target has no published package, so a background check could only
  // poll the registry for something that is not there. Stay quiet instead.
  if (releaseTarget === null || releaseTarget.heldFromPublication !== null) return null;

  // Background work stays notify-only. The cache key is a build-identity
  // fingerprint (installIdentity); this path resolves Ownership only to choose
  // a safe informational command and never installs a Candidate.
  let managedChannel: UserConfig["updates"]["channel"] | undefined;
  try {
    managedChannel = managedInstallationChannel(resolveInstallationAuthority());
  } catch {
    // Authority is advisory for this notify-only path. If it cannot be read,
    // keep the configured channel and omit a possibly unsafe command.
    managedChannel = undefined;
  }
  const preferences = managedChannel === undefined
    ? configuredPreferences
    : { ...configuredPreferences, channel: managedChannel };
  const observation = {
    currentVersion: AI_1667_PRODUCT_VERSION,
    platformPackage: releaseTarget.packageName
  };
  const cacheKey: UpdateCacheKey = {
    metadataKind: "npm",
    metadataOrigin: NPM_REGISTRY_ORIGIN,
    packageName: RELEASE_LAUNCHER_PACKAGE,
    installIdentity: buildIdentityFingerprint(),
    currentVersion: AI_1667_PRODUCT_VERSION,
    artifactTarget: AI_1667_BUILD_IDENTITY.artifactTarget,
    channel: preferences.channel,
    prereleasePolicy: preferences.channel === "beta"
      ? "allow-prerelease"
      : "stable-only"
  };
  return (onNotice) => startBackgroundUpdateCheck({
    preferences,
    observation,
    cacheKey,
    registry: new NpmUpgradeRegistry(),
    readCache: async () => await readPersistedUpdateCache(cacheKey),
    writeCache: async (entry) => await writePersistedUpdateCache(entry),
    onNotice,
    ...(managedChannel === undefined
      ? {}
      : {
          upgradeCommandForVersion: (version: string) =>
            formatUpgradeApplyCommand({
              kind: "apply",
              channel: managedChannel,
              version
            })
        }),
    ...(environment.AI_1667_DEBUG_UPDATES === "1"
      ? { onDebug: (message: string) => process.stderr.write(`1667: ${message}\n`) }
      : {})
  });
}

function buildIdentityFingerprint(): string {
  return createHash("sha256")
    .update("1667-observed-build-v1\0", "utf8")
    .update(JSON.stringify(AI_1667_BUILD_IDENTITY), "utf8")
    .digest("hex");
}

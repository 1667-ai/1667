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
  resolveInstallationAuthority,
  type InstallationAuthority
} from "./install-ownership.js";
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

/**
 * Build the command shown with a background notice. A command is emitted only
 * for an InstallationAuthority that proves 1667 owns the install path.
 * Manual, npm, source, and copied installations stay version-only. The same
 * read-only command is useful for both proven methods: PowerShell prints the
 * exact Installer command instead of placing a long encoded command in a
 * toast.
 */
export function upgradeCommandForAuthority(
  authority: InstallationAuthority
): string | undefined {
  return authority.kind === "manual" ? undefined : "run 1667 upgrade";
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
  const preferences = resolveUpdatePreferences(config.updates, environment);
  if (preferences.mode === "off") return null;
  const releaseTarget = releaseTargetForRuntime(platform, arch);
  // A held target has no published package, so a background check could only
  // poll the registry for something that is not there. Stay quiet instead.
  if (releaseTarget === null || releaseTarget.heldFromPublication !== null) return null;

  // Background work stays notify-only. The cache key is a build-identity
  // fingerprint (installIdentity); this path resolves Ownership only to choose
  // a safe informational command and never installs a Candidate.
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
  let upgradeCommand: string | undefined;
  try {
    upgradeCommand = upgradeCommandForAuthority(
      resolveInstallationAuthority()
    );
  } catch {
    // Authority is advisory for this notify-only path. If it cannot be read,
    // keep the version notice and omit a possibly unsafe command.
    upgradeCommand = undefined;
  }

  return (onNotice) => startBackgroundUpdateCheck({
    preferences,
    observation,
    cacheKey,
    registry: new NpmUpgradeRegistry(),
    readCache: async () => await readPersistedUpdateCache(cacheKey),
    writeCache: async (entry) => await writePersistedUpdateCache(entry),
    onNotice,
    ...(upgradeCommand === undefined ? {} : { upgradeCommand }),
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

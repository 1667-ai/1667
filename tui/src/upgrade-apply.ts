import { existsSync } from "node:fs";
import { compareSemVer } from "../../shared/semver.js";
import { releaseTargetForPackage } from "../../shared/release-targets.js";
import type { InstallationAuthority } from "./install-ownership.js";
import {
  activateCandidate,
  copyExclusive,
  type RecoveryOutcome
} from "./install-transaction.js";
import {
  withManagedInstallMutation,
  type ShellAuthority
} from "./managed-install-mutation.js";
import {
  NpmUpgradeRegistry,
  type RegistryFetch
} from "./npm-upgrade-registry.js";
import type { UpgradeApplyCommand } from "./upgrade-command.js";
import {
  planUpgrade,
  type UpgradeObservation,
  type UpgradeRegistry
} from "./upgrade-plan.js";
import { downloadPlatformPackage } from "./upgrade-download.js";
import type { PackageDownloadProgressHandler } from "./upgrade-download.js";
import {
  materializeCandidate,
  probeCandidateVersion
} from "./upgrade-candidate.js";
import {
  UpgradeFailure,
  upgradeEnvelope,
  type UpgradeSuccessEnvelope
} from "./upgrade-contract.js";
import { readReleaseExecutableIdentity } from "../../shared/executable-probe.js";
import { createInstallOwnershipRecord } from "../../shared/install-ownership-record.js";
import { removeQuietly } from "../../shared/safe-file-write.js";
import { writeOwnershipRecordAtomic } from "./install-ownership.js";
import { throwUpgradeProbeFailure } from "./upgrade-probe-errors.js";

export interface UpgradeApplyDependencies {
  readonly authority: Extract<InstallationAuthority, { kind: "shell" }>;
  readonly observation: UpgradeObservation;
  readonly registry?: UpgradeRegistry;
  readonly fetcher?: RegistryFetch;
  readonly signal?: AbortSignal;
  readonly onDownloadProgress?: PackageDownloadProgressHandler;
  readonly onDowngradeWarning?: (warning: string) => void;
  /** `--force`: accept an Install Root another account can write. */
  readonly force?: boolean;
}

/**
 * Applies a managed upgrade when Ownership Record authority is present.
 * Completed upgrade recovery returns early only when it satisfies this request
 * (channel match; exact version match when command.version is set). Otherwise
 * authority is reloaded and the current request is planned/applied from the
 * recovered active. Opposite-operation recovery is finished, then the request
 * continues the same way.
 *
 * Mutating upgrades always lock, recover, probe the real active executable, and
 * plan against that locked version. A pre-lock "up-to-date" observation must not
 * skip the lock: another process may have rolled active back, and the reverse
 * race would skip a needed upgrade.
 */
export async function applyUpgrade(
  command: UpgradeApplyCommand,
  dependencies: UpgradeApplyDependencies
): Promise<UpgradeSuccessEnvelope> {
  const signal = dependencies.signal ?? new AbortController().signal;
  const registry = dependencies.registry ?? new NpmUpgradeRegistry(dependencies.fetcher);

  return await withManagedInstallMutation(
    dependencies.authority,
    signal,
    (recovery) => upgradeRecoveryEarly(recovery, command),
    async ({ authority, paths, lockedVersion, signal: lockedSignal }) => {
      // One exact metadata resolution inside the lock; reuse platform metadata.
      const plan = await planUpgrade(
        command,
        { ...dependencies.observation, currentVersion: lockedVersion },
        registry,
        lockedSignal
      );

      if (plan.status === "up-to-date") {
        // Non-exact channel request at head: persist requested channel under the lock.
        if (command.version === null
          && command.channel !== authority.record.channel) {
          writeOwnershipRecordAtomic(createInstallOwnershipRecord({
            installationId: authority.record.installationId,
            channel: command.channel,
            installRoot: authority.record.installRoot,
            executable: authority.record.executable,
            artifactTarget: authority.record.artifactTarget
          }));
          return upgradeEnvelope({
            status: "up-to-date",
            current: plan.current,
            latest: plan.latest,
            target: null,
            channel: command.channel,
            method: "shell"
          });
        }
        return upgradeEnvelope({
          status: "up-to-date",
          current: plan.current,
          latest: plan.latest,
          target: null,
          channel: plan.channel,
          method: "shell"
        });
      }
      const targetVersion = plan.target;
      const meta = plan.platformMetadata;
      if (compareSemVer(targetVersion, lockedVersion) < 0) {
        dependencies.onDowngradeWarning?.(DOWNGRADE_WARNING);
      }
      await downloadPlatformPackage({
        tarballUrl: meta.tarball,
        packageName: dependencies.observation.platformPackage,
        version: targetVersion,
        integrity: meta.integrity,
        destinationPath: paths.packageStaging,
        signal: lockedSignal,
        fetcher: dependencies.fetcher,
        onProgress: dependencies.onDownloadProgress
      });
      await materializeCandidate({
        packagePath: paths.packageStaging,
        destinationPath: paths.candidate,
        packageName: dependencies.observation.platformPackage,
        version: targetVersion,
        signal: lockedSignal
      });
      await activateCandidate({
        authority,
        paths,
        operation: "upgrade",
        activeVersion: lockedVersion,
        candidateVersion: targetVersion,
        channel: command.channel,
        updateChannel: command.version === null,
        signal: lockedSignal
      });
      return upgradeEnvelope({
        status: "applied",
        current: lockedVersion,
        latest: plan.latest,
        target: targetVersion,
        channel: command.channel
      });
    },
    dependencies.force === true
  );
}

export const DOWNGRADE_WARNING =
  "Warning: A downgrade can make the Vault unreadable or damage Vault data. "
  + "Back up the Vault before you continue.\n";

export async function applyRollback(
  dependencies: {
    readonly authority: Extract<InstallationAuthority, { kind: "shell" }>;
    readonly observation: UpgradeObservation;
    readonly signal?: AbortSignal;
    readonly force?: boolean;
  }
): Promise<UpgradeSuccessEnvelope> {
  const signal = dependencies.signal ?? new AbortController().signal;

  return await withManagedInstallMutation(
    dependencies.authority,
    signal,
    rollbackRecoveryEarly,
    async ({ authority, paths, lockedVersion, signal: lockedSignal }) => {
      if (!existsSync(paths.previous)) {
        throw new UpgradeFailure(
          "unsupported_target",
          "No previous executable is available to roll back to."
        );
      }
      const target = releaseTargetForPackage(dependencies.observation.platformPackage);
      if (target === null) {
        throw new UpgradeFailure("unsupported_target", "This platform is not supported for releases.");
      }
      removeQuietly(paths.candidate);
      await copyExclusive(paths.previous, paths.candidate, 0o755, lockedSignal);
      let previousIdentity;
      try {
        previousIdentity = await readReleaseExecutableIdentity(paths.candidate, {
          signal: lockedSignal
        });
      } catch (error) {
        throwUpgradeProbeFailure(error, lockedSignal, "Previous executable version probe failed.");
      }
      if (previousIdentity.artifactTarget !== target.artifactTarget) {
        throw new UpgradeFailure("verification_failed", "Previous executable target is invalid.");
      }
      await probeCandidateVersion(
        paths.candidate,
        previousIdentity.productVersion,
        target.artifactTarget,
        lockedSignal
      );
      await activateCandidate({
        authority,
        paths,
        operation: "rollback",
        activeVersion: lockedVersion,
        candidateVersion: previousIdentity.productVersion,
        channel: authority.record.channel,
        updateChannel: false,
        signal: lockedSignal
      });
      return upgradeEnvelope({
        status: "applied",
        current: lockedVersion,
        latest: previousIdentity.productVersion,
        target: previousIdentity.productVersion,
        channel: authority.record.channel
      });
    },
    dependencies.force === true
  );
}

/** Offline early return only when recovered upgrade satisfies this request. */
function upgradeRecoveryEarly(
  recovery: Extract<RecoveryOutcome, { kind: "completed" }>,
  command: UpgradeApplyCommand
): UpgradeSuccessEnvelope | null {
  if (!recoveredUpgradeSatisfiesRequest(recovery, command)) return null;
  return upgradeEnvelope({
    status: "applied",
    current: recovery.fromVersion,
    latest: recovery.toVersion,
    target: recovery.toVersion,
    channel: recovery.requestChannel
  });
}

/**
 * Only an interrupted rollback returns here. A completed upgrade recovery must
 * not be reported as a rollback; continue the requested rollback.
 */
function rollbackRecoveryEarly(
  recovery: Extract<RecoveryOutcome, { kind: "completed" }>,
  _authority: ShellAuthority
): UpgradeSuccessEnvelope | null {
  if (recovery.operation !== "rollback") return null;
  return upgradeEnvelope({
    status: "applied",
    current: recovery.fromVersion,
    latest: recovery.toVersion,
    target: recovery.toVersion,
    channel: recovery.requestChannel
  });
}

/** Completed upgrade recovery satisfies this request (request channel; exact version). */
function recoveredUpgradeSatisfiesRequest(
  recovery: {
    readonly operation: "upgrade" | "rollback";
    readonly requestChannel: string;
    readonly toVersion: string;
  },
  command: UpgradeApplyCommand
): boolean {
  if (recovery.operation !== "upgrade") return false;
  if (recovery.requestChannel !== command.channel) return false;
  if (command.version !== null && recovery.toVersion !== command.version) return false;
  return true;
}

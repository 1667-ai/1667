import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { compareSemVer } from "../../shared/semver.js";
import type { InstallationAuthority } from "./install-ownership.js";
import type { RegistryFetch } from "./npm-upgrade-registry.js";
import type { UpgradeApplyCommand } from "./upgrade-command.js";
import {
  UpgradeFailure,
  upgradeEnvelope,
  type UpgradeSuccessEnvelope
} from "./upgrade-contract.js";
import { materializeCandidate } from "./upgrade-candidate.js";
import {
  downloadPlatformPackage,
  type PackageDownloadProgressHandler
} from "./upgrade-download.js";
import {
  planUpgrade,
  type UpgradeObservation,
  type UpgradeRegistry
} from "./upgrade-plan.js";
import {
  saveWindowsUpgradeChannel,
  sha256File,
  startWindowsUpgradeHandoff,
  type WindowsUpgradeChannelSaver,
  type WindowsUpgradeHandoffStarter
} from "./windows-upgrade-handoff.js";

export interface PowerShellUpgradeDependencies {
  readonly authority: Extract<InstallationAuthority, { kind: "powershell" }>;
  readonly observation: UpgradeObservation;
  readonly registry: UpgradeRegistry;
  readonly fetcher?: RegistryFetch;
  readonly signal?: AbortSignal;
  readonly onDownloadProgress?: PackageDownloadProgressHandler;
  readonly onDowngradeWarning: (warning: string) => void;
  readonly downgradeWarning: string;
  readonly startHandoff?: WindowsUpgradeHandoffStarter;
  readonly saveChannel?: WindowsUpgradeChannelSaver;
}

/**
 * Verify and stage a beta candidate before a local helper replaces the locked
 * Windows executable after this process exits.
 */
export async function applyPowerShellBetaUpgrade(
  command: UpgradeApplyCommand,
  dependencies: PowerShellUpgradeDependencies
): Promise<UpgradeSuccessEnvelope> {
  const signal = dependencies.signal ?? new AbortController().signal;
  const plan = await planUpgrade(
    command,
    dependencies.observation,
    dependencies.registry,
    signal
  );
  const channelSwitch = command.version === null
    && command.channel !== dependencies.authority.channel;
  if (plan.status === "up-to-date") {
    if (channelSwitch) {
      try {
        await (dependencies.saveChannel ?? saveWindowsUpgradeChannel)(
          dependencies.authority,
          command.channel
        );
      } catch (error) {
        if (error instanceof UpgradeFailure) throw error;
        const detail = error instanceof Error && error.message.length > 0
          ? ` ${error.message}`
          : "";
        throw new UpgradeFailure(
          "internal_error",
          `Could not save the ${command.channel} update channel.${detail}`
        );
      }
    }
    return upgradeEnvelope({
      status: "up-to-date",
      current: plan.current,
      latest: plan.latest,
      target: null,
      channel: plan.channel,
      method: "powershell"
    });
  }

  const targetVersion = plan.target;
  const platformMetadata = plan.platformMetadata;
  if (compareSemVer(targetVersion, plan.current) < 0) {
    dependencies.onDowngradeWarning(dependencies.downgradeWarning);
  }

  let workRoot: string;
  try {
    workRoot = mkdtempSync(path.join(
      dependencies.authority.installRoot,
      ".1667-upgrade."
    ));
  } catch {
    throw new UpgradeFailure("internal_error", "Could not prepare the Windows upgrade.");
  }
  const packagePath = path.join(workRoot, "release-package.tgz");
  const candidatePath = path.join(workRoot, "1667-candidate.exe");
  let handedOff = false;
  try {
    await downloadPlatformPackage({
      tarballUrl: platformMetadata.tarball,
      packageName: dependencies.observation.platformPackage,
      version: targetVersion,
      integrity: platformMetadata.integrity,
      destinationPath: packagePath,
      signal,
      fetcher: dependencies.fetcher,
      onProgress: dependencies.onDownloadProgress
    });
    await materializeCandidate({
      packagePath,
      destinationPath: candidatePath,
      packageName: dependencies.observation.platformPackage,
      version: targetVersion,
      signal
    });
    const candidateSha256 = await sha256File(candidatePath);
    if (signal.aborted) {
      throw new UpgradeFailure("interrupted", "The update was interrupted.");
    }
    try {
      await (dependencies.startHandoff ?? startWindowsUpgradeHandoff)({
        authority: dependencies.authority,
        currentVersion: plan.current,
        targetVersion,
        channel: command.channel,
        updateChannel: command.version === null,
        candidatePath,
        candidateSha256,
        workRoot
      });
    } catch {
      throw new UpgradeFailure(
        "internal_error",
        "Could not start the Windows upgrade helper."
      );
    }
    handedOff = true;
  } finally {
    if (!handedOff) {
      try {
        rmSync(workRoot, { recursive: true, force: true });
      } catch {
        // The original upgrade failure is more useful than cleanup failure.
      }
    }
  }

  return upgradeEnvelope({
    status: "staged",
    current: plan.current,
    latest: plan.latest,
    target: targetVersion,
    channel: command.channel
  });
}

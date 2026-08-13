import { isSemVer, isSemVerUpgradeAvailable } from "../../shared/semver.js";
import {
  NpmUpgradeRegistry,
  type NpmVersionMetadata,
  type PlatformPackage
} from "./npm-upgrade-registry.js";
import type {
  UpgradeApplyCommand,
  UpgradeCheckCommand,
  UpgradePlanCommand
} from "./upgrade-command.js";
import {
  UpgradeFailure,
  type UpgradeChannel
} from "./upgrade-contract.js";

/** Local install facts for planning. Install method is not part of observation. */
export interface UpgradeObservation {
  readonly currentVersion: string;
  readonly platformPackage: PlatformPackage;
}

export interface UpgradeRegistry {
  channelHead(channel: UpgradeChannel, signal: AbortSignal): Promise<string>;
  launcher(
    version: string,
    platformPackage: PlatformPackage,
    signal: AbortSignal
  ): Promise<NpmVersionMetadata>;
  platform(
    packageName: PlatformPackage,
    version: string,
    signal: AbortSignal
  ): Promise<NpmVersionMetadata>;
}

/** Neutral plan: current product is current for the selected channel. */
export interface UpgradeUpToDatePlan {
  readonly status: "up-to-date";
  readonly current: string;
  readonly latest: string;
  readonly target: null;
  readonly channel: UpgradeChannel;
}

/** Neutral plan: a channel target is available. Check has no metadata. */
export interface UpgradeCheckTargetPlan {
  readonly status: "target-available";
  readonly current: string;
  readonly latest: string;
  readonly target: string;
  readonly channel: UpgradeChannel;
}

/**
 * Neutral plan: a requested target is available and platform metadata was
 * verified once. Apply reuses this metadata and does not fetch again.
 */
export interface UpgradeApplyTargetPlan {
  readonly status: "target-available";
  readonly current: string;
  readonly latest: string;
  readonly target: string;
  readonly channel: UpgradeChannel;
  readonly platformMetadata: NpmVersionMetadata;
}

export type UpgradeCheckPlan = UpgradeUpToDatePlan | UpgradeCheckTargetPlan;
export type UpgradeApplyPlan = UpgradeUpToDatePlan | UpgradeApplyTargetPlan;
export type UpgradeCorePlan = UpgradeCheckPlan | UpgradeApplyPlan;

export async function planUpgrade(
  command: UpgradeCheckCommand,
  observation: UpgradeObservation,
  registry?: UpgradeRegistry,
  signal?: AbortSignal
): Promise<UpgradeCheckPlan>;
export async function planUpgrade(
  command: UpgradeApplyCommand,
  observation: UpgradeObservation,
  registry?: UpgradeRegistry,
  signal?: AbortSignal
): Promise<UpgradeApplyPlan>;
export async function planUpgrade(
  command: UpgradePlanCommand,
  observation: UpgradeObservation,
  registry: UpgradeRegistry = new NpmUpgradeRegistry(),
  signal: AbortSignal = new AbortController().signal
): Promise<UpgradeCorePlan> {
  if (signal.aborted) throw new UpgradeFailure("interrupted", "The update check was interrupted.");
  if (!isSemVer(observation.currentVersion)) {
    throw new UpgradeFailure("verification_failed", "The current product version is invalid.");
  }
  const version = command.kind === "apply" ? command.version : null;
  const latest = await registry.channelHead(command.channel, signal);
  if (signal.aborted) throw new UpgradeFailure("interrupted", "The update check was interrupted.");
  const target = version ?? latest;
  if (target === observation.currentVersion
    || (version === null && !isSemVerUpgradeAvailable(latest, observation.currentVersion))) {
    return upToDatePlan(observation.currentVersion, latest, command.channel);
  }
  if (command.kind === "check") {
    return Object.freeze({
      status: "target-available",
      current: observation.currentVersion,
      latest,
      target: latest,
      channel: command.channel
    });
  }
  const exactController = new AbortController();
  const exactSignal = AbortSignal.any([signal, exactController.signal]);
  let platformMetadata: NpmVersionMetadata;
  try {
    const [, platform] = await Promise.all([
      registry.launcher(target, observation.platformPackage, exactSignal),
      registry.platform(observation.platformPackage, target, exactSignal)
    ]);
    platformMetadata = platform;
  } finally {
    exactController.abort();
  }
  if (signal.aborted) throw new UpgradeFailure("interrupted", "The update check was interrupted.");
  return Object.freeze({
    status: "target-available",
    current: observation.currentVersion,
    latest,
    target,
    channel: command.channel,
    platformMetadata
  });
}

function upToDatePlan(
  current: string,
  latest: string,
  channel: UpgradeChannel
): UpgradeUpToDatePlan {
  return Object.freeze({
    status: "up-to-date",
    current,
    latest,
    target: null,
    channel
  });
}

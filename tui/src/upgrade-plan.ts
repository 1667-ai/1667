import { compareSemVer, isSemVer } from "../../shared/semver.js";
import {
  NpmUpgradeRegistry,
  type PlatformPackage
} from "./npm-upgrade-registry.js";
import {
  UpgradeFailure,
  upgradeEnvelope,
  type UpgradeChannel,
  type UpgradeSuccessEnvelope
} from "./upgrade-contract.js";

export interface UpgradeRequest {
  readonly check: boolean;
  readonly version: string | null;
  readonly channel: UpgradeChannel;
}

export interface UpgradeObservation {
  readonly currentVersion: string;
  readonly platformPackage: PlatformPackage;
}

export interface UpgradeRegistry {
  channelHead(channel: UpgradeChannel, signal: AbortSignal): Promise<string>;
  launcher(version: string, signal: AbortSignal): Promise<unknown>;
  platform(packageName: PlatformPackage, version: string, signal: AbortSignal): Promise<unknown>;
}

export async function planUpgrade(
  request: UpgradeRequest,
  observation: UpgradeObservation,
  registry: UpgradeRegistry = new NpmUpgradeRegistry(),
  signal: AbortSignal = new AbortController().signal
): Promise<UpgradeSuccessEnvelope> {
  if (signal.aborted) throw new UpgradeFailure("interrupted", "The update check was interrupted.");
  if (!isSemVer(observation.currentVersion)) {
    throw new UpgradeFailure("verification_failed", "The current product version is invalid.");
  }
  const latest = await registry.channelHead(request.channel, signal);
  if (signal.aborted) throw new UpgradeFailure("interrupted", "The update check was interrupted.");
  if (request.version !== null && request.version !== latest) {
    throw new UpgradeFailure(
      "unsupported_target",
      "The requested version is no longer the selected channel head."
    );
  }
  const comparison = compareSemVer(latest, observation.currentVersion);
  const envelope = comparison > 0
    ? upgradeEnvelope({
        status: "manual",
        current: observation.currentVersion,
        latest,
        target: latest,
        channel: request.channel
      })
    : upgradeEnvelope({
        status: "up-to-date",
        current: observation.currentVersion,
        latest,
        target: null,
        channel: request.channel
      });
  if (request.check) return envelope;
  if (comparison < 0) {
    if (request.version !== null) {
      throw new UpgradeFailure("unsupported_target", "Downgrades are not supported.");
    }
    return envelope;
  }
  const exactController = new AbortController();
  const exactSignal = AbortSignal.any([signal, exactController.signal]);
  try {
    await Promise.all([
      registry.launcher(latest, exactSignal),
      registry.platform(observation.platformPackage, latest, exactSignal)
    ]);
  } finally {
    // A failed request must not leave its sibling keeping the CLI alive.
    exactController.abort();
  }
  if (signal.aborted) throw new UpgradeFailure("interrupted", "The update check was interrupted.");
  return envelope;
}

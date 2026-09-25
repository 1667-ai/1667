// Allowed exception: the update channel setting lives with the rest of the
// user config in tui/, and upgrade-cli.ts is not worth a shared home for one
// field yet.
import { loadConfig } from "../../tui/src/config.js";
import {
  createUpgradeProgressRenderer
} from "../../host/launcher/upgrade-progress.js";
import {
  NpmUpgradeRegistry,
  type RegistryFetch
} from "../../host/launcher/npm-upgrade-registry.js";
import {
  executeUpgradeCli,
  currentPlatformPackage,
  publicEnvelopeFromPlan,
  type UpgradeCliOutput,
  type UpgradeCliDependencies
} from "../../host/launcher/upgrade-cli.js";

export {
  executeUpgradeCli,
  currentPlatformPackage,
  publicEnvelopeFromPlan,
  formatUpgradeApplyCommand,
  parseUpgradeArguments,
  windowsInstallCommand,
  UPGRADE_HELP
} from "../../host/launcher/upgrade-cli.js";
export type {
  UpgradeCliOutput,
  UpgradeCliDependencies,
  ParsedUpgradeArguments,
  UpgradeApplyCommand,
  UpgradeCheckCommand,
  UpgradeCommand,
  UpgradeListCommand,
  UpgradeRollbackCommand
} from "../../host/launcher/upgrade-cli.js";

/** Keep signal handling and terminal progress in the CLI surface. */
export async function runProcessUpgrade(
  argv: readonly string[],
  fetcher?: RegistryFetch
): Promise<void> {
  const controller = new AbortController();
  let signalExit: 130 | 143 | null = null;
  const onSigInt = () => {
    signalExit = 130;
    controller.abort();
  };
  const onSigTerm = () => {
    signalExit = 143;
    controller.abort();
  };
  process.once("SIGINT", onSigInt);
  process.once("SIGTERM", onSigTerm);
  try {
    const onDownloadProgress = process.stderr.isTTY
      ? createUpgradeProgressRenderer(
          (text) => process.stderr.write(text),
          process.stderr.columns ?? 80
        )
      : undefined;
    const output: UpgradeCliOutput = await executeUpgradeCli(argv, {
      signal: controller.signal,
      registry: new NpmUpgradeRegistry(fetcher),
      fetcher,
      defaultChannel: loadConfig().updates.channel,
      onDownloadProgress,
      onDowngradeWarning: (warning) => process.stderr.write(warning)
    });
    if (output.stdout.length > 0) process.stdout.write(output.stdout);
    if (output.stderr.length > 0) process.stderr.write(output.stderr);
    process.exitCode = signalExit ?? output.exitCode;
  } finally {
    process.removeListener("SIGINT", onSigInt);
    process.removeListener("SIGTERM", onSigTerm);
  }
}

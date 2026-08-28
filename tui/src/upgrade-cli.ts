import { compareSemVer, isSemVer, parseSemVer } from "../../shared/semver.js";
import { AI_1667_PRODUCT_VERSION } from "../../shared/build-identity.js";
import {
  heldTargetRefusal,
  RELEASE_LAUNCHER_PACKAGE,
  releaseTargetForRuntime
} from "../../shared/release-targets.js";
import { loadConfig } from "./config.js";
import {
  managedInstallationChannel,
  resolveInstallationAuthority,
  type InstallationAuthority
} from "./install-ownership.js";
import {
  NpmUpgradeRegistry,
  type PlatformPackage,
  type RegistryFetch
} from "./npm-upgrade-registry.js";
import {
  applyRollback,
  applyUpgrade,
  DOWNGRADE_WARNING
} from "./upgrade-apply.js";
import type { PackageDownloadProgressHandler } from "./upgrade-download.js";
import { createUpgradeProgressRenderer } from "./upgrade-progress.js";
import {
  formatUpgradeApplyCommand,
  parseUpgradeArguments,
  upgradeCommandChannel,
  type ParsedUpgradeArguments,
  type UpgradeCommand
} from "./upgrade-command.js";
import {
  UpgradeFailure,
  upgradeErrorEnvelope,
  upgradeEnvelope,
  type UpgradeChannel,
  type UpgradeEnvelope,
  type UpgradeMethod,
  type UpgradeSuccessEnvelope
} from "./upgrade-contract.js";
import {
  planUpgrade,
  type UpgradeCorePlan,
  type UpgradeObservation,
  type UpgradeRegistry
} from "./upgrade-plan.js";

export {
  formatUpgradeApplyCommand,
  parseUpgradeArguments
} from "./upgrade-command.js";
export type {
  ParsedUpgradeArguments,
  UpgradeApplyCommand,
  UpgradeCheckCommand,
  UpgradeCommand,
  UpgradeListCommand,
  UpgradeRollbackCommand
} from "./upgrade-command.js";

export const UPGRADE_HELP = `Usage:
  1667 upgrade --list [--json]
  1667 upgrade --check [--channel <stable|beta>] [--json]
  1667 upgrade [--version <semver>] [--channel <stable|beta>] [--json] [--force]
  1667 upgrade --rollback [--json] [--force]

--force accepts an Install Root that another account on this machine can write.
It waives no checksum, attestation, or version check.

--version selects one exact published release. It can downgrade 1667.
${DOWNGRADE_WARNING.trimEnd()}

--list shows published launcher releases. Platform support is checked when
--version selects a release.

If you installed 1667 with npm, or you built it from source, update it the same
way you installed it.
On Windows, a PowerShell installation updates through the PowerShell Installer.`;

export function windowsInstallCommand(
  installRoot: string,
  targetVersion?: string,
  channel: UpgradeChannel = "stable"
): string {
  if (targetVersion !== undefined && !isSemVer(targetVersion)) {
    throw new TypeError("Windows Installer target version must be SemVer");
  }
  const root = installRoot.replaceAll("'", "''");
  const installerChannel = targetVersion === undefined
    ? channel
    : windowsInstallerChannel(targetVersion, channel);
  if (installerChannel !== "stable") {
    throw new TypeError("Automatic Windows Installer commands require the stable channel");
  }
  const installerUrl = targetVersion === undefined
    ? "https://1667.ai/install.ps1"
    : `https://github.com/1667-ai/1667/releases/download/v${
      encodeURIComponent(targetVersion)
    }/install-${installerChannel}.ps1`;
  const script = `& ([scriptblock]::Create((irm ${installerUrl}))) `
    + "-InstallRoot '" + root + "'";
  return "powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand "
    + Buffer.from(script, "utf16le").toString("base64");
}

const INSTRUCTIONS_ORIGIN =
  `https://www.npmjs.com/package/${RELEASE_LAUNCHER_PACKAGE}/v`;
const NPM_RELEASE_SIGNER = "1667-ai/1667/.github/workflows/release-npm.yml";
const LEGACY_RELEASE_SIGNER = "1667-ai/1667/.github/workflows/release-github.yml";

export interface UpgradeCliDependencies {
  readonly observation?: UpgradeObservation;
  readonly registry?: UpgradeRegistry;
  readonly versionRegistry?: Pick<NpmUpgradeRegistry, "availableVersions">;
  readonly authority?: InstallationAuthority;
  readonly fetcher?: RegistryFetch;
  readonly signal?: AbortSignal;
  readonly defaultChannel?: UpgradeChannel;
  readonly onDownloadProgress?: PackageDownloadProgressHandler;
  readonly onDowngradeWarning?: (warning: string) => void;
}

export interface UpgradeCliOutput {
  readonly exitCode: 0 | 1 | 2 | 130 | 143;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: UpgradeEnvelope | null;
}

export async function executeUpgradeCli(
  argv: readonly string[],
  dependencies: UpgradeCliDependencies = {}
): Promise<UpgradeCliOutput> {
  // Resolve authority before channel defaults so shell installs use the Ownership
  // Record channel and manual installs use config.
  let authority: InstallationAuthority;
  try {
    authority = dependencies.authority ?? resolveInstallationAuthority();
  } catch {
    authority = { kind: "manual" };
  }
  const configChannel = dependencies.defaultChannel ?? "stable";
  const defaultChannel: UpgradeChannel =
    managedInstallationChannel(authority) ?? configChannel;
  let parsed: ParsedUpgradeArguments | null;
  try {
    parsed = parseUpgradeArguments(argv, defaultChannel);
  } catch (error) {
    const failure = normalizeFailure(error);
    return failedOutput(
      failure,
      argv.includes("--json"),
      { currentVersion: AI_1667_PRODUCT_VERSION },
      partialChannel(argv, defaultChannel),
      authorityMethod(authority),
      failure.code === "invalid_arguments" ? 2 : failure.code === "interrupted" ? 130 : 1
    );
  }
  if (parsed === null) {
    return { exitCode: 0, stdout: `${UPGRADE_HELP}\n`, stderr: "", envelope: null };
  }
  if (parsed.command.kind === "list") {
    try {
      const versions = await (
        dependencies.versionRegistry ?? new NpmUpgradeRegistry(dependencies.fetcher)
      ).availableVersions(
        dependencies.signal ?? new AbortController().signal
      );
      return {
        exitCode: 0,
        stdout: parsed.json
          ? `${JSON.stringify({ versions })}\n`
          : versions.length === 0 ? "" : `${versions.join("\n")}\n`,
        stderr: "",
        envelope: null
      };
    } catch (error) {
      const failure = normalizeFailure(error);
      return failedOutput(
        failure,
        parsed.json,
        { currentVersion: AI_1667_PRODUCT_VERSION },
        null,
        authorityMethod(authority),
        failure.code === "interrupted" ? 130 : 1
      );
    }
  }
  const registry = dependencies.registry ?? new NpmUpgradeRegistry(dependencies.fetcher);
  let observation: UpgradeObservation;
  try {
    observation = dependencies.observation ?? defaultObservation();
  } catch (error) {
    const failure = normalizeFailure(error);
    return failedOutput(
      failure,
      parsed.json,
      { currentVersion: AI_1667_PRODUCT_VERSION },
      upgradeCommandChannel(parsed.command, defaultChannel),
      authorityMethod(authority),
      1
    );
  }
  const method = authorityMethod(authority);
  const downgradeWarnings: string[] = [];
  const onDowngradeWarning = dependencies.onDowngradeWarning
    ?? ((warning: string) => downgradeWarnings.push(warning));
  try {
    const envelope = await dispatchUpgradeCommand(
      parsed.command,
      authority,
      observation,
      method,
      registry,
      dependencies,
      parsed.force,
      parsed.json ? undefined : dependencies.onDownloadProgress,
      onDowngradeWarning
    );
    return {
      exitCode: 0,
      stdout: parsed.json
        ? `${JSON.stringify(envelope)}\n`
        : renderUpgrade(envelope, parsed.command),
      stderr: downgradeWarnings.join(""),
      envelope
    };
  } catch (error) {
    const failure = normalizeFailure(error);
    const exitCode = failure.code === "interrupted" ? 130 : 1;
    const output = failedOutput(
      failure,
      parsed.json,
      observation,
      upgradeCommandChannel(parsed.command, defaultChannel),
      method,
      exitCode
    );
    return downgradeWarnings.length === 0
      ? output
      : { ...output, stderr: downgradeWarnings.join("") + output.stderr };
  }
}

async function dispatchUpgradeCommand(
  command: UpgradeCommand,
  authority: InstallationAuthority,
  observation: UpgradeObservation,
  method: UpgradeMethod,
  registry: UpgradeRegistry,
  dependencies: UpgradeCliDependencies,
  force: boolean,
  onDownloadProgress: PackageDownloadProgressHandler | undefined,
  onDowngradeWarning: (warning: string) => void
): Promise<UpgradeSuccessEnvelope> {
  switch (command.kind) {
    case "list":
      throw new UpgradeFailure("internal_error", "The release list was not handled.");
    case "rollback": {
      if (authority.kind === "powershell") {
        if (authority.channel === "beta") {
          throw new UpgradeFailure(
            "unsupported_target",
            "Windows rollback is unavailable.\n"
              + betaInstallerGuidance(observation.currentVersion, authority.installRoot)
          );
        }
        throw new UpgradeFailure(
          "unsupported_target",
          "Windows rollback is unavailable. "
          + "A Windows PowerShell installation updates through the PowerShell Installer. "
          + "To install it, run:\n"
          + windowsInstallCommand(authority.installRoot)
        );
      }
      if (authority.kind !== "shell") {
        throw new UpgradeFailure(
          "unsupported_target",
          "Rollback works only when you installed 1667 with the install command."
        );
      }
      return await applyRollback({
        authority,
        observation,
        signal: dependencies.signal,
        force
      });
    }
    case "check": {
      const plan = await planUpgrade(
        command,
        observation,
        registry,
        dependencies.signal
      );
      return publicEnvelopeFromPlan(plan, authority, false, plan.channel === "stable");
    }
    case "apply": {
      if (authority.kind === "shell") {
        return await applyUpgrade(command, {
          authority,
          observation,
          registry,
          fetcher: dependencies.fetcher,
          signal: dependencies.signal,
          onDownloadProgress,
          onDowngradeWarning,
          force
        });
      }
      // External installs stay read-only: verify metadata, emit manual envelope.
      const plan = await planUpgrade(
        command,
        observation,
        registry,
        dependencies.signal
      );
      const channelSwitch = command.version === null
        && authority.kind === "powershell"
        && command.channel !== authority.channel;
      warnIfDowngrade(plan, onDowngradeWarning);
      if (method === "powershell"
        && command.version === null
        && (plan.status !== "up-to-date" || channelSwitch)
      ) {
        requireServableWindowsChannel(
          plan.channel,
          plan.status === "up-to-date" ? plan.latest : plan.target,
          authority.installRoot
        );
      }
      if (method === "powershell"
        && command.version !== null
        && plan.status !== "up-to-date"
        && authority.kind === "powershell"
        && windowsInstallerChannel(plan.target, authority.channel) === "beta"
      ) {
        throwBetaWindowsGuidance(plan.target, authority.installRoot);
      }
      return publicEnvelopeFromPlan(
        plan,
        authority,
        channelSwitch,
        true,
        command.version !== null && authority.kind === "powershell"
          ? authority.channel
          : plan.channel
      );
    }
  }
}

function warnIfDowngrade(
  plan: UpgradeCorePlan,
  onDowngradeWarning: (warning: string) => void
): void {
  if (plan.status === "target-available"
    && compareSemVer(plan.target, plan.current) < 0) {
    onDowngradeWarning(DOWNGRADE_WARNING);
  }
}

/**
 * Map a neutral plan to the public envelope. InstallationAuthority alone
 * decides method and whether a target is available or manual.
 */
export function publicEnvelopeFromPlan(
  plan: UpgradeCorePlan,
  authority: InstallationAuthority,
  forcePowerShellInstall = false,
  includePowerShellCommand = true,
  powerShellInstallerChannel: UpgradeChannel = plan.channel
): UpgradeSuccessEnvelope {
  const method = authorityMethod(authority);
  if (forcePowerShellInstall
    && authority.kind === "powershell"
    && plan.status === "up-to-date") {
    return upgradeEnvelope({
      status: "manual",
      current: plan.current,
      latest: plan.latest,
      target: plan.latest,
      channel: plan.channel,
      method: "powershell",
      command: windowsInstallCommand(authority.installRoot, plan.latest, plan.channel)
    });
  }
  if (plan.status === "up-to-date") {
    return upgradeEnvelope({
      status: "up-to-date",
      current: plan.current,
      latest: plan.latest,
      target: null,
      channel: plan.channel,
      method
    });
  }
  if (method === "shell" || (method === "powershell" && !includePowerShellCommand)) {
    return upgradeEnvelope({
      status: "available",
      current: plan.current,
      latest: plan.latest,
      target: plan.target,
      channel: plan.channel,
      ...(method === "powershell" ? { method: "powershell" as const } : {})
    });
  }
  if (authority.kind === "powershell") {
    return upgradeEnvelope({
      status: "manual",
      current: plan.current,
      latest: plan.latest,
      target: plan.target,
      channel: plan.channel,
      method: "powershell",
      command: windowsInstallCommand(
        authority.installRoot,
        plan.target,
        powerShellInstallerChannel
      )
    });
  }
  return upgradeEnvelope({
    status: "manual",
    current: plan.current,
    latest: plan.latest,
    target: plan.target,
    channel: plan.channel,
    method: "manual"
  });
}

/**
 * `https://1667.ai/install.ps1` serves the promoted stable release. A beta
 * Installer must come from its immutable release and pass attestation before a
 * user runs it.
 */
function requireServableWindowsChannel(
  channel: UpgradeChannel,
  targetVersion?: string | null,
  installRoot?: string
): void {
  if (channel === "stable") return;
  const guidance = targetVersion === undefined || targetVersion === null
    ? "Select a beta version, then download and attest its release Installer before you run it."
    : betaInstallerGuidance(targetVersion, installRoot);
  throw new UpgradeFailure(
    "unsupported_target",
    "The standard Windows Installer URL supports stable releases only.\n" + guidance
  );
}

function throwBetaWindowsGuidance(
  targetVersion: string,
  installRoot: string
): never {
  throw new UpgradeFailure(
    "unsupported_target",
    `1667 ${targetVersion} requires the beta PowerShell Installer.\n`
      + betaInstallerGuidance(targetVersion, installRoot)
  );
}

function betaInstallerGuidance(targetVersion: string, installRoot?: string): string {
  const installCommand = installRoot === undefined
    ? "powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\\install-beta.ps1"
    : "powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\\install-beta.ps1"
      + ` -InstallRoot '${installRoot.replaceAll("'", "''")}'`;
  return `To install 1667 ${targetVersion}, download this release Installer:\n`
    + `${windowsInstallerUrl(targetVersion, "beta")}\n`
    + `gh release download v${targetVersion} --repo 1667-ai/1667 `
    + "--pattern install-beta.ps1 --output .\\install-beta.ps1\n"
    + "Verify it with the current release workflow:\n"
    + betaAttestationCommand(NPM_RELEASE_SIGNER) + "\n"
    + "For an older beta release, use this command if the first command cannot find an attestation:\n"
    + betaAttestationCommand(LEGACY_RELEASE_SIGNER) + "\n"
    + "The beta Installer sets the saved channel to beta.\n"
    + "Run the verified Installer:\n"
    + installCommand;
}

function betaAttestationCommand(signerWorkflow: string): string {
  return "gh attestation verify .\\install-beta.ps1 --repo 1667-ai/1667 "
    + `--signer-workflow ${signerWorkflow} --deny-self-hosted-runners`;
}

export async function runProcessUpgrade(
  argv: readonly string[],
  fetcher?: RegistryFetch
): Promise<void> {
  const controller = new AbortController();
  /** Conventional exit after signal: 128 + signo (INT=2 → 130, TERM=15 → 143). */
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
      ? createUpgradeProgressRenderer((text) => {
          process.stderr.write(text);
        }, process.stderr.columns ?? 80)
      : undefined;
    const output = await executeUpgradeCli(argv, {
      signal: controller.signal,
      registry: new NpmUpgradeRegistry(fetcher),
      fetcher,
      defaultChannel: loadConfig().updates.channel,
      onDownloadProgress,
      onDowngradeWarning: (warning) => {
        process.stderr.write(warning);
      }
    });
    if (output.stdout.length > 0) process.stdout.write(output.stdout);
    if (output.stderr.length > 0) process.stderr.write(output.stderr);
    // Probe/download cleanup and lock release finished inside executeUpgradeCli.
    // Signal-specific status wins over the generic interrupted exit 130.
    process.exitCode = signalExit ?? output.exitCode;
  } finally {
    process.removeListener("SIGINT", onSigInt);
    process.removeListener("SIGTERM", onSigTerm);
  }
}

function renderUpgrade(
  envelope: UpgradeSuccessEnvelope,
  command: UpgradeCommand
): string {
  const lines: string[] = [];
  switch (envelope.status) {
    case "up-to-date":
      lines.push(`1667 ${envelope.current} is up to date on ${envelope.channel}.`);
      break;
    case "applied":
      lines.push(
        command.kind === "rollback"
          ? `Rolled back 1667 from ${envelope.current} to ${envelope.target}.`
          : compareSemVer(envelope.target, envelope.current) < 0
            ? `Downgraded 1667 from ${envelope.current} to ${envelope.target}.`
            : `Upgraded 1667 from ${envelope.current} to ${envelope.target}.`
      );
      break;
    case "available":
    case "manual":
      lines.push(
        command.kind === "apply" && command.version !== null
          ? `1667 ${envelope.target} is available.`
          : `1667 ${envelope.target} is available on ${envelope.channel}.`
      );
      break;
  }
  if (envelope.restartRequired) {
    lines.push("Restart 1667 to run the new version.");
  }
  if (command.kind === "check") {
    if (envelope.status === "manual") {
      if (envelope.method === "powershell") {
        appendPowerShellGuidance(lines, envelope, command);
      } else {
        lines.push("Run '1667 upgrade' to see how to update.");
      }
    } else if (envelope.status === "available") {
      lines.push(
        envelope.method === "powershell"
          ? "A Windows PowerShell installation updates through the PowerShell Installer."
            + ` Run '1667 upgrade --channel ${envelope.channel}' for installation instructions.`
          : "Run '1667 upgrade' to install it."
      );
    }
    return `${lines.join("\n")}\n`;
  }
  if (envelope.status === "applied") {
    return `${lines.join("\n")}\n`;
  }
  if (envelope.status === "manual") {
    if (envelope.method === "powershell") {
      appendPowerShellGuidance(lines, envelope, command);
      return `${lines.join("\n")}\n`;
    }
    lines.push(`Instructions: ${instructionsUrl(envelope.target)}`);
    lines.push("Start 1667 again after you update it.");
  }
  return `${lines.join("\n")}\n`;
}

function appendPowerShellGuidance(
  lines: string[],
  envelope: Extract<UpgradeSuccessEnvelope, { method: "powershell" }>,
  command: UpgradeCommand
): void {
  lines.push("A Windows PowerShell installation updates through the PowerShell Installer.");
  if (command.kind === "apply" && command.version !== null) {
    lines.push("Selecting an exact version does not change your saved channel.");
  }
  if (envelope.command === null) {
    lines.push("Run '1667 upgrade --channel beta' for installation instructions.");
    return;
  }
  lines.push("To install it, run:");
  lines.push(envelope.command);
}

function windowsInstallerChannel(
  targetVersion: string,
  channel: UpgradeChannel
): UpgradeChannel {
  const parsed = parseSemVer(targetVersion);
  if (parsed === null) throw new TypeError("Windows Installer target version must be SemVer");
  return parsed.prerelease.length > 0 ? "beta" : channel;
}

function windowsInstallerUrl(targetVersion: string, channel: UpgradeChannel): string {
  return `https://github.com/1667-ai/1667/releases/download/v${
    encodeURIComponent(targetVersion)
  }/install-${windowsInstallerChannel(targetVersion, channel)}.ps1`;
}

function authorityMethod(authority: InstallationAuthority): UpgradeMethod {
  return authority.kind === "shell"
    ? "shell"
    : authority.kind === "powershell"
      ? "powershell"
      : "manual";
}

function instructionsUrl(version: string): string {
  return `${INSTRUCTIONS_ORIGIN}/${encodeURIComponent(version)}`;
}

function failedOutput(
  failure: UpgradeFailure,
  json: boolean,
  observation: { currentVersion: string | null },
  channel: UpgradeChannel | null,
  method: UpgradeMethod,
  exitCode: 1 | 2 | 130 | 143
): UpgradeCliOutput {
  const envelope = upgradeErrorEnvelope(failure, {
    current: isSemVer(observation.currentVersion) ? observation.currentVersion : null,
    channel,
    method
  });
  return {
    exitCode,
    stdout: json ? `${JSON.stringify(envelope)}\n` : "",
    stderr: json ? "" : `1667 upgrade: ${failure.message}\n`,
    envelope
  };
}

function defaultObservation(): UpgradeObservation {
  const target = releaseTargetForRuntime(process.platform, process.arch);
  if (target === null) {
    throw new UpgradeFailure("unsupported_target", "This platform is not supported for releases.");
  }
  if (target.heldFromPublication !== null) {
    throw new UpgradeFailure("unsupported_target", heldTargetRefusal(target));
  }
  return {
    currentVersion: AI_1667_PRODUCT_VERSION,
    platformPackage: target.packageName
  };
}

/** The package a runtime can install, or null when none is published for it. */
export function currentPlatformPackage(
  platform = process.platform,
  arch = process.arch
): PlatformPackage | null {
  const target = releaseTargetForRuntime(platform, arch);
  if (target === null || target.heldFromPublication !== null) return null;
  return target.packageName;
}

function partialChannel(
  argv: readonly string[],
  defaultChannel: UpgradeChannel
): UpgradeChannel | null {
  const inline = argv.find((argument) => argument.startsWith("--channel="));
  const index = argv.indexOf("--channel");
  const candidate = inline?.slice("--channel=".length) ?? (index >= 0 ? argv[index + 1] : undefined);
  if (candidate === undefined) return defaultChannel;
  return candidate === "stable" || candidate === "beta" ? candidate : null;
}

function normalizeFailure(error: unknown): UpgradeFailure {
  if (error instanceof UpgradeFailure) return error;
  return new UpgradeFailure("internal_error", "The upgrade check failed unexpectedly.");
}

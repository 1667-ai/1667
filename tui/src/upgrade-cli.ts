import { isSemVer } from "../../shared/semver.js";
import { AI_1667_PRODUCT_VERSION } from "../../shared/build-identity.js";
import {
  heldTargetRefusal,
  RELEASE_LAUNCHER_PACKAGE,
  releaseTargetForRuntime
} from "../../shared/release-targets.js";
import { loadConfig } from "./config.js";
import {
  resolveInstallationAuthority,
  type InstallationAuthority
} from "./install-ownership.js";
import {
  NpmUpgradeRegistry,
  type PlatformPackage,
  type RegistryFetch
} from "./npm-upgrade-registry.js";
import { applyRollback, applyUpgrade } from "./upgrade-apply.js";
import {
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

export { parseUpgradeArguments } from "./upgrade-command.js";
export type {
  ParsedUpgradeArguments,
  UpgradeApplyCommand,
  UpgradeCheckCommand,
  UpgradeCommand,
  UpgradeRollbackCommand
} from "./upgrade-command.js";

export const UPGRADE_HELP = `Usage:
  1667 upgrade --check [--channel <stable|beta>] [--json]
  1667 upgrade [--version <semver>] [--channel <stable|beta>] [--json]
  1667 upgrade --rollback [--json]

If you installed 1667 with npm, or you built it from source, update it the same
way you installed it.
On Windows, exit 1667 and run the PowerShell Installer again.`;

export function windowsInstallCommand(
  installRoot: string,
  targetVersion?: string
): string {
  if (targetVersion !== undefined && !isSemVer(targetVersion)) {
    throw new TypeError("Windows Installer target version must be SemVer");
  }
  const root = installRoot.replaceAll("'", "''");
  const installerUrl = targetVersion === undefined
    ? "https://1667.ai/install.ps1"
    : `https://github.com/1667-ai/1667/releases/download/v${
      encodeURIComponent(targetVersion)
    }/install-stable.ps1`;
  const script = `& ([scriptblock]::Create((irm ${installerUrl}))) `
    + "-InstallRoot '" + root + "'";
  return "powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand "
    + Buffer.from(script, "utf16le").toString("base64");
}

const INSTRUCTIONS_ORIGIN =
  `https://www.npmjs.com/package/${RELEASE_LAUNCHER_PACKAGE}/v`;

export interface UpgradeCliDependencies {
  readonly observation?: UpgradeObservation;
  readonly registry?: UpgradeRegistry;
  readonly authority?: InstallationAuthority;
  readonly fetcher?: RegistryFetch;
  readonly signal?: AbortSignal;
  readonly defaultChannel?: UpgradeChannel;
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
  const defaultChannel: UpgradeChannel = authority.kind === "shell"
    ? authority.record.channel
    : authority.kind === "powershell"
      ? authority.channel
      : configChannel;
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
  const registry = dependencies.registry ?? new NpmUpgradeRegistry(dependencies.fetcher);
  try {
    const envelope = await dispatchUpgradeCommand(
      parsed.command,
      authority,
      observation,
      method,
      registry,
      dependencies
    );
    return {
      exitCode: 0,
      stdout: parsed.json
        ? `${JSON.stringify(envelope)}\n`
        : renderUpgrade(envelope, parsed.command),
      stderr: "",
      envelope
    };
  } catch (error) {
    const failure = normalizeFailure(error);
    const exitCode = failure.code === "interrupted" ? 130 : 1;
    return failedOutput(
      failure,
      parsed.json,
      observation,
      upgradeCommandChannel(parsed.command, defaultChannel),
      method,
      exitCode
    );
  }
}

async function dispatchUpgradeCommand(
  command: UpgradeCommand,
  authority: InstallationAuthority,
  observation: UpgradeObservation,
  method: UpgradeMethod,
  registry: UpgradeRegistry,
  dependencies: UpgradeCliDependencies
): Promise<UpgradeSuccessEnvelope> {
  switch (command.kind) {
    case "rollback": {
      if (authority.kind === "powershell") {
        requireServableWindowsChannel(authority.channel);
        throw new UpgradeFailure(
          "unsupported_target",
          "Windows rollback is unavailable. Exit 1667, then run: "
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
        signal: dependencies.signal
      });
    }
    case "check": {
      const plan = await planUpgrade(
        command,
        observation,
        registry,
        dependencies.signal
      );
      if (method === "powershell" && plan.status !== "up-to-date") {
        requireServableWindowsChannel(plan.channel);
      }
      return publicEnvelopeFromPlan(plan, authority);
    }
    case "apply": {
      if (authority.kind === "shell") {
        return await applyUpgrade(command, {
          authority,
          observation,
          registry,
          fetcher: dependencies.fetcher,
          signal: dependencies.signal
        });
      }
      // External installs stay read-only: verify metadata, emit manual envelope.
      const plan = await planUpgrade(
        command,
        observation,
        registry,
        dependencies.signal
      );
      const channelSwitch = authority.kind === "powershell"
        && command.channel !== authority.channel;
      if (method === "powershell" && (plan.status !== "up-to-date" || channelSwitch)) {
        requireServableWindowsChannel(plan.channel);
      }
      return publicEnvelopeFromPlan(plan, authority, channelSwitch);
    }
  }
}

/**
 * Map a neutral plan to the public envelope. InstallationAuthority alone
 * decides method and whether a target is available or manual.
 */
export function publicEnvelopeFromPlan(
  plan: UpgradeCorePlan,
  authority: InstallationAuthority,
  forcePowerShellInstall = false
): UpgradeSuccessEnvelope {
  const method = authorityMethod(authority);
  if (forcePowerShellInstall && authority.kind === "powershell") {
    return upgradeEnvelope({
      status: "manual",
      current: plan.current,
      latest: plan.latest,
      target: plan.latest,
      channel: plan.channel,
      method: "powershell",
      command: windowsInstallCommand(authority.installRoot, plan.latest)
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
  if (method === "shell") {
    return upgradeEnvelope({
      status: "available",
      current: plan.current,
      latest: plan.latest,
      target: plan.target,
      channel: plan.channel
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
      command: windowsInstallCommand(authority.installRoot, plan.target)
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
 * `https://1667.ai/install.ps1` serves the one promoted release, which is the
 * stable channel. A beta PowerShell Installation therefore cannot be pointed at
 * it: the plan would verify a beta version and the command would install the
 * stable one, then rewrite the Ownership Record to `stable`. Refuse instead, and
 * name the attested asset that does carry the requested channel.
 */
function requireServableWindowsChannel(channel: UpgradeChannel): void {
  if (channel === "stable") return;
  throw new UpgradeFailure(
    "unsupported_target",
    `The Windows Installer route serves the stable channel only. `
    + `Download and attest install-${channel}.ps1 from the GitHub release, `
    + "then run it."
  );
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
    const output = await executeUpgradeCli(argv, {
      signal: controller.signal,
      registry: new NpmUpgradeRegistry(fetcher),
      fetcher,
      defaultChannel: loadConfig().updates.channel
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
          : `Upgraded 1667 from ${envelope.current} to ${envelope.target}.`
      );
      break;
    case "available":
    case "manual":
      lines.push(`1667 ${envelope.target} is available on ${envelope.channel}.`);
      break;
  }
  lines.push(
    envelope.method === "shell"
      ? "1667 installed this copy, so it can update it."
      : "1667 did not install this copy, so it cannot update it."
  );
  if (envelope.restartRequired) {
    lines.push("Restart 1667 to run the new version.");
  }
  if (command.kind === "check") {
    if (envelope.status === "manual") {
      if (envelope.method === "powershell") {
        lines.push("Exit 1667, then run:", envelope.command);
      } else {
        lines.push("Run '1667 upgrade' to see how to update.");
      }
    } else if (envelope.status === "available") {
      lines.push("Run '1667 upgrade' to install it.");
    }
    return `${lines.join("\n")}\n`;
  }
  if (envelope.status === "applied") {
    return `${lines.join("\n")}\n`;
  }
  if (envelope.status === "manual") {
    if (envelope.method === "powershell") {
      lines.push("Exit 1667, then run:");
      lines.push(envelope.command);
      return `${lines.join("\n")}\n`;
    }
    lines.push(`Instructions: ${instructionsUrl(envelope.target)}`);
    lines.push("Start 1667 again after you update it.");
  }
  return `${lines.join("\n")}\n`;
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

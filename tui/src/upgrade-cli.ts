import { isSemVer } from "../../shared/semver.js";
import { AI_1667_PRODUCT_VERSION } from "../../shared/build-identity.js";
import {
  RELEASE_LAUNCHER_PACKAGE,
  releaseTargetForRuntime
} from "../../shared/release-targets.js";
import { loadConfig } from "./config.js";
import {
  NpmUpgradeRegistry,
  type PlatformPackage,
  type RegistryFetch
} from "./npm-upgrade-registry.js";
import {
  UPGRADE_CHANNELS,
  UpgradeFailure,
  upgradeErrorEnvelope,
  type UpgradeChannel,
  type UpgradeEnvelope,
  type UpgradeSuccessEnvelope
} from "./upgrade-contract.js";
import {
  planUpgrade,
  type UpgradeObservation,
  type UpgradeRegistry,
  type UpgradeRequest
} from "./upgrade-plan.js";

export const UPGRADE_HELP = `Usage:
  1667 upgrade --check [--channel <stable|beta>] [--json]
  1667 upgrade [--version <semver>] [--channel <stable|beta>] [--json]

Phase one is read-only. It never installs software or emits an upgrade command.`;

const INSTRUCTIONS_ORIGIN =
  `https://www.npmjs.com/package/${RELEASE_LAUNCHER_PACKAGE}/v`;

export interface UpgradeCliDependencies {
  readonly observation?: UpgradeObservation;
  readonly registry?: UpgradeRegistry;
  readonly signal?: AbortSignal;
  readonly defaultChannel?: UpgradeChannel;
}

export interface UpgradeCliOutput {
  readonly exitCode: 0 | 1 | 2 | 130;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: UpgradeEnvelope | null;
}

export async function executeUpgradeCli(
  argv: readonly string[],
  dependencies: UpgradeCliDependencies = {}
): Promise<UpgradeCliOutput> {
  const wantsJson = argv.includes("--json");
  const defaultChannel = dependencies.defaultChannel ?? "stable";
  let parsed: UpgradeRequest | null;
  try {
    parsed = parseUpgradeArguments(argv, defaultChannel);
  } catch (error) {
    const failure = normalizeFailure(error);
    return failedOutput(
      failure,
      wantsJson,
      { currentVersion: AI_1667_PRODUCT_VERSION },
      partialChannel(argv, defaultChannel),
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
      wantsJson,
      { currentVersion: AI_1667_PRODUCT_VERSION },
      parsed.channel,
      1
    );
  }
  try {
    const envelope = await planUpgrade(
      parsed,
      observation,
      dependencies.registry ?? new NpmUpgradeRegistry(),
      dependencies.signal
    );
    return {
      exitCode: 0,
      stdout: wantsJson ? `${JSON.stringify(envelope)}\n` : renderUpgrade(envelope, parsed.check),
      stderr: "",
      envelope
    };
  } catch (error) {
    const failure = normalizeFailure(error);
    const exitCode = failure.code === "interrupted" ? 130 : 1;
    return failedOutput(failure, wantsJson, observation, parsed.channel, exitCode);
  }
}

export async function runProcessUpgrade(
  argv: readonly string[],
  fetcher?: RegistryFetch
): Promise<void> {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  try {
    const output = await executeUpgradeCli(argv, {
      signal: controller.signal,
      registry: new NpmUpgradeRegistry(fetcher),
      defaultChannel: loadConfig().updates.channel
    });
    if (output.stdout.length > 0) process.stdout.write(output.stdout);
    if (output.stderr.length > 0) process.stderr.write(output.stderr);
    process.exitCode = output.exitCode;
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}

export function parseUpgradeArguments(
  argv: readonly string[],
  defaultChannel: UpgradeChannel = "stable"
): UpgradeRequest | null {
  let check = false;
  let checkSeen = false;
  let jsonSeen = false;
  let version: string | null = null;
  let channel = defaultChannel;
  let channelSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "-h" || argument === "--help") {
      if (argv.length !== 1) throw invalidArguments("--help cannot be combined with other options.");
      return null;
    }
    if (argument === "--check") {
      if (checkSeen) throw invalidArguments("--check may be specified only once.");
      check = true;
      checkSeen = true;
    } else if (argument === "--json") {
      if (jsonSeen) throw invalidArguments("--json may be specified only once.");
      jsonSeen = true;
    } else if (argument === "--version" || argument.startsWith("--version=")) {
      if (version !== null) throw invalidArguments("--version may be specified only once.");
      version = optionValue(argument, "--version", () => argv[++index]);
      if (version.length > 128 || !isSemVer(version)) {
        throw invalidArguments("--version requires a strict semantic version.");
      }
    } else if (argument === "--channel" || argument.startsWith("--channel=")) {
      if (channelSeen) throw invalidArguments("--channel may be specified only once.");
      const value = optionValue(argument, "--channel", () => argv[++index]);
      if (!(UPGRADE_CHANNELS as readonly string[]).includes(value)) {
        throw invalidArguments("--channel must be stable or beta.");
      }
      channel = value as UpgradeChannel;
      channelSeen = true;
    } else {
      throw invalidArguments(`Unknown upgrade option: ${argument}`);
    }
  }
  if (check && version !== null) {
    throw invalidArguments("--check and --version cannot be used together.");
  }
  return { check, version, channel };
}

function optionValue(
  argument: string,
  option: string,
  next: () => string | undefined
): string {
  if (argument.startsWith(`${option}=`)) {
    const value = argument.slice(option.length + 1);
    if (value.length === 0) throw invalidArguments(`${option} requires a value.`);
    return value;
  }
  const value = next();
  if (value === undefined || value.startsWith("--")) {
    throw invalidArguments(`${option} requires a value.`);
  }
  return value;
}

function renderUpgrade(envelope: UpgradeSuccessEnvelope, checkOnly: boolean): string {
  const lines: string[] = [];
  if (envelope.status === "up-to-date") {
    lines.push(`1667 ${envelope.current} is up to date on ${envelope.channel}.`);
  } else {
    lines.push(`1667 ${envelope.target} is available on ${envelope.channel}.`);
  }
  lines.push(`Install method: ${envelope.method}.`);
  if (checkOnly) {
    if (envelope.status === "manual") {
      lines.push("Run '1667 upgrade' for a fresh, exact read-only plan.");
    }
    return `${lines.join("\n")}\n`;
  }
  lines.push("Verified metadata source: canonical npm registry.");
  if (envelope.status === "manual") {
    lines.push(`Instructions: ${instructionsUrl(envelope.target)}`);
    lines.push(
      "Any external reinstall is outside 1667's trust boundary; launch 1667 again afterward."
    );
  }
  return `${lines.join("\n")}\n`;
}

function instructionsUrl(version: string): string {
  return `${INSTRUCTIONS_ORIGIN}/${encodeURIComponent(version)}`;
}

function failedOutput(
  failure: UpgradeFailure,
  json: boolean,
  observation: { currentVersion: string | null },
  channel: UpgradeChannel | null,
  exitCode: 1 | 2 | 130
): UpgradeCliOutput {
  const envelope = upgradeErrorEnvelope(failure, {
    current: isSemVer(observation.currentVersion) ? observation.currentVersion : null,
    channel
  });
  return {
    exitCode,
    stdout: json ? `${JSON.stringify(envelope)}\n` : "",
    stderr: json ? "" : `1667 upgrade: ${failure.message}\n`,
    envelope
  };
}

function defaultObservation(): UpgradeObservation {
  const platformPackage = currentPlatformPackage();
  if (platformPackage === null) {
    throw new UpgradeFailure("unsupported_target", "This platform is not supported for releases.");
  }
  // Installer ownership and managed application require a separate decision.
  // This command is deliberately manual and read-only for every launch.
  return {
    currentVersion: AI_1667_PRODUCT_VERSION,
    platformPackage
  };
}

export function currentPlatformPackage(
  platform = process.platform,
  arch = process.arch
): PlatformPackage | null {
  return releaseTargetForRuntime(platform, arch)?.packageName ?? null;
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

function invalidArguments(message: string): UpgradeFailure {
  return new UpgradeFailure("invalid_arguments", message);
}

function normalizeFailure(error: unknown): UpgradeFailure {
  if (error instanceof UpgradeFailure) return error;
  return new UpgradeFailure("internal_error", "The upgrade check failed unexpectedly.");
}

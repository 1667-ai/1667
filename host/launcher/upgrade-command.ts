import { isSemVer } from "../../shared/semver.js";
import {
  UPGRADE_CHANNELS,
  UpgradeFailure,
  type UpgradeChannel
} from "./upgrade-contract.js";

/** Read-only channel check. Does not apply a Candidate. */
export interface UpgradeCheckCommand {
  readonly kind: "check";
  readonly channel: UpgradeChannel;
}

/** List published releases. Does not change the installation. */
export interface UpgradeListCommand {
  readonly kind: "list";
}

/** Apply or plan a channel head or one exact published version. */
export interface UpgradeApplyCommand {
  readonly kind: "apply";
  readonly channel: UpgradeChannel;
  readonly version: string | null;
}

/** Restore the previous executable of a Managed Installation. */
export interface UpgradeRollbackCommand {
  readonly kind: "rollback";
}

/**
 * Canonical upgrade CLI command. Impossible combinations never leave the
 * parser: check cannot carry a version, and rollback carries no channel or
 * version flags.
 */
export type UpgradeCommand =
  | UpgradeCheckCommand
  | UpgradeListCommand
  | UpgradeApplyCommand
  | UpgradeRollbackCommand;

export type UpgradePlanCommand = UpgradeCheckCommand | UpgradeApplyCommand;

/** Format one typed apply command for a terminal. */
export function formatUpgradeApplyCommand(command: UpgradeApplyCommand): string {
  if (command.version !== null && !isSemVer(command.version)) {
    throw new TypeError("Upgrade command version must be SemVer");
  }
  const version = command.version === null
    ? ""
    : ` --version ${command.version}`;
  return `1667 upgrade${version} --channel ${command.channel}`;
}

/** Parser result. JSON format is orthogonal to the command. */
export interface ParsedUpgradeArguments {
  readonly command: UpgradeCommand;
  readonly json: boolean;
  /**
   * `--force`: accept an Install Root that another account can write. It waives
   * that refusal and nothing else. A checksum, an attestation, a release
   * identity, and the version probe all still decide whether the bytes are the
   * release, which no local decision can answer.
   */
  readonly force: boolean;
}

/**
 * Parse upgrade argv into a typed command. Returns null for help.
 * Rejects duplicate flags and impossible flag combinations.
 */
export function parseUpgradeArguments(
  argv: readonly string[],
  defaultChannel: UpgradeChannel = "stable"
): ParsedUpgradeArguments | null {
  let check = false;
  let checkSeen = false;
  let jsonSeen = false;
  let list = false;
  let listSeen = false;
  let rollback = false;
  let rollbackSeen = false;
  let version: string | null = null;
  let channel = defaultChannel;
  let channelSeen = false;
  let forceSeen = false;
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
    } else if (argument === "--list") {
      if (listSeen) throw invalidArguments("--list may be specified only once.");
      list = true;
      listSeen = true;
    } else if (argument === "--rollback") {
      if (rollbackSeen) throw invalidArguments("--rollback may be specified only once.");
      rollback = true;
      rollbackSeen = true;
    } else if (argument === "--json") {
      if (jsonSeen) throw invalidArguments("--json may be specified only once.");
      jsonSeen = true;
    } else if (argument === "--force") {
      if (forceSeen) throw invalidArguments("--force may be specified only once.");
      forceSeen = true;
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
  if (list && (check || rollback || version !== null || channelSeen)) {
    throw invalidArguments("--list cannot be combined with --check, --rollback, --version, or --channel.");
  }
  if (rollback && (check || version !== null || channelSeen)) {
    throw invalidArguments("--rollback cannot be combined with --check, --version, or --channel.");
  }
  // A read-only check writes nothing, so waiving a write refusal means nothing
  // there. Saying so beats accepting a flag that does nothing.
  if (forceSeen && (check || list)) {
    throw invalidArguments(`--force cannot be used with --${list ? "list" : "check"}, which changes no file.`);
  }
  if (list) {
    return Object.freeze({
      command: Object.freeze({ kind: "list" as const }),
      json: jsonSeen,
      force: false
    });
  }
  if (rollback) {
    return Object.freeze({
      command: Object.freeze({ kind: "rollback" as const }),
      json: jsonSeen,
      force: forceSeen
    });
  }
  if (check) {
    return Object.freeze({
      command: Object.freeze({ kind: "check" as const, channel }),
      json: jsonSeen,
      force: false
    });
  }
  return Object.freeze({
    command: Object.freeze({ kind: "apply" as const, channel, version }),
    json: jsonSeen,
    force: forceSeen
  });
}

/** Channel for error envelopes. Rollback has no channel flag. */
export function upgradeCommandChannel(
  command: UpgradeCommand,
  fallback: UpgradeChannel
): UpgradeChannel {
  switch (command.kind) {
    case "check":
    case "apply":
      return command.channel;
    case "list":
      return fallback;
    case "rollback":
      return fallback;
  }
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

function invalidArguments(message: string): UpgradeFailure {
  return new UpgradeFailure("invalid_arguments", message);
}

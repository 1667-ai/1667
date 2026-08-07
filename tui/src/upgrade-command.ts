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

/** Apply or plan an upgrade for a channel head or exact version. */
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
  | UpgradeApplyCommand
  | UpgradeRollbackCommand;

export type UpgradePlanCommand = UpgradeCheckCommand | UpgradeApplyCommand;

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
  if (rollback && (check || version !== null || channelSeen)) {
    throw invalidArguments("--rollback cannot be combined with --check, --version, or --channel.");
  }
  // A read-only check writes nothing, so waiving a write refusal means nothing
  // there. Saying so beats accepting a flag that does nothing.
  if (forceSeen && check) {
    throw invalidArguments("--force cannot be used with --check, which changes no file.");
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

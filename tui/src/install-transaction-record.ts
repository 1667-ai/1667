/**
 * Shared on-disk Install Transaction Record contract.
 * Shell Installer and managed upgrade records share one file name and one
 * explicit kind discriminant. Parse once into a typed union.
 */
import { parseJsonRejectingDuplicateKeys } from "../../shared/strict-json.js";
import { isSemVer } from "../../shared/semver.js";
import {
  isBuiltArtifactTarget,
  type BuiltArtifactTarget
} from "../../shared/release-targets.js";
import type { InstallChannel } from "../../shared/install-ownership-record.js";

export type ShellInstallerTxnPhase =
  | "downloading"
  | "extracted"
  | "candidate-ready"
  | "activated";

export type ManagedTransactionPhase = "candidate-ready" | "ownership-pending";

export interface ShellInstallerTransactionRecord {
  readonly kind: "shell-installer";
  readonly schemaVersion: 1;
  readonly phase: ShellInstallerTxnPhase;
  readonly version: string;
  readonly channel: InstallChannel;
  readonly artifactTarget: BuiltArtifactTarget;
  readonly archiveSha256: string;
  readonly installRoot: string;
  readonly executable: string;
}

/** Managed upgrade or rollback Transaction Record. */
export interface InstallTransactionRecord {
  readonly kind: "managed";
  readonly schemaVersion: 1;
  readonly phase: ManagedTransactionPhase;
  readonly operation: "upgrade" | "rollback";
  readonly channel: InstallChannel;
  readonly updateChannel: boolean;
  readonly activeVersion: string;
  readonly candidateVersion: string;
  readonly installationId: string;
  readonly installRoot: string;
  readonly executable: string;
  readonly artifactTarget: BuiltArtifactTarget;
}

export type InstallTransactionFileRecord =
  | ShellInstallerTransactionRecord
  | InstallTransactionRecord;

const SHELL_TXN_KEYS = new Set([
  "kind",
  "schemaVersion",
  "phase",
  "version",
  "channel",
  "artifactTarget",
  "archiveSha256",
  "installRoot",
  "executable"
]);

const MANAGED_TXN_KEYS = new Set([
  "kind",
  "schemaVersion",
  "phase",
  "operation",
  "channel",
  "updateChannel",
  "activeVersion",
  "candidateVersion",
  "installationId",
  "installRoot",
  "executable",
  "artifactTarget"
]);

const SHA256 = /^[0-9a-f]{64}$/;

const SHELL_PHASES = new Set<ShellInstallerTxnPhase>([
  "downloading",
  "extracted",
  "candidate-ready",
  "activated"
]);

/**
 * Parses Transaction Record text into a typed kind discriminant.
 * Unknown kind, extra fields, and missing fields fail closed.
 */
export function parseInstallTransactionFileRecord(
  text: string
): InstallTransactionFileRecord {
  const value = parseJsonRejectingDuplicateKeys(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Transaction Record must be an object");
  }
  const input = value as Record<string, unknown>;
  const kind = input.kind;
  if (kind !== "shell-installer" && kind !== "managed") {
    throw new Error("Transaction Record kind is unsupported");
  }
  switch (kind) {
    case "shell-installer":
      return parseShellInstallerFields(input);
    case "managed":
      return parseManagedFields(input);
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Transaction Record kind is unsupported: ${String(_exhaustive)}`);
    }
  }
}

function assertExactKeys(
  input: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string
): void {
  const keys = Object.keys(input);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function parseShellInstallerFields(
  input: Record<string, unknown>
): ShellInstallerTransactionRecord {
  assertExactKeys(input, SHELL_TXN_KEYS, "Shell Installer transaction");
  if (input.schemaVersion !== 1) {
    throw new Error("Shell Installer transaction schema is unsupported");
  }
  if (typeof input.phase !== "string" || !SHELL_PHASES.has(input.phase as ShellInstallerTxnPhase)) {
    throw new Error("Shell Installer transaction phase is invalid");
  }
  if (typeof input.version !== "string" || !isSemVer(input.version)) {
    throw new Error("Shell Installer transaction version is invalid");
  }
  if (input.channel !== "stable" && input.channel !== "beta") {
    throw new Error("Shell Installer transaction channel is invalid");
  }
  if (!isBuiltArtifactTarget(input.artifactTarget)) {
    throw new Error("Shell Installer transaction artifact target is invalid");
  }
  if (typeof input.archiveSha256 !== "string" || !SHA256.test(input.archiveSha256)) {
    throw new Error("Shell Installer transaction digest is invalid");
  }
  if (typeof input.installRoot !== "string" || typeof input.executable !== "string") {
    throw new Error("Shell Installer transaction paths are invalid");
  }
  return Object.freeze({
    kind: "shell-installer",
    schemaVersion: 1,
    phase: input.phase as ShellInstallerTxnPhase,
    version: input.version,
    channel: input.channel,
    artifactTarget: input.artifactTarget,
    archiveSha256: input.archiveSha256,
    installRoot: input.installRoot,
    executable: input.executable
  });
}

function parseManagedFields(input: Record<string, unknown>): InstallTransactionRecord {
  assertExactKeys(input, MANAGED_TXN_KEYS, "Transaction Record");
  if (input.schemaVersion !== 1) throw new Error("Transaction Record schema is unsupported");
  if (input.phase !== "candidate-ready" && input.phase !== "ownership-pending") {
    throw new Error("Transaction Record phase is invalid");
  }
  if (input.operation !== "upgrade" && input.operation !== "rollback") {
    throw new Error("Transaction Record operation is invalid");
  }
  if (typeof input.activeVersion !== "string" || !isSemVer(input.activeVersion)) {
    throw new Error("Transaction Record active version is invalid");
  }
  if (typeof input.candidateVersion !== "string" || !isSemVer(input.candidateVersion)) {
    throw new Error("Transaction Record candidate version is invalid");
  }
  if (input.channel !== "stable" && input.channel !== "beta") {
    throw new Error("Transaction Record channel is invalid");
  }
  if (typeof input.updateChannel !== "boolean") {
    throw new Error("Transaction Record updateChannel is invalid");
  }
  if (typeof input.installationId !== "string"
    || typeof input.installRoot !== "string"
    || typeof input.executable !== "string") {
    throw new Error("Transaction Record paths are invalid");
  }
  if (!isBuiltArtifactTarget(input.artifactTarget)) {
    throw new Error("Transaction Record artifact target is invalid");
  }
  return Object.freeze({
    kind: "managed",
    schemaVersion: 1,
    phase: input.phase,
    operation: input.operation,
    channel: input.channel,
    updateChannel: input.updateChannel,
    activeVersion: input.activeVersion,
    candidateVersion: input.candidateVersion,
    installationId: input.installationId,
    installRoot: input.installRoot,
    executable: input.executable,
    artifactTarget: input.artifactTarget
  });
}

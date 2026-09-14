/**
 * Shell Installer activated-transaction finalization and shared txn file read.
 * Record shape and parse live in install-transaction-record.
 */
import { lstatSync, readFileSync } from "node:fs";
import { readReleaseExecutableIdentity } from "../../shared/executable-probe.js";
import {
  fsyncDirectory,
  removeQuietly
} from "../../shared/safe-file-write.js";
import type { InstallationAuthority } from "./install-ownership.js";
import type { ManagedInstallPaths } from "./install-layout.js";
import type { ShellInstallerTransactionRecord } from "./install-transaction-record.js";

export type {
  ShellInstallerTxnPhase,
  ShellInstallerTransactionRecord
} from "./install-transaction-record.js";

/**
 * Finalizes a post-ownership Shell Installer activated transaction left after
 * SIGINT: prove active identity matches, clear the txn durably, and return so
 * the current managed command can continue (not as a managed upgrade recovery).
 */
export async function finalizeShellInstallerActivatedTransaction(
  record: ShellInstallerTransactionRecord,
  authority: Extract<InstallationAuthority, { kind: "shell" }>,
  paths: ManagedInstallPaths,
  signal: AbortSignal
): Promise<void> {
  if (record.phase !== "activated") {
    throw new Error("Shell Installer transaction phase is not activated");
  }
  if (record.installRoot !== authority.installRoot
    || record.executable !== authority.executable
    || record.artifactTarget !== authority.record.artifactTarget
    || record.channel !== authority.record.channel) {
    throw new Error("Shell Installer transaction does not match the Ownership Record");
  }
  const identity = await readReleaseExecutableIdentity(paths.active, { signal });
  if (identity.productVersion !== record.version
    || identity.artifactTarget !== record.artifactTarget) {
    throw new Error(
      "Shell Installer transaction version does not match the active executable"
    );
  }
  removeQuietly(paths.candidate);
  removeQuietly(paths.packageStaging);
  removeQuietly(paths.previousNext);
  removeQuietly(paths.transaction);
  fsyncDirectory(paths.installRoot);
}

/**
 * Read txn path only when it is a regular non-symlink file.
 * Returns null only for ENOENT; every other failure propagates.
 */
export function readTransactionText(paths: ManagedInstallPaths): string | null {
  let stats;
  try {
    stats = lstatSync(paths.transaction);
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("Install transaction must be a regular non-symlink file");
  }
  try {
    return readFileSync(paths.transaction, "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

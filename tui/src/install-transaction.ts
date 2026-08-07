import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  readFileSync,
  renameSync
} from "node:fs";
import path from "node:path";
import {
  createInstallOwnershipRecord,
  INSTALL_OWNERSHIP_FILE,
  parseInstallOwnershipRecordText,
  type InstallChannel,
  type InstallOwnershipRecord
} from "../../shared/install-ownership-record.js";
import {
  fsyncDirectory,
  fsyncPath,
  openExclusiveWrite,
  removeQuietly,
  writeAll,
  writeExclusiveFile
} from "../../shared/safe-file-write.js";
import {
  probeReleaseExecutable,
  readReleaseExecutableIdentity
} from "../../shared/executable-probe.js";
export { acquireInstallationLock, type InstallationLock } from "./install-lock.js";
import {
  writeOwnershipRecordAtomic,
  type InstallationAuthority
} from "./install-ownership.js";
import type { ManagedInstallPaths } from "./install-layout.js";
import { assertSafeInstallRoot, assertSafeOwnedPath } from "./install-path-safety.js";
import {
  parseInstallTransactionFileRecord,
  type InstallTransactionRecord
} from "./install-transaction-record.js";
import {
  finalizeShellInstallerActivatedTransaction,
  readTransactionText
} from "./shell-install-txn.js";
import { UpgradeFailure } from "./upgrade-contract.js";

export type {
  InstallTransactionRecord,
  ManagedTransactionPhase as TransactionPhase
} from "./install-transaction-record.js";

export type RecoveryOutcome =
  | { readonly kind: "clean" }
  | { readonly kind: "shell-installer-finalized" }
  | {
      readonly kind: "completed";
      readonly operation: "upgrade" | "rollback";
      readonly fromVersion: string;
      readonly toVersion: string;
      /** Transaction request channel; independent of Ownership Record channel. */
      readonly requestChannel: InstallChannel;
    };

export function readTransactionRecord(
  paths: ManagedInstallPaths
): InstallTransactionRecord | null {
  const text = readTransactionText(paths);
  if (text === null) return null;
  const record = parseInstallTransactionFileRecord(text);
  switch (record.kind) {
    case "managed":
      return record;
    case "shell-installer":
      throw new Error(
        "Transaction Record is a Shell Installer record, not a managed upgrade record"
      );
    default: {
      const _exhaustive: never = record;
      throw new Error(`Unhandled Transaction Record kind: ${String(_exhaustive)}`);
    }
  }
}

export function writeTransactionRecord(
  paths: ManagedInstallPaths,
  record: InstallTransactionRecord
): void {
  const temporary = `${paths.transaction}.${process.pid}.tmp`;
  removeQuietly(temporary);
  writeExclusiveFile({
    path: temporary,
    data: `${JSON.stringify(record)}\n`,
    mode: 0o600,
    finalPath: paths.transaction
  });
  fsyncDirectory(paths.installRoot);
}

export function clearTransactionRecord(paths: ManagedInstallPaths): void {
  removeQuietly(paths.transaction);
  fsyncDirectory(paths.installRoot);
}

/**
 * Completes or aborts an interrupted managed mutation by probing active.
 * Finalizes a reachable Shell Installer activated txn (ownership already
 * written) and returns shell-installer-finalized so the current command can
 * continue without treating that event as managed recovery or a clean root.
 */
export async function recoverInstallationTransaction(
  authority: Extract<InstallationAuthority, { kind: "shell" }>,
  paths: ManagedInstallPaths,
  signal: AbortSignal = new AbortController().signal
): Promise<RecoveryOutcome> {
  const text = readTransactionText(paths);
  if (text === null) {
    removeQuietly(paths.candidate);
    removeQuietly(paths.packageStaging);
    removeQuietly(paths.previousNext);
    return { kind: "clean" };
  }

  const record = parseInstallTransactionFileRecord(text);
  switch (record.kind) {
    case "shell-installer":
      await finalizeShellInstallerActivatedTransaction(
        record,
        authority,
        paths,
        signal
      );
      return { kind: "shell-installer-finalized" };
    case "managed":
      return await recoverManagedTransaction(record, authority, paths, signal);
    default: {
      const _exhaustive: never = record;
      throw new Error(`Unhandled Transaction Record kind: ${String(_exhaustive)}`);
    }
  }
}

async function recoverManagedTransaction(
  txn: InstallTransactionRecord,
  authority: Extract<InstallationAuthority, { kind: "shell" }>,
  paths: ManagedInstallPaths,
  signal: AbortSignal
): Promise<RecoveryOutcome> {
  assertTxnMatchesAuthority(txn, authority);

  if (txn.phase === "candidate-ready") {
    const active = await readReleaseExecutableIdentity(paths.active, { signal });
    if (active.artifactTarget !== txn.artifactTarget) {
      throw new Error("Active executable target does not match the Transaction Record");
    }
    if (active.productVersion === txn.activeVersion) {
      // Activation never happened: drop staging, keep old previous.
      removeQuietly(paths.candidate);
      removeQuietly(paths.previousNext);
      removeQuietly(paths.packageStaging);
      clearTransactionRecord(paths);
      return { kind: "clean" };
    }
    if (active.productVersion === txn.candidateVersion) {
      return await finishPromotedActivation(txn, authority, paths, signal);
    }
    throw new Error("Active executable version does not match the Transaction Record");
  }

  if (txn.phase === "ownership-pending") {
    await probeReleaseExecutable(paths.active, {
      version: txn.candidateVersion,
      artifactTarget: txn.artifactTarget
    }, { signal });
    return await finishPromotedActivation(txn, authority, paths, signal);
  }

  throw new Error("Install transaction phase is unsupported");
}

async function finishPromotedActivation(
  txn: InstallTransactionRecord,
  authority: Extract<InstallationAuthority, { kind: "shell" }>,
  paths: ManagedInstallPaths,
  signal: AbortSignal
): Promise<RecoveryOutcome> {
  // Fail closed unless a verified rollback executable exists at previousNext
  // or previous, probing exactly as activeVersion (the pre-mutation active).
  if (existsSync(paths.previousNext)) {
    await probeReleaseExecutable(paths.previousNext, {
      version: txn.activeVersion,
      artifactTarget: txn.artifactTarget
    }, { signal });
    renameSync(paths.previousNext, paths.previous);
    fsyncPath(paths.previous);
    fsyncDirectory(paths.installRoot);
  } else if (existsSync(paths.previous)) {
    await probeReleaseExecutable(paths.previous, {
      version: txn.activeVersion,
      artifactTarget: txn.artifactTarget
    }, { signal });
  } else {
    throw new Error(
      "Ownership-pending recovery has no verified rollback executable"
    );
  }
  writeOwnershipRecordAtomic(ownershipFromTxn(txn, authority.record));
  removeQuietly(paths.candidate);
  removeQuietly(paths.packageStaging);
  removeQuietly(paths.previousNext);
  clearTransactionRecord(paths);
  // Always the transaction request channel. Ownership persistence stays under
  // updateChannel (ownershipFromTxn); an exact-version beta upgrade from a
  // stable install still recovers as beta even when Ownership stays stable.
  return {
    kind: "completed",
    operation: txn.operation,
    fromVersion: txn.activeVersion,
    toVersion: txn.candidateVersion,
    requestChannel: txn.channel
  };
}

export async function activateCandidate(input: {
  readonly authority: Extract<InstallationAuthority, { kind: "shell" }>;
  readonly paths: ManagedInstallPaths;
  readonly operation: "upgrade" | "rollback";
  readonly activeVersion: string;
  readonly candidateVersion: string;
  readonly channel: InstallChannel;
  readonly updateChannel: boolean;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const { paths } = input;
  const signal = input.signal ?? new AbortController().signal;
  if (!isRegularExecutable(paths.candidate)) {
    throw new Error("Candidate is missing or not executable");
  }
  assertRegularNonSymlinkFile(paths.active, "Active executable");
  const base = {
    kind: "managed" as const,
    schemaVersion: 1 as const,
    operation: input.operation,
    channel: input.channel,
    updateChannel: input.updateChannel,
    activeVersion: input.activeVersion,
    candidateVersion: input.candidateVersion,
    installationId: input.authority.record.installationId,
    installRoot: input.authority.record.installRoot,
    executable: input.authority.record.executable,
    artifactTarget: input.authority.record.artifactTarget
  };

  // Stage previousNext; cancel only before candidate-ready is published.
  removeQuietly(paths.previousNext);
  try {
    await copyExclusive(paths.active, paths.previousNext, 0o755, signal);
  } catch (error) {
    removeQuietly(paths.previousNext);
    throw error;
  }
  if (signal.aborted) {
    removeQuietly(paths.previousNext);
    throw interruptedFailure();
  }
  writeTransactionRecord(paths, { ...base, phase: "candidate-ready" });
  // Commit published: finish even if the signal aborts after this point.
  renameSync(paths.candidate, paths.active);
  fsyncPath(paths.active);
  fsyncDirectory(paths.installRoot);

  writeTransactionRecord(paths, { ...base, phase: "ownership-pending" });

  // Only after activation succeeds, promote previousNext over previous.
  renameSync(paths.previousNext, paths.previous);
  fsyncPath(paths.previous);
  fsyncDirectory(paths.installRoot);

  writeOwnershipRecordAtomic(createInstallOwnershipRecord({
    installationId: input.authority.record.installationId,
    channel: input.updateChannel ? input.channel : input.authority.record.channel,
    installRoot: input.authority.record.installRoot,
    executable: input.authority.record.executable,
    artifactTarget: input.authority.record.artifactTarget
  }));
  clearTransactionRecord(paths);
  removeQuietly(paths.packageStaging);
}

export function revalidateAuthorityAfterLock(
  expected: Extract<InstallationAuthority, { kind: "shell" }>,
  force = false
): Extract<InstallationAuthority, { kind: "shell" }> {
  const record = readManagedOwnershipUnderLock(expected, force);
  if (record.channel !== expected.record.channel
    || record.product !== expected.record.product) {
    throw new Error("Managed Installation authority changed under the lock");
  }
  return shellAuthorityFromOwnership(expected, record);
}

/** Reload Ownership after opposite-operation recovery (channel may change). */
export function reloadAuthorityAfterRecovery(
  expected: Extract<InstallationAuthority, { kind: "shell" }>,
  force = false
): Extract<InstallationAuthority, { kind: "shell" }> {
  return shellAuthorityFromOwnership(
    expected,
    readManagedOwnershipUnderLock(expected, force)
  );
}

function readManagedOwnershipUnderLock(
  expected: Extract<InstallationAuthority, { kind: "shell" }>,
  force = false
): InstallOwnershipRecord {
  assertSafeInstallRoot(expected.installRoot, force);
  const ownershipPath = path.join(expected.installRoot, INSTALL_OWNERSHIP_FILE);
  assertSafeOwnedPath(ownershipPath, {
    label: "Ownership Record",
    requireFile: true,
    expectedModeMask: 0o600,
    force
  });
  assertSafeOwnedPath(expected.executable, {
    label: "managed executable",
    requireFile: true,
    force
  });
  const record = parseInstallOwnershipRecordText(readFileSync(ownershipPath, "utf8"));
  if (record.installationId !== expected.record.installationId
    || record.installRoot !== expected.installRoot
    || record.executable !== expected.executable
    || record.artifactTarget !== expected.record.artifactTarget
    || record.method !== "shell"
    || record.product !== expected.record.product) {
    throw new Error("Managed Installation authority changed under the lock");
  }
  return record;
}

function shellAuthorityFromOwnership(
  expected: Extract<InstallationAuthority, { kind: "shell" }>,
  record: InstallOwnershipRecord
): Extract<InstallationAuthority, { kind: "shell" }> {
  return {
    kind: "shell",
    record,
    installRoot: expected.installRoot,
    executable: expected.executable
  };
}

export async function copyExclusive(
  source: string,
  destination: string,
  mode: 0o600 | 0o755,
  signal: AbortSignal = new AbortController().signal
): Promise<void> {
  if (signal.aborted) throw interruptedFailure();
  assertRegularNonSymlinkFile(source, "Copy source");
  const fd = openExclusiveWrite(destination, mode);
  try {
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(source);
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        stream.destroy();
        reject(error);
      };
      const onAbort = () => fail(interruptedFailure());
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }
      stream.on("data", (chunk: string | Buffer) => {
        if (signal.aborted) { fail(interruptedFailure()); return; }
        try {
          writeAll(fd, typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        } catch (error) {
          fail(error);
        }
      });
      stream.on("error", fail);
      stream.on("end", () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
    });
    fsyncSync(fd);
  } catch (error) {
    try { closeSync(fd); } catch { /* best effort */ }
    removeQuietly(destination);
    throw error;
  }
  closeSync(fd);
  fsyncPath(destination);
}

function interruptedFailure(): UpgradeFailure {
  return new UpgradeFailure("interrupted", "The update was interrupted.");
}

function ownershipFromTxn(
  txn: InstallTransactionRecord,
  current: InstallOwnershipRecord
): InstallOwnershipRecord {
  return createInstallOwnershipRecord({
    installationId: txn.installationId,
    channel: txn.updateChannel ? txn.channel : current.channel,
    installRoot: txn.installRoot,
    executable: txn.executable,
    artifactTarget: txn.artifactTarget
  });
}

function assertTxnMatchesAuthority(
  txn: InstallTransactionRecord,
  authority: Extract<InstallationAuthority, { kind: "shell" }>
): void {
  if (txn.installationId !== authority.record.installationId
    || txn.installRoot !== authority.installRoot
    || txn.executable !== authority.executable
    || txn.artifactTarget !== authority.record.artifactTarget) {
    throw new Error("Transaction Record does not match the Ownership Record");
  }
}

function isRegularExecutable(filePath: string): boolean {
  try {
    const stats = lstatSync(filePath);
    return stats.isFile() && !stats.isSymbolicLink() && (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function assertRegularNonSymlinkFile(filePath: string, label: string): void {
  let stats;
  try {
    stats = lstatSync(filePath);
  } catch {
    throw new Error(`${label} is missing`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
}

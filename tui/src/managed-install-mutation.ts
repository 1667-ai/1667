/**
 * Canonical managed-install mutation boundary: lock, revalidate, recover,
 * optional completed early result, reload after opposite completion, probe
 * active, run operation work, always release.
 */
import type { InstallationAuthority } from "./install-ownership.js";
import {
  acquireInstallationLock,
  recoverInstallationTransaction,
  reloadAuthorityAfterRecovery,
  revalidateAuthorityAfterLock,
  type InstallationLock,
  type RecoveryOutcome
} from "./install-transaction.js";
import type { ManagedInstallPaths } from "./install-layout.js";
import { readReleaseExecutableIdentity } from "../../shared/executable-probe.js";
import { UpgradeFailure, type UpgradeSuccessEnvelope } from "./upgrade-contract.js";
import { throwUpgradeProbeFailure } from "./upgrade-probe-errors.js";

export type ShellAuthority = Extract<InstallationAuthority, { kind: "shell" }>;

export interface ManagedMutationContext {
  readonly authority: ShellAuthority;
  readonly paths: ManagedInstallPaths;
  readonly lockedVersion: string;
  readonly recovery: RecoveryOutcome;
  readonly signal: AbortSignal;
}

/**
 * When non-null, the boundary returns this envelope without probing active or
 * running operation work. Opposite-operation completion still reloads authority
 * when the policy declines early return and work continues.
 */
export type RecoveryEarlyResult = (
  recovery: Extract<RecoveryOutcome, { kind: "completed" }>,
  authority: ShellAuthority
) => UpgradeSuccessEnvelope | null;

/**
 * Runs work under the Install Root lock with the shared recover/reload/probe
 * sequence. Always releases the lock. Reloads ownership after a completed
 * recovery that does not short-circuit via recoveryEarly.
 */
export async function withManagedInstallMutation(
  authority: ShellAuthority,
  signal: AbortSignal,
  recoveryEarly: RecoveryEarlyResult,
  work: (context: ManagedMutationContext) => Promise<UpgradeSuccessEnvelope>
): Promise<UpgradeSuccessEnvelope> {
  const lock: InstallationLock = await acquireInstallationLock(authority.installRoot);
  try {
    let current = revalidateAuthorityAfterLock(authority);
    let recovery: RecoveryOutcome;
    try {
      recovery = await recoverInstallationTransaction(current, lock.paths, signal);
    } catch (error) {
      throwUpgradeProbeFailure(error, signal);
    }

    switch (recovery.kind) {
      case "completed": {
        const early = recoveryEarly(recovery, current);
        if (early !== null) return early;
        // Opposite-operation (or unsatisfied) completion may have rewritten Ownership.
        current = reloadAuthorityAfterRecovery(current);
        break;
      }
      case "clean":
        // No durable incomplete managed mutation.
        break;
      case "shell-installer-finalized":
        // Shell Installer activated txn cleared; Ownership already written.
        // Continue the requested managed operation.
        break;
      default: {
        const _exhaustive: never = recovery;
        throw new Error(`Unhandled recovery outcome: ${String(_exhaustive)}`);
      }
    }

    const lockedVersion = await lockedActiveVersion(current, lock.paths.active, signal);
    return await work({
      authority: current,
      paths: lock.paths,
      lockedVersion,
      recovery,
      signal
    });
  } finally {
    await lock.release();
  }
}

/** Probe active under the lock; prove artifact target matches Ownership. */
export async function lockedActiveVersion(
  authority: ShellAuthority,
  activePath: string,
  signal: AbortSignal
): Promise<string> {
  let identity;
  try {
    identity = await readReleaseExecutableIdentity(activePath, { signal });
  } catch (error) {
    throwUpgradeProbeFailure(error, signal, "Active executable version probe failed.");
  }
  if (identity.artifactTarget !== authority.record.artifactTarget) {
    throw new UpgradeFailure(
      "verification_failed",
      "Active executable target does not match the Ownership Record."
    );
  }
  return identity.productVersion;
}

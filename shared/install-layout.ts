/**
 * Canonical Install Root basenames. Shell Installer and managed upgrade share
 * these names so recovery and layout stay aligned.
 */
export const INSTALL_LOCK_FILE = ".1667-install.lock" as const;
export const INSTALL_TRANSACTION_FILE = ".1667-install-txn.json" as const;
export const INSTALL_CANDIDATE_FILE = ".1667-candidate" as const;
/** Prior active executable retained for managed rollback. */
export const INSTALL_PREVIOUS_FILE = ".1667-previous" as const;
/** Staged next previous executable; existing .previous stays until activation. */
export const INSTALL_PREVIOUS_NEXT_FILE = ".1667-previous.next" as const;
/** npm Release package staging under the Install Root (managed upgrade). */
export const INSTALL_PACKAGE_STAGING_FILE = ".1667-package.tgz" as const;
/** PowerShell Installer work directories, one per attempt. */
export const INSTALL_WORK_PREFIX = ".1667-install." as const;

/**
 * Names an Installer may find in a root it still treats as fresh. An attempt
 * that fails after it takes the lock leaves the lock file behind, and the
 * PowerShell Installer creates its work directory inside the same root. Neither
 * is a foreign file, so neither may block the next attempt.
 */
export const INSTALL_RESERVED_FRESH_NAMES: readonly string[] = Object.freeze([
  INSTALL_LOCK_FILE,
  INSTALL_TRANSACTION_FILE
]);

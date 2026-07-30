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

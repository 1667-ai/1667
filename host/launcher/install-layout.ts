import path from "node:path";
import {
  INSTALL_ACTIVE_EXECUTABLE,
  INSTALL_OWNERSHIP_FILE
} from "../../shared/install-ownership-record.js";
import {
  INSTALL_CANDIDATE_FILE,
  INSTALL_LOCK_FILE,
  INSTALL_PACKAGE_STAGING_FILE,
  INSTALL_PREVIOUS_FILE,
  INSTALL_PREVIOUS_NEXT_FILE,
  INSTALL_TRANSACTION_FILE
} from "../../shared/install-layout.js";

export {
  INSTALL_CANDIDATE_FILE,
  INSTALL_LOCK_FILE,
  INSTALL_PACKAGE_STAGING_FILE,
  INSTALL_PREVIOUS_FILE,
  INSTALL_PREVIOUS_NEXT_FILE,
  INSTALL_TRANSACTION_FILE
} from "../../shared/install-layout.js";

/** Re-export of shared active basename (Ownership Record layout invariant). */
export const INSTALL_ACTIVE_FILE = INSTALL_ACTIVE_EXECUTABLE;

export interface ManagedInstallPaths {
  readonly installRoot: string;
  readonly active: string;
  readonly previous: string;
  readonly previousNext: string;
  readonly candidate: string;
  readonly ownership: string;
  readonly lock: string;
  readonly transaction: string;
  readonly packageStaging: string;
}

export function managedInstallPaths(installRoot: string): ManagedInstallPaths {
  return Object.freeze({
    installRoot,
    active: path.join(installRoot, INSTALL_ACTIVE_FILE),
    previous: path.join(installRoot, INSTALL_PREVIOUS_FILE),
    previousNext: path.join(installRoot, INSTALL_PREVIOUS_NEXT_FILE),
    candidate: path.join(installRoot, INSTALL_CANDIDATE_FILE),
    ownership: path.join(installRoot, INSTALL_OWNERSHIP_FILE),
    lock: path.join(installRoot, INSTALL_LOCK_FILE),
    transaction: path.join(installRoot, INSTALL_TRANSACTION_FILE),
    packageStaging: path.join(installRoot, INSTALL_PACKAGE_STAGING_FILE)
  });
}

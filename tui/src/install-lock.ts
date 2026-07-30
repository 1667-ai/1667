/**
 * Managed-upgrade Install Root lock: persistent regular file + BSD flock(2).
 * Interoperates with the Shell Installer lockf/flock on the same path.
 */
import { closeSync } from "node:fs";
import {
  isLockContention,
  lockFile,
  type OsFileLock
} from "../../server/os-file-lock.js";
import { openExclusiveLockFile } from "../../shared/safe-file-write.js";
import { managedInstallPaths, type ManagedInstallPaths } from "./install-layout.js";

export interface InstallationLock {
  readonly paths: ManagedInstallPaths;
  release(): Promise<void>;
}

export async function acquireInstallationLock(
  installRoot: string
): Promise<InstallationLock> {
  const paths = managedInstallPaths(installRoot);
  let fd: number;
  try {
    fd = openExclusiveLockFile(paths.lock);
  } catch (error) {
    throw new Error("Could not open the Install Root lock", { cause: error });
  }
  let osLock: OsFileLock;
  try {
    osLock = await lockFile(fd, paths.lock);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // Best effort.
    }
    if (isLockContention(error)) {
      throw new Error("Another install holds the Install Root lock", { cause: error });
    }
    throw new Error("Could not acquire the Install Root lock", { cause: error });
  }
  let released = false;
  return {
    paths,
    async release() {
      if (released) return;
      released = true;
      try {
        await osLock.unlock();
      } finally {
        try {
          closeSync(fd);
        } catch {
          // Best effort; kernel releases on process exit.
        }
      }
    }
  };
}

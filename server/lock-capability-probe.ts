import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { ServiceError } from "./errors.js";
import { isLockContention, lockFile, type OsFileLock } from "./os-file-lock.js";

export type LockPrimitive = (
  fd: number,
  file?: string
) => Promise<OsFileLock>;

/**
 * Test the property the filesystem allowlist was reaching for instead
 * of enumerating filesystems.
 *
 * `flock` binds to the open file *description*, so a second `open()` of the
 * same path — even inside one process — produces a description that genuinely
 * conflicts; separate Windows handles behave the same under `LockFileEx`. A
 * second exclusive non-blocking acquire must therefore fail. Where it succeeds,
 * locking on this mount is a no-op and 1667 cannot promise a single writer.
 *
 * Honest limit: this detects locking that does nothing, not locking that fails
 * between two hosts mounting one share.
 */
export async function assertLockingFilesystem(
  lockPath: string,
  projectDirectory: string,
  lock: LockPrimitive = lockFile
): Promise<void> {
  let handle: FileHandle | undefined;
  let acquired: OsFileLock | undefined;
  try {
    handle = await open(lockPath, constants.O_RDWR | noFollowFlag());
    try {
      acquired = await lock(handle.fd, lockPath);
    } catch (error) {
      // Only a refusal proves the mount enforces the lock. ENOLCK, EIO, or a
      // failed FFI load prove nothing, so they propagate rather than passing
      // the probe they never actually ran.
      if (isLockContention(error)) return;
      throw error;
    }
    throw unenforcedLocking(projectDirectory);
  } finally {
    await acquired?.unlock().catch(() => undefined);
    await handle?.close().catch(() => undefined);
  }
}

function unenforcedLocking(projectDirectory: string): ServiceError {
  return new ServiceError(
    409,
    `The filesystem holding ${projectDirectory} does not enforce advisory `
      + "locks, so 1667 cannot guarantee that only one process writes this "
      + "project. Move the project to a filesystem that locks, or open it "
      + "through one 1667 server with 1667 --url.",
    "data_directory_unowned"
  );
}

function noFollowFlag(): number {
  return process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
}

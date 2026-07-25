export interface OsFileLock {
  unlock(): Promise<void>;
}

interface LockImplementation {
  lockFile(fd: number): Promise<void>;
  unlockFile(fd: number): Promise<void>;
}

/** Runtime adapter for a lifetime-bound OS advisory lock. Bun cannot load the
 * Node native addon used by the HTTP process, so it calls the same kernel
 * primitives through Bun FFI. */
export async function lockFile(fd: number): Promise<OsFileLock> {
  const implementation: LockImplementation = process.versions.bun === undefined
    ? await import("./os-file-lock-node.js")
    : await import("./os-file-lock-bun.js");
  await implementation.lockFile(fd);
  return { unlock: () => implementation.unlockFile(fd) };
}

/** Errors that mean another owner holds the lock, rather than that locking
 * failed. Everything else must propagate: a probe or an acquisition that could
 * not run has proved nothing. */
export function isLockContention(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && ["EACCES", "EAGAIN", "EBUSY", "EWOULDBLOCK", "ELOCKED"]
      .includes(String(error.code));
}

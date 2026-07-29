import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import {
  noFollowFlag,
  requireBoundedRegularFile,
  requireSameFileIdentity
} from "./data-directory-file-read.js";
import {
  isLockContention,
  lockFile,
  type OsFileLock
} from "./os-file-lock.js";
import type { PrivateFilePolicy } from "./private-file-publication.js";

export interface PrivateFileClaim {
  release(): Promise<void>;
}

/** Retain one shared claim on an immutable private file. */
export async function retainPrivateFileClaim(
  file: string,
  policy: PrivateFilePolicy
): Promise<PrivateFileClaim> {
  const handle = await openValidatedPrivateFile(file, policy);
  let lock: OsFileLock | undefined;
  try {
    lock = await lockFile(handle.fd, file, "shared");
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  let release: Promise<void> | null = null;
  return {
    release: async () => await (release ??= releaseClaim(handle, lock))
  };
}

/** Return true when at least one shared claim owns the private file. */
export async function hasRetainedPrivateFileClaims(
  file: string,
  policy: PrivateFilePolicy
): Promise<boolean> {
  const handle = await openValidatedPrivateFile(file, policy);
  let lock: OsFileLock | undefined;
  try {
    try {
      lock = await lockFile(handle.fd, file);
    } catch (error) {
      if (isLockContention(error)) return true;
      throw error;
    }
    return false;
  } finally {
    await lock?.unlock().catch(() => undefined);
    await handle.close().catch(() => undefined);
  }
}

async function openValidatedPrivateFile(
  file: string,
  policy: PrivateFilePolicy
): Promise<FileHandle> {
  const options = {
    requirePrivate: policy.allowLegacyReadMode !== true,
    allowLegacyOwnerReadMode: policy.allowLegacyReadMode === true,
    allowedLinkCounts: [1]
  } as const;
  const pathInfo = await lstat(file);
  requireBoundedRegularFile(pathInfo, file, policy.maxBytes, options);
  const handle = await open(
    file,
    constants.O_RDWR | noFollowFlag()
  );
  try {
    const handleInfo = await handle.stat();
    requireBoundedRegularFile(handleInfo, file, policy.maxBytes, options);
    requireSameFileIdentity(pathInfo, handleInfo, file);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function releaseClaim(
  handle: FileHandle,
  lock: OsFileLock
): Promise<void> {
  try {
    await lock.unlock();
  } finally {
    await handle.close();
  }
}

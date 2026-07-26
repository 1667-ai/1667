import {
  constants,
  fstatSync,
  ftruncateSync,
  readSync,
  writeSync
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";
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
import { inspectPrivatePosixDirectory } from "./platform-state-root.js";
import { syncDirectory } from "./story-lifecycle.js";

const NEXT_SUFFIX = ".next";
const PREVIOUS_SUFFIX = ".previous";
const LOCK_TIMEOUT_MS = 250;

export interface PrivateRotatingJsonlStoreOptions {
  readonly directoryName: string;
  readonly fileName: string;
  readonly lockFileName: string;
  readonly maximumBytes: number;
  /** Test hook for directory durability barriers. */
  readonly syncDirectories?: (file: string) => Promise<void>;
}

/** Crash-safe, owner-only, cross-process JSONL storage. */
export class PrivateRotatingJsonlStore {
  private operationQueue: Promise<void> = Promise.resolve();

  private constructor(
    readonly file: string,
    private readonly lockHandle: FileHandle,
    private readonly maximumBytes: number,
    private readonly syncDirectories: (file: string) => Promise<void>
  ) {}

  static async open(
    root: string,
    options: PrivateRotatingJsonlStoreOptions
  ): Promise<PrivateRotatingJsonlStore> {
    const directory = path.join(root, options.directoryName);
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (!isErrorCode(error, "EEXIST")) throw error;
    });
    if (process.platform !== "win32") {
      await inspectPrivatePosixDirectory(directory, options.directoryName);
    }
    const lockHandle = await openPrivateAppendFile(
      path.join(directory, options.lockFileName),
      0
    );
    const file = path.join(directory, options.fileName);
    const syncDirectories = options.syncDirectories ?? syncLogDirectories;
    let initializationLock: OsFileLock | undefined;
    try {
      initializationLock = await acquireStoreLock(lockHandle.fd);
      await reconcileRotation(file, syncDirectories);
      const initialLog = await openPrivateAppendFile(
        file,
        options.maximumBytes
      );
      await initialLog.close();
      await initializationLock.unlock();
      initializationLock = undefined;
      return new PrivateRotatingJsonlStore(
        file,
        lockHandle,
        options.maximumBytes,
        syncDirectories
      );
    } catch (error) {
      await initializationLock?.unlock().catch(() => undefined);
      await lockHandle.close();
      throw error;
    }
  }

  append(bytes: Uint8Array): Promise<void> {
    return this.serialize(async () => await this.appendExclusive(bytes));
  }

  close(): Promise<void> {
    return this.serialize(async () => await this.lockHandle.close());
  }

  private async appendExclusive(bytes: Uint8Array): Promise<void> {
    let lock: OsFileLock | undefined;
    let logHandle: FileHandle | undefined;
    let rollbackBytes: number | undefined;
    try {
      lock = await acquireStoreLock(this.lockHandle.fd);
      await reconcileRotation(this.file, this.syncDirectories);
      logHandle = await openPrivateAppendFile(
        this.file,
        this.maximumBytes
      );
      const currentBytes = repairIncompleteTail(logHandle.fd);
      if (currentBytes + bytes.length > this.maximumBytes) {
        await logHandle.close();
        logHandle = undefined;
        await replaceDurably(
          this.file,
          bytes,
          this.syncDirectories
        );
      } else {
        rollbackBytes = currentBytes;
        writeAll(logHandle.fd, bytes);
        await logHandle.sync();
        await this.syncDirectories(this.file);
      }
    } catch (error) {
      if (rollbackBytes !== undefined && logHandle !== undefined) {
        try {
          ftruncateSync(logHandle.fd, rollbackBytes);
          await logHandle.sync();
        } catch {
          // The failed append remains unpublished.
        }
      }
      throw error;
    } finally {
      await logHandle?.close().catch(() => undefined);
      await lock?.unlock().catch(() => undefined);
    }
  }

  private async serialize<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.operationQueue.then(work, work);
    this.operationQueue = operation.then(() => undefined, () => undefined);
    return await operation;
  }
}

async function openPrivateAppendFile(
  file: string,
  maximumBytes: number
): Promise<FileHandle> {
  const handle = await open(
    file,
    constants.O_RDWR | constants.O_APPEND | constants.O_CREAT
      | constants.O_NONBLOCK | noFollowFlag(),
    0o600
  );
  try {
    if (process.platform !== "win32") await handle.chmod(0o600);
    const [pathInfo, handleInfo] = await Promise.all([
      lstat(file),
      handle.stat()
    ]);
    requireBoundedRegularFile(pathInfo, file, maximumBytes, {
      requirePrivate: true
    });
    requireBoundedRegularFile(handleInfo, file, maximumBytes, {
      requirePrivate: true
    });
    requireSameFileIdentity(pathInfo, handleInfo, file);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function replaceDurably(
  file: string,
  bytes: Uint8Array,
  syncDirectories: (file: string) => Promise<void>
): Promise<void> {
  const temporary = `${file}${NEXT_SUFFIX}`;
  const backup = `${file}${PREVIOUS_SUFFIX}`;
  let handle: FileHandle | undefined;
  let oldMoved = false;
  let committed = false;
  try {
    handle = await open(
      temporary,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL
        | noFollowFlag(),
      0o600
    );
    if (process.platform !== "win32") await handle.chmod(0o600);
    writeAll(handle.fd, bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(file, backup);
    oldMoved = true;
    await rename(temporary, file);
    await syncDirectories(file);
    committed = true;
    try {
      await unlink(backup);
      await syncDirectories(file);
    } catch {
      // Startup or the next append reconciles this one bounded backup.
    }
  } catch (error) {
    if (oldMoved && !committed) {
      try {
        await rename(backup, file);
        await syncDirectories(file);
      } catch {
        // The backup retains the prior bytes if restoration cannot finish.
      }
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch((error: unknown) => {
      if (!isErrorCode(error, "ENOENT")) throw error;
    });
    if (committed) await unlink(backup).catch(() => undefined);
  }
}

async function reconcileRotation(
  file: string,
  syncDirectories: (file: string) => Promise<void>
): Promise<void> {
  const temporary = `${file}${NEXT_SUFFIX}`;
  const backup = `${file}${PREVIOUS_SUFFIX}`;
  const activeExists = await fileExists(file);
  const backupExists = await fileExists(backup);
  let changed = false;
  if (backupExists) {
    if (activeExists) await unlink(backup);
    else await rename(backup, file);
    changed = true;
  }
  if (await fileExists(temporary)) {
    await unlink(temporary);
    changed = true;
  }
  if (changed) await syncDirectories(file);
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function repairIncompleteTail(fd: number): number {
  const size = Number(fstatSync(fd).size);
  if (size === 0) return 0;
  const chunk = Buffer.allocUnsafe(Math.min(4_096, size));
  for (let end = size; end > 0;) {
    const start = Math.max(0, end - chunk.length);
    const length = end - start;
    const read = readSync(fd, chunk, 0, length, start);
    const newline = chunk.subarray(0, read).lastIndexOf(0x0a);
    if (newline !== -1) {
      const completeBytes = start + newline + 1;
      if (completeBytes !== size) ftruncateSync(fd, completeBytes);
      return completeBytes;
    }
    end = start;
  }
  ftruncateSync(fd, 0);
  return 0;
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written === 0) throw new Error("Private JSONL write made no progress");
    offset += written;
  }
}

async function syncLogDirectories(file: string): Promise<void> {
  await syncDirectory(path.dirname(file));
  await syncDirectory(path.dirname(path.dirname(file)));
}

async function acquireStoreLock(fd: number): Promise<OsFileLock> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (let delayMs = 2; ; delayMs = Math.min(delayMs * 2, 32)) {
    try {
      return await lockFile(fd);
    } catch (error) {
      if (!isLockContention(error) || Date.now() >= deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

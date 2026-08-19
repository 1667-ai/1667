import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  inspectPrivateDirectory
} from "./private-file-publication.js";
import {
  isLockContention,
  lockFile,
  type OsFileLock
} from "./os-file-lock.js";

export interface PrivateFileLockOptions {
  readonly directory: string;
  readonly fileName: string;
  readonly directoryLabel: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly contentionMessage: (lockPath: string) => string;
}

/** Runs work while one private advisory lock owns the reserved file name. */
export async function withPrivateFileLock<T>(
  options: PrivateFileLockOptions,
  work: () => Promise<T>
): Promise<T> {
  await inspectPrivateDirectory(
    options.directory,
    options.directoryLabel
  );
  const lockPath = path.join(options.directory, options.fileName);
  let handle: FileHandle | undefined;
  let lock: OsFileLock | undefined;
  try {
    handle = await open(lockPath, privateLockOpenFlags(), 0o600);
    lock = await acquirePrivateFileLock(handle.fd, lockPath, options);
    return await work();
  } finally {
    await lock?.unlock().catch(() => undefined);
    await handle?.close().catch(() => undefined);
  }
}

async function acquirePrivateFileLock(
  fileDescriptor: number,
  lockPath: string,
  options: PrivateFileLockOptions
): Promise<OsFileLock> {
  const deadline = Date.now() + options.timeoutMs;
  for (let delayMs = 5; ; delayMs = Math.min(delayMs * 2, 80)) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error("Private file lock acquisition was cancelled");
    }
    try {
      return await lockFile(fileDescriptor, lockPath);
    } catch (error) {
      if (!isLockContention(error)) throw error;
      if (Date.now() >= deadline) {
        throw new Error(options.contentionMessage(lockPath), { cause: error });
      }
    }
    await waitForRetry(delayMs, options.signal);
  }
}

async function waitForRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return;
  }
  if (signal.aborted) throw signal.reason ?? new Error("Private file lock acquisition was cancelled");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("Private file lock acquisition was cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function privateLockOpenFlags(): number | string {
  if (process.platform === "win32") return "a+";
  const closeOnExec = (constants as typeof constants & {
    O_CLOEXEC?: number;
  }).O_CLOEXEC ?? 0;
  return constants.O_RDWR | constants.O_CREAT
    | (constants.O_NOFOLLOW ?? 0) | closeOnExec;
}

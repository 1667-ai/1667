import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { ServiceError } from "./errors.js";
import {
  assertNoDarwinExtendedAllow
} from "./storage-privacy-darwin.js";

export function hardenedDataLockOpenFlags(): number {
  const closeOnExec = (constants as typeof constants & {
    O_CLOEXEC?: number;
  }).O_CLOEXEC ?? 0;
  return constants.O_RDWR
    | constants.O_CREAT
    | (constants.O_NOFOLLOW ?? 0)
    | closeOnExec;
}

export async function validateHardenedDataLock(
  handle: FileHandle,
  lockPath: string
): Promise<void> {
  const info = await handle.stat();
  if (!info.isFile() || info.isSymbolicLink()) throw invalid(lockPath);
  if (process.platform === "win32") return;
  if (info.nlink !== 1
    || (typeof process.geteuid === "function" && info.uid !== process.geteuid())
    || (info.mode & 0o777) !== 0o600) {
    throw invalid(lockPath);
  }
  await assertNoDarwinExtendedAllow(lockPath, "data lock");
}

function invalid(lockPath: string): ServiceError {
  return new ServiceError(
    409,
    `1667 data lock is not a private regular file: ${lockPath}`,
    "data_directory_unowned"
  );
}

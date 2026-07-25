import type { Stats } from "node:fs";
import { lstat, type FileHandle } from "node:fs/promises";
import { requireSameFileIdentity } from "./data-directory-file-read.js";
import { ServiceError } from "./errors.js";

/**
 * ADR007 keeps the retained directory descriptor that roots every later open,
 * and drops the mode and owner assertions about a directory the user chose.
 * Nothing may swap the project tier out from under an acquired lock and be
 * believed afterwards.
 */
export async function assertRetainedDataDirectory(
  dataDir: string,
  handle: FileHandle
): Promise<Stats> {
  const opened = await handle.stat();
  requireDirectory(opened, dataDir);
  const linked = await lstat(dataDir);
  requireDirectory(linked, dataDir);
  requireSameFileIdentity(opened, linked, dataDir);
  return opened;
}

function requireDirectory(info: Stats, dataDir: string): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ServiceError(
      500,
      `1667 retained data directory is not a directory: ${dataDir}`
    );
  }
}

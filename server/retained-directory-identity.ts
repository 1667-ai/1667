import type { Stats } from "node:fs";
import { lstat, type FileHandle } from "node:fs/promises";
import { requireSameFileIdentity } from "./data-directory-file-read.js";
import { ServiceError } from "./errors.js";

/**
 * A retained directory descriptor roots every later open, and nothing asserts
 * a mode or an owner for a directory the user chose: the one thing that must
 * hold is that nobody swaps the project tier out from under an acquired lock
 * and is believed afterwards.
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

import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
  type OpenMode
} from "node:fs";

const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const EXCL = fsConstants.O_EXCL;
const CREAT = fsConstants.O_CREAT;
const WRONLY = fsConstants.O_WRONLY;
const RDWR = fsConstants.O_RDWR;

export type StagingMode = 0o600 | 0o755;

/**
 * Creates a new regular file exclusively without following symbolic links.
 * The mode is applied with fchmod after open so the result is independent of
 * the process umask.
 */
export function openExclusiveWrite(path: string, mode: StagingMode): number {
  const flags = WRONLY | CREAT | EXCL | NOFOLLOW;
  const fd = openSync(path, flags as OpenMode, mode);
  try {
    fchmodSync(fd, mode);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // Best effort.
    }
    removeQuietly(path);
    throw error;
  }
  return fd;
}

/**
 * Creates a new regular file exclusively without following symbolic links.
 * Writes every byte, fsyncs the file, and optionally renames into place.
 */
export function writeExclusiveFile(options: {
  readonly path: string;
  readonly data: string | Uint8Array;
  readonly mode: StagingMode;
  readonly finalPath?: string;
}): void {
  let fd: number | null = null;
  try {
    fd = openExclusiveWrite(options.path, options.mode);
    writeAll(fd, options.data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    if (options.finalPath !== undefined) {
      renameSync(options.path, options.finalPath);
      fsyncPath(options.finalPath);
    } else {
      fsyncPath(options.path);
    }
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Best effort.
      }
    }
    removeQuietly(options.path);
    throw error;
  }
}

export type SyncWriter = (
  fd: number,
  buffer: NodeJS.ArrayBufferView,
  offset: number,
  length: number
) => number;

export function writeAll(
  fd: number,
  data: string | Uint8Array,
  writer: SyncWriter = writeSync
): void {
  const buffer = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const written = writer(fd, buffer, offset, buffer.byteLength - offset);
    if (written <= 0) {
      throw new Error("writeSync returned a non-positive byte count");
    }
    offset += written;
  }
}

export function closeAndFsync(fd: number, path: string): void {
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncPath(path);
}

export function fsyncPath(path: string): void {
  // Bun on Windows rejects fsync for a read-only handle. These paths are
  // owned writable staging or destination files.
  const fd = openSync(path, process.platform === "win32" ? "r+" : "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

export function openExclusiveLockFile(path: string): number {
  try {
    return openSync(path, (RDWR | CREAT | EXCL | NOFOLLOW) as OpenMode, 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return openSync(path, (RDWR | NOFOLLOW) as OpenMode, 0o600);
    }
    throw error;
  }
}

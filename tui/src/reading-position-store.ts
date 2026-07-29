/**
 * Local changing store for per-story reading positions.
 *
 * Not user settings: this map updates as the reader moves. It lives under the
 * user config tree (never in the project tier), keyed by vault scope:
 *   - embedded project: hash of absolute data directory
 *   - HTTP attach: origin + server instance id
 *
 * Durability is merge-on-write under an exclusive lock file.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  fstatSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  mergeReadingPositionDirty,
  normalizeReadingPositions,
  type ReadingPositions
} from "./reading-position.js";

export interface ReadingPositionStoreOptions {
  readonly file?: string;
  readonly afterTemporaryFileSync?: (temporaryFile: string) => void;
}

const PERSIST_DEBOUNCE_MS = 400;
const LOCK_WAIT_MS = 200;
const LOCK_SPIN_MS = 10;
const MAX_STORE_BYTES = 256 * 1024;
const INVALID_LOCK_GRACE_MS = 2_000;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Dirty keys for the next flush. `null` means delete that story entry. */
const dirty = new Map<string, string | null>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let activeStoreFile: string = readingPositionStorePathForScope("default");
let disposed = false;

export function readingPositionRootDir(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "1667", "reading-positions");
}

export function readingPositionStorePathForScope(scope: string): string {
  const digest = createHash("sha256").update(scope, "utf8").digest("hex").slice(0, 24);
  return join(readingPositionRootDir(), `${digest}.json`);
}

/**
 * User-scoped path for this vault. Project data never receives this file
 * (no Git exposure). Same absolute project path shares a store; a wiped and
 * recreated project at that path may inherit cursors — rare and acceptable.
 */
export function readingPositionStoreFile(
  projectDataDir: string | null,
  http: { origin: string; instanceId: string } | null
): string {
  if (projectDataDir !== null && projectDataDir.length > 0) {
    return readingPositionStorePathForScope(`project:${resolve(projectDataDir)}`);
  }
  if (http !== null && http.origin.length > 0 && http.instanceId.length > 0) {
    return readingPositionStorePathForScope(`http:${http.origin}:${http.instanceId}`);
  }
  return readingPositionStorePathForScope("default");
}

export function configureReadingPositionStore(file: string): void {
  disposed = false;
  if (file !== activeStoreFile) {
    // Never migrate dirty keys across vaults.
    dirty.clear();
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
  }
  activeStoreFile = file;
}

export function disposeReadingPositionStore(): void {
  disposed = true;
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  flushReadingPositionPersist();
  disposed = true;
}

export function loadReadingPositions(
  options: ReadingPositionStoreOptions = {}
): ReadingPositions {
  const text = readBoundedRegularFileSync(
    options.file ?? activeStoreFile,
    MAX_STORE_BYTES
  );
  if (text === null) return {};
  try {
    return normalizeReadingPositions(JSON.parse(text));
  } catch {
    return {};
  }
}

export function saveReadingPositions(
  positions: ReadingPositions,
  options: ReadingPositionStoreOptions = {}
): void {
  writePositionsFile(normalizeReadingPositions(positions), options);
}

export function markReadingPositionDirty(
  storyId: string,
  partId: string | null,
  options: ReadingPositionStoreOptions = {}
): void {
  if (disposed) return;
  dirty.set(storyId, partId);
  if (options.file !== undefined) activeStoreFile = options.file;
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!disposed) flushReadingPositionPersist(options);
  }, PERSIST_DEBOUNCE_MS);
}

export function flushReadingPositionPersist(
  options: ReadingPositionStoreOptions = {}
): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (dirty.size === 0) return;
  const file = options.file ?? activeStoreFile;
  const opts = { ...options, file };
  const snapshot = new Map(dirty);
  const wrote = withStoreLock(file, () => {
    const onDisk = loadReadingPositions(opts);
    const merged = mergeReadingPositionDirty(onDisk, snapshot);
    return writePositionsFile(merged, opts);
  });
  if (wrote) {
    for (const [storyId, partId] of snapshot) {
      if (dirty.get(storyId) === partId) dirty.delete(storyId);
    }
  } else if (!disposed && dirty.size > 0 && persistTimer === null) {
    persistTimer = setTimeout(() => {
      persistTimer = null;
      if (!disposed) flushReadingPositionPersist(options);
    }, PERSIST_DEBOUNCE_MS);
  }
}

function withStoreLock(storeFile: string, work: () => boolean): boolean {
  const lockPath = `${storeFile}.lock`;
  try {
    mkdirSync(dirname(storeFile), { recursive: true });
  } catch {
    return work();
  }
  const deadline = Date.now() + LOCK_WAIT_MS;
  let lockFd: number | null = null;
  while (lockFd === null && Date.now() < deadline) {
    try {
      lockFd = openSync(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
        0o600
      );
      try {
        const record = Buffer.from(`${process.pid}\n${Date.now()}\n`, "utf8");
        writeSync(lockFd, record, 0, record.length, 0);
        fsyncSync(lockFd);
      } catch {
        // best-effort ownership record
      }
    } catch (error) {
      if (!isExistError(error)) return work();
      if (recoverStaleLock(lockPath)) continue;
      spin(LOCK_SPIN_MS);
    }
  }
  if (lockFd === null) return false;
  try {
    return work();
  } finally {
    try {
      closeSync(lockFd);
    } catch {
      // ignore
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

function recoverStaleLock(lockPath: string): boolean {
  try {
    const info = lstatSync(lockPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      unlinkSync(lockPath);
      return true;
    }
    const text = readBoundedRegularFileSync(lockPath, 256) ?? "";
    const pid = Number(text.split("\n")[0]);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        unlinkSync(lockPath);
        return true;
      }
    }
    if (Date.now() - info.mtimeMs >= INVALID_LOCK_GRACE_MS) {
      unlinkSync(lockPath);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isExistError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function spin(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // short busy-wait
  }
}

function writePositionsFile(
  positions: ReadingPositions,
  options: ReadingPositionStoreOptions
): boolean {
  let temporaryFile: string | null = null;
  try {
    const file = options.file ?? activeStoreFile;
    const directory = dirname(file);
    mkdirSync(directory, { recursive: true });
    temporaryFile = `${file}.${process.pid}.`
      + `${randomBytes(8).toString("hex")}.tmp`;
    let temporaryDescriptor: number | null = null;
    try {
      temporaryDescriptor = openSync(
        temporaryFile,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
        0o600
      );
      writeFileSync(
        temporaryDescriptor,
        `${JSON.stringify(positions, null, 2)}\n`,
        "utf8"
      );
      fsyncSync(temporaryDescriptor);
    } finally {
      if (temporaryDescriptor !== null) closeSync(temporaryDescriptor);
    }
    options.afterTemporaryFileSync?.(temporaryFile);
    renameSync(temporaryFile, file);
    temporaryFile = null;
    syncDirectory(directory);
    return true;
  } catch {
    return false;
  } finally {
    if (temporaryFile !== null) {
      try {
        unlinkSync(temporaryFile);
      } catch {
        // ignore
      }
    }
  }
}

function syncDirectory(directory: string): void {
  // Soft UI store: Windows needs a writable handle; skip if it fails.
  let descriptor: number | null = null;
  try {
    if (process.platform === "win32") {
      descriptor = openSync(directory, "a+");
    } else {
      descriptor = openSync(
        directory,
        constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)
      );
    }
    fsyncSync(descriptor);
  } catch {
    // rename already succeeded; directory sync is best-effort.
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // ignore
      }
    }
  }
}

function readBoundedRegularFileSync(file: string, maxBytes: number): string | null {
  try {
    const pathInfo = lstatSync(file);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) return null;
    if (pathInfo.size > maxBytes) return null;
    const fd = openSync(file, constants.O_RDONLY | NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > maxBytes) return null;
      const size = Number(opened.size);
      const buffer = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const read = readSync(fd, buffer, offset, size - offset, offset);
        if (read === 0) break;
        offset += read;
      }
      return buffer.subarray(0, offset).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

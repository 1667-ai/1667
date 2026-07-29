/**
 * Local changing store for per-story reading positions.
 *
 * Not settings: updates as the reader moves. Lives under the user config tree
 * (never the project tier), one file per vault scope:
 *   - embedded: hash of absolute project data directory
 *   - HTTP attach: loopback origin only (survives restart). 1667 loopback
 *     serves one data dir per origin; multi-vault reuse of one port is out of
 *     scope for this soft UI store.
 *
 * Writes are merge-on-write under a short exclusive lock, then atomic rename.
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
const LOCK_WAIT_MS = 250;
const LOCK_SPIN_MS = 10;
/** Empty lock (O_EXCL before pid write) stays held this long. */
const EMPTY_LOCK_GRACE_MS = 1_000;
const MAX_STORE_BYTES = 256 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

const dirty = new Map<string, string | null>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let activeStoreFile: string = readingPositionStorePathForScope("default");
let disposed = false;

export function readingPositionRootDir(): string {
  const configured = process.env.XDG_CONFIG_HOME;
  const base = configured !== undefined
    && configured.length > 0
    && (configured.startsWith("/") || /^[A-Za-z]:[\\/]/.test(configured))
    ? configured
    : join(homedir(), ".config");
  return join(base, "1667", "reading-positions");
}

export function readingPositionStorePathForScope(scope: string): string {
  const digest = createHash("sha256").update(scope, "utf8").digest("hex").slice(0, 24);
  return join(readingPositionRootDir(), `${digest}.json`);
}

export function readingPositionStoreFile(
  projectDataDir: string | null,
  httpOrigin: string | null
): string {
  if (projectDataDir !== null && projectDataDir.length > 0) {
    return readingPositionStorePathForScope(`project:${resolve(projectDataDir)}`);
  }
  if (httpOrigin !== null && httpOrigin.length > 0) {
    return readingPositionStorePathForScope(`http:${httpOrigin}`);
  }
  return readingPositionStorePathForScope("default");
}

export function configureReadingPositionStore(file: string): void {
  disposed = false;
  if (file !== activeStoreFile) {
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
      const record = Buffer.from(`${process.pid}\n`, "utf8");
      writeSync(lockFd, record, 0, record.length, 0);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        return work();
      }
      if (reclaimDeadOwnerLock(lockPath)) continue;
      const end = Date.now() + LOCK_SPIN_MS;
      while (Date.now() < end) {
        // short wait
      }
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

/**
 * Reclaim only when the recorded pid is dead (or empty past grace).
 * Uses rename-to-claim so two reclaimers cannot both steal a live peer's lock.
 */
function reclaimDeadOwnerLock(lockPath: string): boolean {
  try {
    const info = lstatSync(lockPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      return claimLockByRename(lockPath);
    }
    const text = readBoundedRegularFileSync(lockPath, 64) ?? "";
    const pid = Number(text.split("\n")[0]);
    if (!Number.isInteger(pid) || pid <= 0) {
      if (Date.now() - info.mtimeMs < EMPTY_LOCK_GRACE_MS) return false;
      return claimLockByRename(lockPath);
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return claimLockByRename(lockPath);
    }
  } catch {
    return false;
  }
}

/** Atomically take ownership of a stale lock path by renaming it away. */
function claimLockByRename(lockPath: string): boolean {
  const claimed = `${lockPath}.reclaimed.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    renameSync(lockPath, claimed);
  } catch {
    return false;
  }
  try {
    unlinkSync(claimed);
  } catch {
    // ignore
  }
  return true;
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
    // rename already landed; directory sync is best-effort for this soft store.
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

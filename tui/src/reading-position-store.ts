/**
 * Local changing store for per-story reading positions.
 *
 * Not user settings: this map updates as the reader moves. It lives in its
 * own file so settings writes (theme, quota, …) never race it.
 *
 * Each vault (project data dir or HTTP attach origin) has its own file, so
 * deterministic starter story ids do not leak across independent projects.
 *
 * Durability is merge-on-write under an exclusive lock file: each flush
 * re-reads the map, applies only dirty story keys, then rewrites. Concurrent
 * clients updating different stories do not erase each other.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  READING_POSITIONS_FILE,
  READING_POSITIONS_LOCK_FILE
} from "../../server/data-directory-layout.js";
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
/** Bound project-local store reads; the map is a few KB of story→part ids. */
const MAX_STORE_BYTES = 256 * 1024;
const MAX_GITIGNORE_BYTES = 64 * 1024;
/** Empty/malformed lock reclaim grace after a crash mid-ownership write. */
const INVALID_LOCK_GRACE_MS = 2_000;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Dirty keys for the next flush. `null` means delete that story entry. */
const dirty = new Map<string, string | null>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** Active vault store file; set once at process startup via configure. */
let activeStoreFile: string = readingPositionStorePathForScope("default");

export function readingPositionRootDir(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "1667", "reading-positions");
}

/** Stable user-home path for HTTP attach (no project tier). */
export function readingPositionStorePathForScope(scope: string): string {
  const digest = createHash("sha256").update(scope, "utf8").digest("hex").slice(0, 24);
  return join(readingPositionRootDir(), `${digest}.json`);
}

/**
 * Where the store lives for this session.
 * Project vaults: inside the data directory so a deleted/recreated project
 * cannot inherit the previous tutorial cursor (starter ids are deterministic).
 * HTTP attach: under the user config tree, keyed by origin + server instance.
 */
export function readingPositionStoreFile(
  projectDataDir: string | null,
  http: { origin: string; instanceId: string } | null
): string {
  if (projectDataDir !== null && projectDataDir.length > 0) {
    const projectFile = join(projectDataDir, READING_POSITIONS_FILE);
    const fallback = projectFallbackStoreFile(projectDataDir);
    // Prefer an existing fallback written when .gitignore could not be patched.
    if (boundedFileExists(fallback) && !boundedFileExists(projectFile)) {
      return fallback;
    }
    return projectFile;
  }
  if (http !== null && http.origin.length > 0 && http.instanceId.length > 0) {
    return readingPositionStorePathForScope(`http:${http.origin}:${http.instanceId}`);
  }
  return readingPositionStorePathForScope("default");
}

export function projectFallbackStoreFile(projectDataDir: string): string {
  return readingPositionStorePathForScope(`project-fallback:${projectDataDir}`);
}

/** @deprecated Prefer readingPositionStoreFile; kept for tests of path hashing. */
export function readingPositionScope(
  projectDataDir: string | null,
  httpOrigin: string | null
): string {
  if (projectDataDir !== null && projectDataDir.length > 0) {
    return `project:${projectDataDir}`;
  }
  if (httpOrigin !== null && httpOrigin.length > 0) {
    return `http:${httpOrigin}`;
  }
  return "default";
}

/** Bind all subsequent load/mark/flush calls to this vault's file. */
export function configureReadingPositionStore(file: string): void {
  if (persistTimer !== null && dirty.size > 0 && activeStoreFile !== file) {
    flushReadingPositionPersist({ file: activeStoreFile });
  }
  activeStoreFile = file;
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

/** Atomic full rewrite. Prefer markDirty + flush for normal updates. */
export function saveReadingPositions(
  positions: ReadingPositions,
  options: ReadingPositionStoreOptions = {}
): void {
  writePositionsFile(normalizeReadingPositions(positions), options);
}

/** Queue a single-story set/delete for debounced merge-write. */
export function markReadingPositionDirty(
  storyId: string,
  partId: string | null,
  options: ReadingPositionStoreOptions = {}
): void {
  dirty.set(storyId, partId);
  if (options.file !== undefined) activeStoreFile = options.file;
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushReadingPositionPersist(options);
  }, PERSIST_DEBOUNCE_MS);
}

/** Flush dirty keys: lock, re-read disk, apply sets/deletes, write once. */
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
  // Keep dirty until a successful write so ENOSPC / EACCES can retry later.
  const wrote = withStoreLock(file, () => {
    const onDisk = loadReadingPositions(opts);
    const merged = mergeReadingPositionDirty(onDisk, snapshot);
    return writePositionsFile(merged, opts);
  });
  if (wrote) {
    for (const [storyId, partId] of snapshot) {
      if (dirty.get(storyId) === partId) dirty.delete(storyId);
    }
  } else if (dirty.size > 0 && persistTimer === null) {
    // Lock contention or I/O failure: try again shortly while dirty remains.
    persistTimer = setTimeout(() => {
      persistTimer = null;
      flushReadingPositionPersist(options);
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
        // Ownership record is best-effort; invalid locks reclaim after grace.
      }
    } catch (error) {
      if (!isExistError(error)) return work();
      if (recoverStaleLock(lockPath)) continue;
      spin(LOCK_SPIN_MS);
    }
  }
  if (lockFd === null) {
    // Still locked by a live peer: keep dirty for a later flush; do not
    // unlock-and-race. A short wait already elapsed.
    return false;
  }
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
 * Recover a lock only when its owner is known-dead, or the ownership record
 * never finished writing and the lock is older than the grace window.
 */
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
        return false; // owner still alive
      } catch {
        unlinkSync(lockPath);
        return true;
      }
    }
    // Invalid/missing ownership (crash after O_EXCL, before pid write).
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
    // Intentional short busy-wait: flush is rare and must stay synchronous.
  }
}

/** Returns true when the replacement landed. */
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
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
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
    // Project-tier stores must be ignored by Git before they become durable.
    if (isProjectTierStoreFile(file)) {
      if (!ensureProjectGitignoreIgnoresStore(directory)) {
        // Fall back to a user-scoped file so the cursor still persists without
        // leaving an unignored machine-local artifact in the project tree.
        const fallback = projectFallbackStoreFile(directory);
        const moved = writePositionsFile(positions, { ...options, file: fallback });
        if (moved) {
          try {
            unlinkSync(temporaryFile);
          } catch {
            // ignore
          }
          temporaryFile = null;
          if (activeStoreFile === file) activeStoreFile = fallback;
        }
        return moved;
      }
    }
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
        // Incomplete sibling is non-authoritative.
      }
    }
  }
}

function syncDirectory(directory: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      directory,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)
    );
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function isProjectTierStoreFile(file: string): boolean {
  return file.endsWith(`/${READING_POSITIONS_FILE}`) || file.endsWith(`\\${READING_POSITIONS_FILE}`);
}

/**
 * Ensure ignore lines exist. Never follows a symlink `.gitignore`.
 * Returns true when the store is guaranteed ignored (or already was).
 */
function ensureProjectGitignoreIgnoresStore(projectDir: string): boolean {
  const gitignore = join(projectDir, ".gitignore");
  const needed = [
    READING_POSITIONS_FILE,
    READING_POSITIONS_LOCK_FILE,
    `${READING_POSITIONS_FILE}.*.tmp`
  ];
  try {
    let text = "";
    try {
      const info = lstatSync(gitignore);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_GITIGNORE_BYTES) return false;
      const existing = readBoundedRegularFileSync(gitignore, MAX_GITIGNORE_BYTES);
      if (existing === null) return false;
      text = existing;
    } catch (error) {
      if (!isNotFoundError(error)) return false;
      // Missing gitignore: create one with only the store rules.
      text = "";
    }
    const lines = new Set(text.split("\n"));
    let next = text;
    let changed = false;
    for (const line of needed) {
      if (lines.has(line)) continue;
      next = next.endsWith("\n") || next.length === 0 ? `${next}${line}\n` : `${next}\n${line}\n`;
      changed = true;
    }
    if (!changed) return true;
    const tmp = `${gitignore}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const fd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o644
    );
    try {
      const body = Buffer.from(next, "utf8");
      writeSync(fd, body, 0, body.length, 0);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, gitignore);
    return true;
  } catch {
    return false;
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function boundedFileExists(file: string): boolean {
  return readBoundedRegularFileSync(file, MAX_STORE_BYTES) !== null
    || (() => {
      try {
        const info = lstatSync(file);
        return info.isFile() && !info.isSymbolicLink();
      } catch {
        return false;
      }
    })();
}

/** Read a regular file without following symlinks; null on any refusal. */
function readBoundedRegularFileSync(file: string, maxBytes: number): string | null {
  try {
    const pathInfo = lstatSync(file);
    // Refuse symlinks, dirs, devices, and oversized payloads. Soft UI store:
    // do not require nlink===1 (strict authority files do; this map does not).
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

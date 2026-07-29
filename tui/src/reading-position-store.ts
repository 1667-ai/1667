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
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
const LOCK_WAIT_MS = 1_000;
const LOCK_SPIN_MS = 10;

/** Dirty keys for the next flush. `null` means delete that story entry. */
const dirty = new Map<string, string | null>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** Active vault store file; set once at process startup via configure. */
let activeStoreFile: string = readingPositionStorePathForScope("default");

export function readingPositionRootDir(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "1667", "reading-positions");
}

/** Stable store path for one vault/server scope. */
export function readingPositionStorePathForScope(scope: string): string {
  const digest = createHash("sha256").update(scope, "utf8").digest("hex").slice(0, 24);
  return join(readingPositionRootDir(), `${digest}.json`);
}

/** Project data dir or HTTP origin. Empty pieces collapse to "default". */
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
    // Leaving a vault: flush the previous file before switching.
    flushReadingPositionPersist({ file: activeStoreFile });
  }
  activeStoreFile = file;
}

export function loadReadingPositions(
  options: ReadingPositionStoreOptions = {}
): ReadingPositions {
  try {
    return normalizeReadingPositions(JSON.parse(
      readFileSync(options.file ?? activeStoreFile, "utf8")
    ));
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
  dirty.clear();
  withStoreLock(file, () => {
    const onDisk = loadReadingPositions(opts);
    const merged = mergeReadingPositionDirty(onDisk, snapshot);
    writePositionsFile(merged, opts);
  });
}

function withStoreLock(storeFile: string, work: () => void): void {
  const lockPath = `${storeFile}.lock`;
  try {
    mkdirSync(dirname(storeFile), { recursive: true });
  } catch {
    // Read-only home or non-directory path: still attempt unguarded write.
    work();
    return;
  }
  const deadline = Date.now() + LOCK_WAIT_MS;
  let lockFd: number | null = null;
  while (lockFd === null && Date.now() < deadline) {
    try {
      lockFd = openSync(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600
      );
    } catch (error) {
      if (!isExistError(error)) {
        // Locking unavailable — still try the work once without exclusion.
        work();
        return;
      }
      spin(LOCK_SPIN_MS);
    }
  }
  if (lockFd === null) {
    // Timed out waiting; best-effort unguarded write beats dropping the update.
    work();
    return;
  }
  try {
    work();
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

function isExistError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function spin(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Intentional short busy-wait: flush is rare and must stay synchronous.
  }
}

function writePositionsFile(
  positions: ReadingPositions,
  options: ReadingPositionStoreOptions
): void {
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
    renameSync(temporaryFile, file);
    temporaryFile = null;
    syncDirectory(directory);
  } catch {
    // A read-only home must not break the app or truncate the last store.
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

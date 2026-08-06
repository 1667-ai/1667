/**
 * Local changing store for per-story reading positions.
 *
 * Not settings: updates as the reader moves. Lives under the user config tree
 * (never the project tier), one file per vault scope:
 *   - embedded: hash of absolute project data directory
 *   - HTTP attach: loopback origin (survives restart; one vault per origin is
 *     the supported loopback layout)
 *
 * Writes are merge-on-write then atomic rename. Concurrent multi-process TUI
 * on the same vault is best-effort (soft UI store; single interactive client
 * is the supported layout).
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
  writeFileSync
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
const MAX_STORE_BYTES = 256 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

interface PendingReadingPositionWrites {
  readonly dirty: Map<string, string | null>;
  timer: ReturnType<typeof setTimeout> | null;
  options: ReadingPositionStoreOptions;
}

const pendingByFile = new Map<string, PendingReadingPositionWrites>();
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
    discardPendingWrites(activeStoreFile);
  }
  activeStoreFile = file;
}

export function disposeReadingPositionStore(): void {
  disposed = true;
  for (const pending of pendingByFile.values()) {
    cancelPendingTimer(pending);
  }
  for (const [file, pending] of pendingByFile) {
    if (pending.dirty.size > 0) {
      flushReadingPositionPersist({ ...pending.options, file });
    }
  }
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
  const file = options.file ?? activeStoreFile;
  const pending = pendingWrites(file, options);
  pending.options = { ...options, file };
  pending.dirty.set(storyId, partId);
  schedulePendingFlush(file, pending);
}

export function flushReadingPositionPersist(
  options: ReadingPositionStoreOptions = {}
): void {
  const file = options.file ?? activeStoreFile;
  const pending = pendingByFile.get(file);
  if (pending === undefined) return;
  pending.options = { ...options, file };
  cancelPendingTimer(pending);
  if (pending.dirty.size === 0) return;
  const opts = { ...options, file };
  const snapshot = new Map(pending.dirty);
  const onDisk = loadReadingPositions(opts);
  const merged = mergeReadingPositionDirty(onDisk, snapshot);
  if (writePositionsFile(merged, opts)) {
    for (const [storyId, partId] of snapshot) {
      if (pending.dirty.get(storyId) === partId) {
        pending.dirty.delete(storyId);
      }
    }
  }
  if (pending.dirty.size === 0) {
    pendingByFile.delete(file);
  } else if (!disposed && pending.timer === null) {
    schedulePendingFlush(file, pending);
  }
}

function pendingWrites(
  file: string,
  options: ReadingPositionStoreOptions
): PendingReadingPositionWrites {
  const current = pendingByFile.get(file);
  if (current !== undefined) return current;
  const created: PendingReadingPositionWrites = {
    dirty: new Map(),
    timer: null,
    options: { ...options, file }
  };
  pendingByFile.set(file, created);
  return created;
}

function schedulePendingFlush(
  file: string,
  pending: PendingReadingPositionWrites
): void {
  cancelPendingTimer(pending);
  pending.timer = setTimeout(() => {
    pending.timer = null;
    if (!disposed) flushReadingPositionPersist({ ...pending.options, file });
  }, PERSIST_DEBOUNCE_MS);
}

function cancelPendingTimer(pending: PendingReadingPositionWrites): void {
  if (pending.timer === null) return;
  clearTimeout(pending.timer);
  pending.timer = null;
}

function discardPendingWrites(file: string): void {
  const pending = pendingByFile.get(file);
  if (pending === undefined) return;
  cancelPendingTimer(pending);
  pendingByFile.delete(file);
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
    // rename already landed
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

/**
 * Local changing store for per-story reading positions.
 *
 * Not user settings: this map updates as the reader moves. It lives in its
 * own file so settings writes (theme, quota, …) never race it.
 *
 * Durability is merge-on-write: each flush re-reads the file and applies only
 * dirty story keys (set or delete). Concurrent clients updating different
 * stories do not erase each other's entries.
 */
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
  normalizeReadingPositions,
  type ReadingPositions
} from "./reading-position.js";

export interface ReadingPositionStoreOptions {
  readonly file?: string;
  readonly afterTemporaryFileSync?: (temporaryFile: string) => void;
}

const PERSIST_DEBOUNCE_MS = 400;

/** Dirty keys for the next flush. `null` means delete that story entry. */
const dirty = new Map<string, string | null>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistFile: string | undefined;

export function readingPositionStorePath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "1667", "reading-positions.json");
}

export function loadReadingPositions(
  options: ReadingPositionStoreOptions = {}
): ReadingPositions {
  try {
    return normalizeReadingPositions(JSON.parse(
      readFileSync(options.file ?? readingPositionStorePath(), "utf8")
    ));
  } catch {
    return {};
  }
}

/** Atomic full rewrite used after a merge. Prefer markDirty + flush. */
export function saveReadingPositions(
  positions: ReadingPositions,
  options: ReadingPositionStoreOptions = {}
): void {
  writePositionsFile(normalizeReadingPositions(positions), options);
}

/** Queue a single-story set for debounced merge-write. */
export function markReadingPositionDirty(
  storyId: string,
  partId: string | null,
  options: ReadingPositionStoreOptions = {}
): void {
  dirty.set(storyId, partId);
  if (options.file !== undefined) persistFile = options.file;
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushReadingPositionPersist(options);
  }, PERSIST_DEBOUNCE_MS);
}

/** Flush dirty keys: re-read disk, apply sets/deletes, write once. */
export function flushReadingPositionPersist(
  options: ReadingPositionStoreOptions = {}
): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (dirty.size === 0) return;
  const file = options.file ?? persistFile;
  const opts = file === undefined ? options : { ...options, file };
  const onDisk = { ...loadReadingPositions(opts) } as Record<string, string>;
  for (const [storyId, partId] of dirty) {
    if (partId === null) delete onDisk[storyId];
    else onDisk[storyId] = partId;
  }
  dirty.clear();
  writePositionsFile(normalizeReadingPositions(onDisk), opts);
}

function writePositionsFile(
  positions: ReadingPositions,
  options: ReadingPositionStoreOptions
): void {
  let temporaryFile: string | null = null;
  try {
    const file = options.file ?? readingPositionStorePath();
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

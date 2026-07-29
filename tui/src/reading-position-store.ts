/**
 * Local changing store for per-story reading positions.
 *
 * Not user settings: this map updates as the reader moves. It lives in its
 * own file so settings writes (theme, quota, …) never race it, and so the
 * on-disk shape stays a plain story→part map.
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

let pendingPositions: ReadingPositions | null = null;
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

/** Atomic write of the whole map. Callers usually go through queue/flush. */
export function saveReadingPositions(
  positions: ReadingPositions,
  options: ReadingPositionStoreOptions = {}
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
        `${JSON.stringify(normalizeReadingPositions(positions), null, 2)}\n`,
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

/** Queue a durable write of the latest map (debounced). */
export function queueReadingPositionPersist(
  positions: ReadingPositions,
  options: ReadingPositionStoreOptions = {}
): void {
  pendingPositions = positions;
  if (options.file !== undefined) persistFile = options.file;
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushReadingPositionPersist(options);
  }, PERSIST_DEBOUNCE_MS);
}

/** Flush a pending durable write (story switch, delete, shutdown). */
export function flushReadingPositionPersist(
  options: ReadingPositionStoreOptions = {}
): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (pendingPositions === null) return;
  const file = options.file ?? persistFile;
  saveReadingPositions(pendingPositions, file === undefined ? options : { ...options, file });
  pendingPositions = null;
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

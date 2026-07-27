import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  type DataDirectoryFormat,
  DATA_DIRECTORY_LOCK
} from "./data-directory-layout.js";
import {
  discardOwnerMarkerNextResidue,
  hasDataDirectoryFormatMarker,
  readDataDirectoryFormatSource,
  writeInitialDataDirectoryFormat,
  type DataDirectoryFormatSource
} from "./data-directory-format.js";
import {
  assertRetainedDataDirectory
} from "./retained-directory-identity.js";
import { ServiceError } from "./errors.js";
import { lockedDataDirectoryError } from "./data-directory-errors.js";
import { assertLockingFilesystem } from "./lock-capability-probe.js";
import { isLockContention, lockFile, type OsFileLock } from "./os-file-lock.js";
import { readProjectRunRecord } from "./project-run-record.js";
import {
  migrateSettingsFormatV1ToV2UnderLock,
  type SettingsFormatMigrationV1Options
} from "./settings-format-migration.js";

export { readDataDirectoryFormat } from "./data-directory-format.js";

const DIRECTORY_FLAG = typeof constants.O_DIRECTORY === "number"
  ? constants.O_DIRECTORY
  : 0;

export interface DataDirectoryLockOptions {
  /** Offline legacy migration starts at format 1 before upgrading; ordinary projects use format 2. */
  readonly initializeDataFormat?: DataDirectoryFormat;
}

/**
 * Single-writer lease on one project tier.
 *
 * ADR007: the kernel lock is the only authority on whether a project is open.
 * There is no stale-lock recovery, no pid liveness check, and no residue to
 * clean up — when a process dies the kernel closes the descriptor and releases
 * the lock, and `lock` remains an empty regular file carrying no state.
 */
export class DataDirectoryLock {
  private lockHandle: FileHandle | null = null;
  private dataDirectoryHandle: FileHandle | null = null;
  private lock: OsFileLock | null = null;
  private canonicalDir: string | null = null;
  private selectedDataFormat: DataDirectoryFormat | null = null;
  private selectedDataFormatSource: DataDirectoryFormatSource | null = null;
  private publishedFormat = false;

  constructor(
    private readonly dataDir: string,
    private readonly options: DataDirectoryLockOptions = {}
  ) {}

  get dataFormat(): DataDirectoryFormat {
    if (this.selectedDataFormat === null) {
      throw new Error("Data-directory format is unavailable before lock acquisition");
    }
    return this.selectedDataFormat;
  }

  get dataFormatSource(): DataDirectoryFormatSource {
    if (this.selectedDataFormatSource === null) {
      throw new Error("Data-directory format source is unavailable before lock acquisition");
    }
    return this.selectedDataFormatSource;
  }

  /** True when this acquisition published the format marker, meaning the
   * directory held no 1667 data yet.
   *
   * The directory itself is a poor signal under ADR007: `1667 init` creates the
   * project tier in an earlier process, and a project may arrive by clone. The
   * marker is what distinguishes a first open from an emptied library, which
   * must not be refilled behind the writer's back. */
  get initializedNewDirectory(): boolean {
    return this.publishedFormat;
  }

  get authorityPath(): string {
    if (this.dataDirectoryHandle === null || this.canonicalDir === null) {
      throw new Error("Data-directory authority is unavailable before acquisition");
    }
    if (process.platform === "linux") {
      return `/proc/self/fd/${this.dataDirectoryHandle.fd}`;
    }
    // Darwin fdesc nodes are files, not traversable directory authorities.
    return this.canonicalDir;
  }

  /**
   * Low-level maintenance/test acquisition. Runtime code must instead use
   * RuntimeDataDirectoryLock so format migration cannot be skipped.
   *
   * @internal
   */
  async acquire(): Promise<string> {
    if (this.lock !== null && this.canonicalDir !== null) return this.canonicalDir;
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const canonicalDir = await realpath(this.dataDir);
    await ensurePrivateDataRoot(canonicalDir);
    const lockPath = path.join(canonicalDir, DATA_DIRECTORY_LOCK);

    let dataDirectoryHandle: FileHandle | undefined;
    let lockHandle: FileHandle | undefined;
    let lock: OsFileLock | undefined;
    try {
      dataDirectoryHandle = await open(canonicalDir, dataDirectoryOpenFlags());
      lockHandle = await open(lockPath, lockOpenFlags(), 0o600);
      lock = await lockFile(lockHandle.fd, lockPath);
      await assertLockingFilesystem(lockPath, canonicalDir);
      this.publishedFormat = await publishInitialFormat(
        canonicalDir,
        this.options.initializeDataFormat ?? 2
      );
      const adoption = await adoptMarker(canonicalDir, dataDirectoryHandle);
      this.lock = lock;
      this.lockHandle = lockHandle;
      this.dataDirectoryHandle = dataDirectoryHandle;
      this.canonicalDir = canonicalDir;
      this.selectedDataFormat = adoption.dataFormat;
      this.selectedDataFormatSource = adoption.source;
      return canonicalDir;
    } catch (error) {
      try {
        await lock?.unlock();
      } finally {
        try {
          await lockHandle?.close();
        } finally {
          await dataDirectoryHandle?.close();
        }
      }
      if (!isLockContention(error)) throw error;
      throw lockedDataDirectoryError(await readProjectRunRecord(canonicalDir));
    }
  }

  /**
   * Upgrade only the canonical owner-marker format while this instance retains
   * the process lock. Legacy-preview directories deliberately remain on v1.
   *
   * @internal
   */
  async migrateSettingsFormat(
    options: SettingsFormatMigrationV1Options = {}
  ): Promise<DataDirectoryFormat> {
    if (this.selectedDataFormat === null
      || this.selectedDataFormatSource === null
      || this.canonicalDir === null
      || this.dataDirectoryHandle === null) {
      throw new Error("Settings format migration requires an acquired data-directory lock");
    }
    if (this.selectedDataFormat === 2
      || this.selectedDataFormatSource === "legacy-preview") {
      return this.selectedDataFormat;
    }

    const canonicalDir = this.canonicalDir;
    const dataDirectoryHandle = this.dataDirectoryHandle;
    await migrateSettingsFormatV1ToV2UnderLock(
      canonicalDir,
      options,
      async () => void await assertRetainedDataDirectory(
        canonicalDir,
        dataDirectoryHandle
      )
    );
    const adoption = await adoptMarker(canonicalDir, dataDirectoryHandle);
    if (adoption.dataFormat !== 2 || adoption.source !== "owner-marker") {
      throw new Error("Settings format migration did not activate the canonical format-2 marker");
    }
    this.selectedDataFormat = adoption.dataFormat;
    this.selectedDataFormatSource = adoption.source;
    return adoption.dataFormat;
  }

  async release(): Promise<void> {
    const lockHandle = this.lockHandle;
    const dataDirectoryHandle = this.dataDirectoryHandle;
    const lock = this.lock;
    this.lockHandle = null;
    this.dataDirectoryHandle = null;
    this.lock = null;
    this.canonicalDir = null;
    this.selectedDataFormat = null;
    this.selectedDataFormatSource = null;
    if (lockHandle === null || lock === null) return;
    try {
      await lock.unlock();
    } finally {
      try {
        await lockHandle.close();
      } finally {
        await dataDirectoryHandle?.close();
      }
    }
  }
}

/**
 * Read the format this project declares while its lock is held, and clear the
 * one residue an interrupted marker publication can leave. The lock is held by
 * the time this runs, so a single read is authoritative.
 */
async function adoptMarker(
  canonicalDir: string,
  dataDirectoryHandle: FileHandle
): Promise<{
  readonly dataFormat: DataDirectoryFormat;
  readonly source: DataDirectoryFormatSource;
}> {
  await assertRetainedDataDirectory(canonicalDir, dataDirectoryHandle);
  const adopted = await readDataDirectoryFormatSource(canonicalDir);
  if (adopted.source === "owner-marker") {
    await discardOwnerMarkerNextResidue(canonicalDir);
    await assertRetainedDataDirectory(canonicalDir, dataDirectoryHandle);
  }
  return adopted;
}

export async function hasLockAwareDataMarker(dataDir: string): Promise<boolean> {
  return await hasDataDirectoryFormatMarker(dataDir);
}

/** Returns whether this call published the marker, meaning the directory held
 * no 1667 data before it. */
async function publishInitialFormat(
  dataDir: string,
  initializeDataFormat: DataDirectoryFormat
): Promise<boolean> {
  if (await hasDataDirectoryFormatMarker(dataDir)) return false;
  await writeInitialDataDirectoryFormat(dataDir, initializeDataFormat);
  return true;
}

/**
 * 1667 creates the project tier itself, so it may keep its own directory
 * private. This is a repair, not an assertion: a mode the user or a checkout
 * changed is restored rather than refused.
 */
async function ensurePrivateDataRoot(dataDir: string): Promise<void> {
  if (process.platform === "win32") return;
  const before = await lstat(dataDir);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new ServiceError(500, `1667 data root is not a directory: ${dataDir}`);
  }
  if ((before.mode & 0o777) !== 0o700) await chmod(dataDir, 0o700);
  const after = await lstat(dataDir);
  if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino
    || (after.mode & 0o777) !== 0o700) {
    throw new ServiceError(500, `1667 data root could not be made private: ${dataDir}`);
  }
}

function dataDirectoryOpenFlags(): number | string {
  if (process.platform === "win32") return "r";
  return constants.O_RDONLY | DIRECTORY_FLAG | noFollowFlag();
}

function lockOpenFlags(): number | string {
  if (process.platform === "win32") return "a+";
  const closeOnExec = (constants as typeof constants & {
    O_CLOEXEC?: number;
  }).O_CLOEXEC ?? 0;
  return constants.O_RDWR | constants.O_CREAT | noFollowFlag() | closeOnExec;
}

function noFollowFlag(): number {
  return process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
}

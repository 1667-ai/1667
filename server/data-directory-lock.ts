import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";
import {
  adoptLockedDataDirectoryMarker,
  assertRetainedDataDirectory,
  type DataDirectoryFormatSource
} from "./data-directory-marker-adoption.js";
import {
  type DataDirectoryFormat,
  DATA_DIRECTORY_LEGACY_EXCLUSION_FENCE,
  DATA_DIRECTORY_HARDENED_PROCESS_LOCK,
  DATA_DIRECTORY_PROCESS_OWNER_LOCK,
  initialDataDirectoryResidueEntries
} from "./data-directory-layout.js";
import {
  hasDataDirectoryFormatMarker,
  validateInitialDataDirectoryFormatResidue,
  writeInitialDataDirectoryFormat
} from "./data-directory-format.js";
import { ServiceError } from "./errors.js";
import { lockedDataDirectoryError } from "./data-directory-errors.js";
import { lockFile, type OsFileLock } from "./os-file-lock.js";
import {
  migrateSettingsFormatV1ToV2UnderLock,
  type SettingsFormatMigrationV1Options
} from "./settings-format-migration.js";
import {
  assertNoSymbolicDirectoryComponents,
  requireExistingDataDirectory
} from "./data-directory-path-preflight.js";
import {
  requirePrivateDataDirectory
} from "./data-directory-admission.js";
import {
  hardenedDataLockOpenFlags,
  validateHardenedDataLock
} from "./data-directory-process-lock.js";
import { assertSupportedDataFilesystem } from "./storage-filesystem.js";
import { writeDurableFile } from "./story-lifecycle.js";

export { readDataDirectoryFormat } from "./data-directory-format.js";

const LEGACY_EXCLUSION_FENCE = DATA_DIRECTORY_LEGACY_EXCLUSION_FENCE;
const LEGACY_EXCLUSION_CONTENT = "1667-lock-aware-legacy-exclusion-v1\n";
const DIRECTORY_FLAG = typeof constants.O_DIRECTORY === "number"
  ? constants.O_DIRECTORY
  : 0;

export interface DataDirectoryLockOptions {
  /** Offline legacy migration remains format 1; ordinary new targets use format 2. */
  readonly initializeDataFormat?: DataDirectoryFormat;
  /** Hardened packaged admission publishes absent targets before this lease. */
  readonly initializeIfMissing?: boolean;
  /** Hardened directories use the ADR-001 protocol filename. */
  readonly hardenedLock?: boolean;
}

/** Cross-process lease guarding StoryStore's process-local write locks. */
export class DataDirectoryLock {
  private handles: FileHandle[] = [];
  private dataDirectoryHandle: FileHandle | null = null;
  private locks: OsFileLock[] = [];
  private canonicalDir: string | null = null;
  private selectedDataFormat: DataDirectoryFormat | null = null;
  private selectedDataFormatSource: DataDirectoryFormatSource | null = null;

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
    if (this.locks.length > 0 && this.canonicalDir !== null) return this.canonicalDir;
    if (this.options.hardenedLock === true) {
      await assertNoSymbolicDirectoryComponents(this.dataDir);
    }
    if (this.options.initializeIfMissing === false) {
      await requireExistingDataDirectory(this.dataDir, legacyDataError);
    } else {
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    }
    const canonicalDir = await realpath(this.dataDir);
    const initializeDataFormat = this.options.initializeDataFormat ?? 2;
    const preflight = await inspectDataDirectoryBeforeMutation(
      canonicalDir,
      initializeDataFormat
    );
    if (this.options.initializeIfMissing === false && preflight !== "marked") {
      throw legacyDataError(canonicalDir);
    }
    const recoveredFence = preflight === "initialization-residue"
      ? await acquireInitializationFence(path.join(canonicalDir, LEGACY_EXCLUSION_FENCE))
      : null;
    try {
      if (recoveredFence !== null) {
        await inspectInitializationResidueUnderFence(
          canonicalDir,
          initializeDataFormat
        );
      }
      if (this.options.hardenedLock === true) {
        await requirePrivateDataDirectory(canonicalDir);
      } else {
        await ensurePrivateDataRoot(canonicalDir);
      }
      await assertSupportedDataFilesystem(canonicalDir);
      await ensureLockAwareDirectory(
        canonicalDir,
        initializeDataFormat,
        recoveredFence
      );
    } finally {
      await recoveredFence?.release();
    }
    let dataDirectoryHandle: FileHandle | undefined;
    const handles: FileHandle[] = [];
    const locks: OsFileLock[] = [];
    try {
      dataDirectoryHandle = await open(canonicalDir, dataDirectoryOpenFlags());
      // Every current mode first takes the compatibility owner lock. Hardened
      // mode then takes its stricter protocol lock in the same fixed order.
      const lockEntries = [
        {
          path: path.join(canonicalDir, DATA_DIRECTORY_PROCESS_OWNER_LOCK),
          flags: this.options.hardenedLock === true
            ? hardenedDataLockOpenFlags()
            : "a+" as number | string,
          hardened: this.options.hardenedLock === true
        },
        ...(this.options.hardenedLock === true
          ? [{
              path: path.join(canonicalDir, DATA_DIRECTORY_HARDENED_PROCESS_LOCK),
              flags: hardenedDataLockOpenFlags(),
              hardened: true
            }]
          : [])
      ];
      for (const entry of lockEntries) {
        const handle = await open(entry.path, entry.flags, 0o600);
        handles.push(handle);
        if (entry.hardened) {
          await validateHardenedDataLock(handle, entry.path);
        }
        locks.push(await lockFile(handle.fd));
      }
      const adoption = await adoptLockedDataDirectoryMarker(
        canonicalDir,
        dataDirectoryHandle
      );
      this.locks = locks;
      this.handles = handles;
      this.dataDirectoryHandle = dataDirectoryHandle;
      this.canonicalDir = canonicalDir;
      this.selectedDataFormat = adoption.dataFormat;
      this.selectedDataFormatSource = adoption.source;
      return canonicalDir;
    } catch (error) {
      try {
        await releaseLocks(locks);
      } finally {
        try {
          await closeHandles(handles);
        } finally {
          await dataDirectoryHandle?.close();
        }
      }
      if (!isLockContention(error)) throw error;
      throw lockedDataDirectoryError();
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
      () => assertRetainedDataDirectory(canonicalDir, dataDirectoryHandle)
    );
    const adoption = await adoptLockedDataDirectoryMarker(
      canonicalDir,
      dataDirectoryHandle
    );
    if (adoption.dataFormat !== 2 || adoption.source !== "owner-marker") {
      throw new Error("Settings format migration did not activate the canonical format-2 marker");
    }
    this.selectedDataFormat = adoption.dataFormat;
    this.selectedDataFormatSource = adoption.source;
    return adoption.dataFormat;
  }

  async release(): Promise<void> {
    const handles = this.handles;
    const dataDirectoryHandle = this.dataDirectoryHandle;
    const locks = this.locks;
    this.handles = [];
    this.dataDirectoryHandle = null;
    this.locks = [];
    this.canonicalDir = null;
    this.selectedDataFormat = null;
    this.selectedDataFormatSource = null;
    if (handles.length === 0 || locks.length === 0) return;
    try {
      await releaseLocks(locks);
    } finally {
      try {
        await closeHandles(handles);
      } finally {
        await dataDirectoryHandle?.close();
      }
    }
  }
}

async function releaseLocks(locks: readonly OsFileLock[]): Promise<void> {
  let failure: unknown;
  for (const lock of [...locks].reverse()) {
    try {
      await lock.unlock();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

async function closeHandles(handles: readonly FileHandle[]): Promise<void> {
  let failure: unknown;
  for (const handle of [...handles].reverse()) {
    try {
      await handle.close();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

function dataDirectoryOpenFlags(): number | string {
  if (process.platform === "win32") return "r";
  return constants.O_RDONLY | DIRECTORY_FLAG | noFollowFlag();
}

async function ensurePrivateDataRoot(dataDir: string): Promise<void> {
  if (process.platform === "win32") return;
  const before = await lstat(dataDir);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new ServiceError(500, `1667 data root is not a directory: ${dataDir}`);
  }
  if (typeof process.geteuid === "function" && before.uid !== process.geteuid()) {
    throw new ServiceError(500, `1667 data root is owned by another user: ${dataDir}`);
  }
  if ((before.mode & 0o777) !== 0o700) await chmod(dataDir, 0o700);
  const after = await lstat(dataDir);
  if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino
    || (after.mode & 0o777) !== 0o700) {
    throw new ServiceError(500, `1667 data root could not be made private: ${dataDir}`);
  }
}

type DataDirectoryPreflight = "marked" | "empty" | "initialization-residue";

/**
 * A legacy directory must be rejected before chmod or fence publication. The
 * only unmarked non-empty directory admitted here has the exact reserved names
 * used by the current initializer after its permanent fence was visible. Exact
 * residue reads wait until this process owns that fence.
 */
async function inspectDataDirectoryBeforeMutation(
  dataDir: string,
  initializeDataFormat: DataDirectoryFormat
): Promise<DataDirectoryPreflight> {
  if (await hasLockAwareDataMarker(dataDir)) return "marked";

  const entries = await readdir(dataDir);
  // Marker publication may have completed after the first probe. Accept that
  // committed authority before interpreting its final name as legacy content.
  if (await hasLockAwareDataMarker(dataDir)) return "marked";
  if (entries.length === 0) return "empty";

  const fencePath = path.join(dataDir, LEGACY_EXCLUSION_FENCE);
  if (!entries.includes(LEGACY_EXCLUSION_FENCE)) throw legacyDataError(dataDir);
  const fenceInfo = await lstat(fencePath);
  if (fenceInfo.isDirectory()) throw legacyLockError(fencePath);

  const allowed = initialDataDirectoryResidueEntries(initializeDataFormat);
  allowed.add(LEGACY_EXCLUSION_FENCE);
  if (entries.some((entry) => !allowed.has(entry))) throw legacyDataError(dataDir);
  return "initialization-residue";
}

/**
 * Exact initializer residue is meaningful only while this process owns the
 * initialization fence. A prior initializer may have committed the owner
 * marker between names-only preflight and fence acquisition.
 */
async function inspectInitializationResidueUnderFence(
  dataDir: string,
  initializeDataFormat: DataDirectoryFormat
): Promise<void> {
  if (await hasLockAwareDataMarker(dataDir)) return;
  const entries = await readdir(dataDir);
  const allowed = initialDataDirectoryResidueEntries(initializeDataFormat);
  allowed.add(LEGACY_EXCLUSION_FENCE);
  if (entries.some((entry) => !allowed.has(entry))) throw legacyDataError(dataDir);
  await validateInitialDataDirectoryFormatResidue(dataDir, initializeDataFormat);
}

/** Empty directories become lock-aware by atomically claiming the legacy lock
 * pathname first. The permanent regular-file fence makes every older binary's
 * lock-directory mkdir fail, including after this process releases ownership. */
async function ensureLockAwareDirectory(
  dataDir: string,
  initializeDataFormat: DataDirectoryFormat,
  recoveredFence: InitializationFenceLease | null
): Promise<void> {
  const fencePath = path.join(dataDir, LEGACY_EXCLUSION_FENCE);
  if (await hasLockAwareDataMarker(dataDir)) {
    await validateLegacyExclusionFence(fencePath);
    return;
  }
  const fence = recoveredFence ?? await claimLegacyExclusionFence(fencePath);
  try {
    // A contender may have completed initialization between the read-only
    // preflight and this OS lock acquisition.
    if (await hasLockAwareDataMarker(dataDir)) {
      await validateLegacyExclusionFence(fencePath);
      return;
    }
    if (recoveredFence === null) {
      await inspectInitializationResidueUnderFence(dataDir, initializeDataFormat);
    }
    await writeInitialDataDirectoryFormat(dataDir, initializeDataFormat);
  } finally {
    if (recoveredFence === null) await fence.release();
  }
}

async function claimLegacyExclusionFence(
  fencePath: string
): Promise<InitializationFenceLease> {
  try {
    await writeDurableFile(fencePath, LEGACY_EXCLUSION_CONTENT);
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw error;
  }
  return await acquireInitializationFence(fencePath);
}

export async function hasLockAwareDataMarker(dataDir: string): Promise<boolean> {
  return await hasDataDirectoryFormatMarker(dataDir);
}

async function validateLegacyExclusionFence(fencePath: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(fencePath, constants.O_RDONLY | noFollowFlag());
    await validateInitializationFenceHandle(handle, fencePath);
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw invalidFenceError(fencePath);
  } finally {
    await handle?.close();
  }
}

interface InitializationFenceLease {
  release(): Promise<void>;
}

async function acquireInitializationFence(
  fencePath: string
): Promise<InitializationFenceLease> {
  let handle: FileHandle | undefined;
  let lock: OsFileLock | undefined;
  try {
    handle = await open(fencePath, constants.O_RDWR | noFollowFlag());
    try {
      lock = await lockFile(handle.fd);
    } catch (error) {
      if (isLockContention(error)) throw lockedDataDirectoryError();
      throw error;
    }
    await validateInitializationFenceHandle(handle, fencePath);
    const ownedHandle = handle;
    const ownedLock = lock;
    handle = undefined;
    lock = undefined;
    return {
      async release(): Promise<void> {
        try {
          await ownedLock.unlock();
        } finally {
          await ownedHandle.close();
        }
      }
    };
  } finally {
    if (lock !== undefined) await lock.unlock().catch(() => undefined);
    await handle?.close();
  }
}

async function validateInitializationFenceHandle(
  handle: FileHandle,
  fencePath: string
): Promise<void> {
  const before = await handle.stat();
  requireSafeFenceFile(before, fencePath);
  const expected = Buffer.from(LEGACY_EXCLUSION_CONTENT, "utf8");
  if (before.size !== expected.byteLength) throw invalidFenceError(fencePath);
  const bytes = Buffer.alloc(expected.byteLength + 1);
  let total = 0;
  while (total < bytes.byteLength) {
    const result = await handle.read(bytes, total, bytes.byteLength - total, total);
    if (result.bytesRead === 0) break;
    total += result.bytesRead;
  }
  const after = await handle.stat();
  requireSafeFenceFile(after, fencePath);
  const pathInfo = await lstat(fencePath);
  requireSafeFenceFile(pathInfo, fencePath);
  if (
    total !== expected.byteLength
    || !bytes.subarray(0, total).equals(expected)
    || !sameFileIdentity(before, after)
    || !sameFileIdentity(after, pathInfo)
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs
  ) {
    throw invalidFenceError(fencePath);
  }
}

function requireSafeFenceFile(info: Stats, fencePath: string): void {
  if (!info.isFile() || info.isSymbolicLink()) throw invalidFenceError(fencePath);
  if (process.platform !== "win32") {
    if (info.nlink !== 1) throw invalidFenceError(fencePath);
    if (typeof process.geteuid === "function" && info.uid !== process.geteuid()) {
      throw invalidFenceError(fencePath);
    }
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function noFollowFlag(): number {
  return process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
}

function isLockContention(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && ["EACCES", "EAGAIN", "EBUSY", "EWOULDBLOCK", "ELOCKED"].includes(String(error.code));
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function legacyLockError(lockPath: string): ServiceError {
  return new ServiceError(
    409,
    `A legacy 1667 lock entry remains at ${lockPath}. Stop every 1667 process, `
      + "move that entry to Trash, then start again; it is never removed automatically."
  );
}

function legacyDataError(dataDir: string): ServiceError {
  return new ServiceError(
    409,
    `1667 data at ${dataDir} predates safe single-writer ownership. Stop every older 1667 process, `
      + "then migrate it offline into a new lock-aware data directory; the legacy directory was left untouched."
  );
}

function invalidFenceError(fencePath: string): ServiceError {
  return new ServiceError(500, `1667 legacy-exclusion fence is invalid: ${fencePath}`);
}

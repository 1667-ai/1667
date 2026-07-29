import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";
import {
  DATA_DIRECTORY_LOCK,
  DATA_DIRECTORY_MIGRATION_EXCLUDED_ENTRY_NAMES,
  LEGACY_PROCESS_OWNER_LOCK
} from "./data-directory-layout.js";
import {
  noFollowFlag,
  requireSameFileIdentity
} from "./data-directory-file-read.js";
import { PublicRuntimeError } from "./errors.js";
import type { HttpDataDirectoryIdentity } from "./data-directory-id.js";
import {
  readMachineLocalHttpDataDirectoryIdentity
} from "./http-data-directory-claim.js";
import {
  isLockContention,
  lockFile,
  type OsFileLock
} from "./os-file-lock.js";
import {
  assertLockingFilesystem
} from "./lock-capability-probe.js";
import {
  retainedDirectoryAuthorityPath,
  retainedDirectoryOpenFlags
} from "./retained-directory-authority.js";
import {
  assertRetainedDataDirectory
} from "./retained-directory-identity.js";
import {
  assertMachineTierOutsideDirectory
} from "./machine-tier-boundary.js";

declare const VALIDATED_LEGACY_V1: unique symbol;
export interface LegacyDataDirectoryLease {
  readonly dataDir: string;
  readonly dataFormat: 1;
  readonly [VALIDATED_LEGACY_V1]: true;
  readonly authorityPath: string;
  readonly identity: HttpDataDirectoryIdentity;
  release(): Promise<void>;
}

const LEGACY_LEASE_FILES = Object.freeze([
  LEGACY_PROCESS_OWNER_LOCK,
  DATA_DIRECTORY_LOCK
] as const);
const LEGACY_MACHINE_TIER_BOUNDARY =
  "Legacy serve requires the machine tier outside the legacy data directory";

export function assertLegacyDataDirectoryPlatform(
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== "linux") {
    throw new PublicRuntimeError(
      "Legacy serve requires Linux retained-directory authority"
    );
  }
}

async function validateRetainedLegacyDataDirectory(
  authorityPath: string,
  dataDir: string
): Promise<void> {
  const canonical = await realpath(authorityPath);
  if (canonical !== dataDir) {
    throw new PublicRuntimeError(
      "Legacy serve data directory must be canonical and must not use symlinks"
    );
  }
  const entries = await readdir(authorityPath);
  const reserved = new Set<string>(DATA_DIRECTORY_MIGRATION_EXCLUDED_ENTRY_NAMES);
  const leaseFiles = new Set<string>(LEGACY_LEASE_FILES);
  const dataEntries = entries.filter((entry) => !leaseFiles.has(entry));
  if (dataEntries.length === 0) {
    throw new PublicRuntimeError("Legacy serve refuses an empty data directory");
  }
  const collision = entries.find(
    (entry) => reserved.has(entry) && !leaseFiles.has(entry)
  );
  if (collision !== undefined) {
    throw new PublicRuntimeError(
      `Legacy serve refuses reserved ownership path ${collision}`
    );
  }
  const storiesPath = path.join(authorityPath, "stories");
  const stories = await lstat(storiesPath).catch((error: unknown) => {
    if (isErrorCode(error, "ENOENT")) {
      throw new PublicRuntimeError(
        "Legacy serve requires a recognized v1 data directory with a stories directory"
      );
    }
    throw error;
  });
  if (!stories.isDirectory() || stories.isSymbolicLink()) {
    throw new PublicRuntimeError(
      "Legacy serve requires stories to be a real directory"
    );
  }
}

/** Retain, lock, and validate one legacy directory as one authority. */
export async function acquireLegacyDataDirectoryLease(
  dataDirInput: string,
  machineDirectory: string
): Promise<LegacyDataDirectoryLease> {
  assertLegacyDataDirectoryPlatform();
  const authorityInput = path.resolve(dataDirInput);
  const dataDir = await realpath(authorityInput).catch((error: unknown) => {
    if (isErrorCode(error, "ENOENT")) return authorityInput;
    throw error;
  });
  const canonicalMachineDirectory = await realpath(machineDirectory);
  await assertMachineTierOutsideDirectory(
    authorityInput,
    canonicalMachineDirectory,
    LEGACY_MACHINE_TIER_BOUNDARY
  );
  const leases: RetainedFileLock[] = [];
  let directoryHandle: FileHandle | undefined;
  try {
    try {
      directoryHandle = await open(
        authorityInput,
        retainedDirectoryOpenFlags()
      );
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        throw new PublicRuntimeError(
          "Legacy serve requires an existing nonempty data directory"
        );
      }
      throw error;
    }
    await assertRetainedDataDirectory(
      dataDir,
      directoryHandle
    );
    const authorityPath = retainedDirectoryAuthorityPath(
      dataDir,
      directoryHandle.fd
    );
    await validateRetainedLegacyDataDirectory(authorityPath, dataDir);
    for (const fileName of LEGACY_LEASE_FILES) {
      leases.push(await acquireLegacyFileLock(
        path.join(authorityPath, fileName)
      ));
    }
    await assertLockingFilesystem(
      path.join(authorityPath, DATA_DIRECTORY_LOCK),
      dataDir
    );
    await validateRetainedLegacyDataDirectory(authorityPath, dataDir);
    await assertMachineTierOutsideDirectory(
      authorityPath,
      canonicalMachineDirectory,
      LEGACY_MACHINE_TIER_BOUNDARY
    );
    const identity = await readMachineLocalHttpDataDirectoryIdentity({
      dataDirectory: authorityPath,
      machineDirectory: canonicalMachineDirectory
    });
    await assertRetainedDataDirectory(
      dataDir,
      directoryHandle
    );
    return legacyLease({
      dataDir,
      authorityPath,
      identity,
      directoryHandle,
      leases
    });
  } catch (error) {
    try {
      await releaseLegacyResources(leases, directoryHandle);
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "Legacy data lease acquisition and cleanup failed",
        { cause: error }
      );
    }
    throw error;
  }
}

interface RetainedFileLock {
  readonly handle: FileHandle;
  readonly lock: OsFileLock;
}

async function acquireLegacyFileLock(
  lockPath: string
): Promise<RetainedFileLock> {
  const handle = await open(lockPath, legacyLockOpenFlags(), 0o600);
  try {
    const handleInfo = await handle.stat();
    if (!handleInfo.isFile()
      || handleInfo.nlink !== 1
      || handleInfo.size !== 0) {
      throw new PublicRuntimeError(
        `Legacy serve lock is not an empty regular file: ${lockPath}`
      );
    }
    const pathInfo = await lstat(lockPath);
    requireSameFileIdentity(handleInfo, pathInfo, lockPath);
    return {
      handle,
      lock: await lockFile(handle.fd, lockPath)
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (isLockContention(error)) {
      throw new PublicRuntimeError(
        "Legacy serve data is already open by another 1667 process"
      );
    }
    throw error;
  }
}

function legacyLease(
  input: {
    readonly dataDir: string;
    readonly authorityPath: string;
    readonly identity: HttpDataDirectoryIdentity;
    readonly directoryHandle: FileHandle;
    readonly leases: readonly RetainedFileLock[];
  }
): LegacyDataDirectoryLease {
  let release: Promise<void> | null = null;
  return Object.freeze({
    dataDir: input.dataDir,
    dataFormat: 1,
    authorityPath: input.authorityPath,
    identity: input.identity,
    release: async () =>
      await (release ??= releaseLegacyResources(
        input.leases,
        input.directoryHandle
      ))
  }) as LegacyDataDirectoryLease;
}

async function releaseLegacyResources(
  leases: readonly RetainedFileLock[],
  directoryHandle: FileHandle | undefined
): Promise<void> {
  const failures: unknown[] = [];
  for (const lease of [...leases].reverse()) {
    try {
      await lease.lock.unlock();
    } catch (error) {
      failures.push(error);
    }
    try {
      await lease.handle.close();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await directoryHandle?.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "Legacy data lease release failed"
    );
  }
}

function legacyLockOpenFlags(): number | string {
  if (process.platform === "win32") return "a+";
  const closeOnExec = (constants as typeof constants & {
    O_CLOEXEC?: number;
  }).O_CLOEXEC ?? 0;
  return constants.O_RDWR | constants.O_CREAT
    | noFollowFlag() | closeOnExec;
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  open,
  stat,
  unlink,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";
import {
  noFollowFlag,
  readBoundedRegularFile,
  requireBoundedRegularFile,
  requireSameFileIdentity,
  sameFileIdentity
} from "./data-directory-file-read.js";
import { syncDirectory } from "./story-lifecycle.js";
import {
  isRetainedDirectoryAuthorityPath,
  retainedDirectoryOpenFlags
} from "./retained-directory-authority.js";
import { withReservedPathOwnership } from "./reserved-path-owner.js";
import {
  sealVaultFileForPath,
  vaultStoredByteLimit
} from "./vault-key-registry.js";

/**
 * No-replace publication of reserved private files.
 *
 * Ownership contract: every operation on one reserved pathname runs while
 * this process owns that pathname through an in-process FIFO gate. A reader
 * therefore never observes the intentional two-link commit window of a live
 * publication, and recovery never unlinks the scratch of a live writer.
 * Between processes the caller's domain lock — the data-directory lock or the
 * applicable private file lock — is the ownership boundary; the
 * data-directory lock probes its filesystem and refuses one whose locks do
 * not hold. Reads stay pure: they run recovery only when the deterministic
 * scratch name is present, and a committed reserved file must keep exactly
 * one hard link.
 */

const DIRECTORY_FLAG = typeof constants.O_DIRECTORY === "number"
  ? constants.O_DIRECTORY
  : 0;
const SCRATCH_SUFFIX = ".1667-publish-v1.tmp";

export interface PrivateFilePolicy {
  readonly label: string;
  readonly maxBytes: number;
  readonly allowLegacyReadMode?: boolean;
}

/** Exact typed scratch paired with one reserved final pathname. */
export function privatePublicationScratchPath(file: string): string {
  return `${file}${SCRATCH_SUFFIX}`;
}

/**
 * Write a complete private scratch inode, then atomically claim the reserved
 * final name without replacement. The final directory entry is durable before
 * this returns; scratch cleanup has its own durability barrier.
 */
export async function publishPrivateFileNoReplace(
  file: string,
  bytes: Uint8Array,
  policy: PrivateFilePolicy
): Promise<void> {
  requireBoundedBytes(bytes, policy);
  const storedBytes = sealVaultFileForPath(file, bytes);
  const storedPolicy = vaultStoragePolicy(file, policy);
  await withReservedPathOwnership(file, async () =>
    await publishOwned(file, storedBytes, storedPolicy));
}

async function publishOwned(
  file: string,
  bytes: Uint8Array,
  policy: PrivateFilePolicy
): Promise<void> {
  await recoverOwned(file, policy);
  if (await optionalPathInfo(file) !== null) throw alreadyExists(file);

  const scratch = privatePublicationScratchPath(file);
  const scratchPolicy = strictScratchPolicy(policy);
  const directory = path.dirname(file);
  await inspectPrivateDirectory(directory, policy.label);

  let handle: FileHandle | undefined;
  try {
    handle = await open(
      scratch,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600
    );
    if (process.platform !== "win32") await handle.chmod(0o600);
    const created = await handle.stat();
    requirePrivateRegularFile(created, scratch, scratchPolicy, 1);
    await handle.writeFile(bytes);
    await handle.sync();
    const written = await handle.stat();
    requirePrivateRegularFile(written, scratch, scratchPolicy, 1);
    if (written.size !== bytes.byteLength) {
      throw new Error(`${policy.label} scratch write was incomplete: ${scratch}`);
    }
    const pathInfo = await lstat(scratch);
    requirePrivateRegularFile(pathInfo, scratch, scratchPolicy, 1);
    requireSameIdentity(written, pathInfo, scratch);
  } finally {
    await handle?.close();
  }

  try {
    await link(scratch, file);
  } catch (error) {
    if (isErrorCode(error, "EEXIST")) {
      await removeValidatedScratch(scratch, scratchPolicy);
    }
    throw error;
  }

  const scratchInfo = await inspectPrivateRegularFile(scratch, scratchPolicy, 2);
  const finalInfo = await inspectPrivateRegularFile(file, policy, 2);
  requireSameIdentity(scratchInfo, finalInfo, file);

  // Commit barrier: the complete no-replace final entry is now durable.
  await syncPrivateDirectory(directory, policy.label);

  // Scratch removal needs no barrier of its own. The final entry is already
  // durable, and a crash before this unlink lands leaves the same-inode pair
  // `recoverPrivatePublication` is written to finish. Paying a second barrier
  // here bought nothing and cost as much as the publication itself.
  await unlink(scratch);
  const published = await inspectPrivateRegularFile(file, policy, 1);
  requireSameIdentity(finalInfo, published, file);
}

/**
 * Recover only this final/scratch pair. An unpublished scratch is discarded.
 * If both names are the same inode, publication already happened and cleanup
 * is completed. A valid final always wins over a distinct typed scratch.
 *
 * Recovery is an owner-only operation. The gate keeps it off a live writer in
 * this process; the caller's domain lock keeps it off every other process.
 */
export async function recoverPrivatePublication(
  file: string,
  policy: PrivateFilePolicy
): Promise<void> {
  await withReservedPathOwnership(file, async () =>
    await recoverOwned(file, vaultStoragePolicy(file, policy)));
}

async function recoverOwned(
  file: string,
  policy: PrivateFilePolicy
): Promise<void> {
  const scratch = privatePublicationScratchPath(file);
  const scratchPolicy = strictScratchPolicy(policy);
  const [initialFinal, initialScratch] = await Promise.all([
    optionalPathInfo(file),
    optionalPathInfo(scratch)
  ]);
  if (initialScratch === null) {
    if (initialFinal !== null) {
      await inspectPrivateRegularFile(file, policy, 1);
    }
    return;
  }

  const directory = path.dirname(file);
  await inspectPrivateDirectory(directory, policy.label);
  if (initialFinal === null) {
    await inspectPrivateRegularFile(scratch, scratchPolicy, 1);
    await unlink(scratch);
    await syncPrivateDirectory(directory, policy.label);
    return;
  }

  const sameInode = sameFileIdentity(initialFinal, initialScratch);
  const expectedLinks = sameInode ? 2 : 1;
  const finalInfo = await inspectPrivateRegularFile(file, policy, expectedLinks);
  const scratchInfo = await inspectPrivateRegularFile(scratch, scratchPolicy, expectedLinks);
  if (sameInode) requireSameIdentity(finalInfo, scratchInfo, scratch);

  await unlink(scratch);
  await syncPrivateDirectory(directory, policy.label);
  const recovered = await inspectPrivateRegularFile(file, policy, 1);
  requireSameIdentity(finalInfo, recovered, file);
}

export async function readOptionalPrivateFile(
  file: string,
  policy: PrivateFilePolicy
): Promise<Buffer | null> {
  return await withReservedPathOwnership(file, async () =>
    await readOptionalOwned(file, policy, vaultStoragePolicy(file, policy)));
}

async function readOptionalOwned(
  file: string,
  policy: PrivateFilePolicy,
  storedPolicy: PrivateFilePolicy
): Promise<Buffer | null> {
  if (await optionalPathInfo(privatePublicationScratchPath(file)) !== null) {
    await recoverOwned(file, storedPolicy);
  }
  try {
    if (await optionalPathInfo(file) === null) return null;
    await inspectPrivateDirectory(path.dirname(file), policy.label);
    const stored = await readBoundedRegularFile(
      file,
      policy.maxBytes,
      regularFileOptions(policy, 1)
    );
    requireBoundedBytes(stored, policy);
    return stored;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

/** Batch immutable siblings under one validated private directory. Each file
 * recovers typed publication residue and completes its bounded no-follow read
 * under one ownership interval. */
export async function readOptionalPrivateFiles(
  files: readonly string[],
  policy: PrivateFilePolicy
): Promise<readonly (Buffer | null)[]> {
  if (files.length === 0) return [];
  const directory = path.dirname(files[0]!);
  if (files.some((file) => path.dirname(file) !== directory)) {
    throw new Error(`${policy.label} batch crossed directories`);
  }
  await inspectPrivateDirectory(directory, policy.label);
  return await Promise.all(files.map(
    async (file) => await withReservedPathOwnership(file, async () => {
      if (await optionalPathInfo(privatePublicationScratchPath(file)) !== null) {
        await recoverOwned(file, vaultStoragePolicy(file, policy));
      }
      try {
        const stored = await readBoundedRegularFile(
          file,
          policy.maxBytes,
          regularFileOptions(policy, 1)
        );
        requireBoundedBytes(stored, policy);
        return stored;
      } catch (error) {
        if (isErrorCode(error, "ENOENT")) return null;
        throw error;
      }
    })
  ));
}

export async function removePrivateFile(
  file: string,
  policy: PrivateFilePolicy
): Promise<void> {
  const storedPolicy = vaultStoragePolicy(file, policy);
  await withReservedPathOwnership(file, async () => {
    await recoverOwned(file, storedPolicy);
    try {
      await inspectPrivateRegularFile(file, storedPolicy, 1);
      await unlink(file);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return;
      throw error;
    }
    await syncPrivateDirectory(path.dirname(file), policy.label);
  });
}

export async function inspectPrivateDirectory(
  directory: string,
  label: string
): Promise<Stats> {
  const retainedAuthority = isRetainedDirectoryAuthorityPath(directory);
  const pathInfo = retainedAuthority
    ? await stat(directory)
    : await lstat(directory);
  requirePrivateDirectory(pathInfo, directory, label);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      directory,
      retainedAuthority ? retainedDirectoryOpenFlags() : directoryOpenFlags()
    );
    const handleInfo = await handle.stat();
    requirePrivateDirectory(handleInfo, directory, label);
    requireSameIdentity(pathInfo, handleInfo, directory);
    return handleInfo;
  } finally {
    await handle?.close();
  }
}

export async function syncPrivateDirectory(
  directory: string,
  label: string
): Promise<void> {
  const before = await inspectPrivateDirectory(directory, label);
  await syncDirectory(directory);
  const after = await inspectPrivateDirectory(directory, label);
  requireSameIdentity(before, after, directory);
}

async function inspectPrivateRegularFile(
  file: string,
  policy: PrivateFilePolicy,
  expectedLinks: 1 | 2
): Promise<Stats> {
  const pathInfo = await lstat(file);
  requirePrivateRegularFile(pathInfo, file, policy, expectedLinks);
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | noFollowFlag());
    const handleInfo = await handle.stat();
    requirePrivateRegularFile(handleInfo, file, policy, expectedLinks);
    requireSameIdentity(pathInfo, handleInfo, file);
    return handleInfo;
  } finally {
    await handle?.close();
  }
}

async function removeValidatedScratch(
  scratch: string,
  policy: PrivateFilePolicy
): Promise<void> {
  await inspectPrivateRegularFile(scratch, policy, 1);
  await unlink(scratch);
  await syncPrivateDirectory(path.dirname(scratch), policy.label);
}

function requireBoundedBytes(bytes: Uint8Array, policy: PrivateFilePolicy): void {
  if (bytes.byteLength > policy.maxBytes) {
    throw new Error(`${policy.label} exceeds its ${policy.maxBytes}-byte limit`);
  }
}

function strictScratchPolicy(policy: PrivateFilePolicy): PrivateFilePolicy {
  return policy.allowLegacyReadMode
    ? { label: policy.label, maxBytes: policy.maxBytes }
    : policy;
}

function vaultStoragePolicy(file: string, policy: PrivateFilePolicy): PrivateFilePolicy {
  const maxBytes = vaultStoredByteLimit(file, policy.maxBytes);
  return maxBytes === policy.maxBytes ? policy : { ...policy, maxBytes };
}

function requirePrivateDirectory(info: Stats, directory: string, label: string): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} parent is not a private directory: ${directory}`);
  }
  requirePrivateOwnerMode(info, directory, 0o700, label);
}

function requirePrivateRegularFile(
  info: Stats,
  file: string,
  policy: PrivateFilePolicy,
  expectedLinks: 1 | 2
): void {
  requireBoundedRegularFile(
    info,
    file,
    policy.maxBytes,
    regularFileOptions(policy, expectedLinks)
  );
}

function requirePrivateOwnerMode(
  info: Stats,
  target: string,
  expectedMode: number,
  label: string
): void {
  if (process.platform === "win32") return;
  if ((info.mode & 0o777) !== expectedMode) {
    throw new Error(`${label} permissions are unsafe: ${target}`);
  }
  requirePrivateOwner(info, target, label);
}

function requirePrivateOwner(info: Stats, target: string, label: string): void {
  if (process.platform !== "win32"
    && typeof process.geteuid === "function"
    && info.uid !== process.geteuid()) {
    throw new Error(`${label} owner is unsafe: ${target}`);
  }
}

function requireSameIdentity(left: Stats, right: Stats, target: string): void {
  requireSameFileIdentity(left, right, target);
}

function regularFileOptions(
  policy: PrivateFilePolicy,
  expectedLinks: 1 | 2
) {
  return {
    requirePrivate: policy.allowLegacyReadMode !== true,
    allowLegacyOwnerReadMode: policy.allowLegacyReadMode === true,
    allowedLinkCounts: [expectedLinks]
  } as const;
}

async function optionalPathInfo(file: string): Promise<Stats | null> {
  try {
    return await lstat(file);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

function directoryOpenFlags(): number | string {
  if (process.platform === "win32") return "a+";
  return constants.O_RDONLY | DIRECTORY_FLAG | noFollowFlag();
}

function alreadyExists(file: string): NodeJS.ErrnoException {
  const error = new Error(
    `Reserved private publication already exists: ${file}`
  ) as NodeJS.ErrnoException;
  error.code = "EEXIST";
  return error;
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

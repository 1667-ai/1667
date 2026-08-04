import { constants, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
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
import { isLockContention, lockFile, type OsFileLock } from "./os-file-lock.js";
import { syncDirectory } from "./story-lifecycle.js";
import {
  isRetainedDirectoryAuthorityPath,
  retainedDirectoryOpenFlags
} from "./retained-directory-authority.js";

const DIRECTORY_FLAG = typeof constants.O_DIRECTORY === "number"
  ? constants.O_DIRECTORY
  : 0;
const SCRATCH_SUFFIX = ".1667-publish-v1.tmp";

export interface PrivateFilePolicy {
  readonly label: string;
  readonly maxBytes: number;
  readonly allowLegacyReadMode?: boolean;
}

export type TypedPrivatePublicationResidue =
  | "none"
  | "scratch"
  | "published";

export type InvalidPrivatePublicationResidue = (
  detail: string,
  cause?: unknown
) => Error;

/** Exact typed scratch paired with one reserved final pathname. */
export function privatePublicationScratchPath(file: string): string {
  return `${file}${SCRATCH_SUFFIX}`;
}

/**
 * Read-only recognition of states emitted by private no-replace publication.
 * A lone scratch may be a prefix of any accepted value. Once the published
 * name exists, both names must describe its one exact accepted value.
 */
export async function inspectTypedPrivatePublicationResidue(
  file: string,
  acceptedValues: readonly Uint8Array[],
  policy: PrivateFilePolicy,
  invalidResidue: InvalidPrivatePublicationResidue
): Promise<TypedPrivatePublicationResidue> {
  if (acceptedValues.length === 0) {
    throw new Error(`${policy.label} requires at least one accepted value`);
  }
  const accepted = acceptedValues.map((value) => Buffer.from(value));
  const scratch = privatePublicationScratchPath(file);
  const [fileBytes, scratchBytes] = await Promise.all([
    readTypedResidueOrAbsent(file, policy, invalidResidue),
    readTypedResidueOrAbsent(scratch, policy, invalidResidue)
  ]);
  if (fileBytes === null) {
    if (scratchBytes === null) return "none";
    if (!accepted.some((value) => isBufferPrefix(scratchBytes, value))) {
      throw invalidResidue(
        `${policy.label} scratch is not an exact prefix of the expected canonical bytes`
      );
    }
    const scratchInfo = await lstat(scratch);
    requireResidueLinkCount(
      scratchInfo,
      1,
      `${policy.label} single-name residue has an unsafe link count`,
      invalidResidue
    );
    return "scratch";
  }

  const publishedValue = accepted.find((value) => fileBytes.equals(value));
  if (publishedValue === undefined) {
    throw invalidResidue(
      `${policy.label} next is not the exact expected canonical bytes`
    );
  }
  const fileInfo = await lstat(file);
  if (scratchBytes === null) {
    requireResidueLinkCount(
      fileInfo,
      1,
      `${policy.label} single-name residue has an unsafe link count`,
      invalidResidue
    );
    return "published";
  }
  if (!isBufferPrefix(scratchBytes, publishedValue)) {
    throw invalidResidue(
      `${policy.label} scratch is not an exact prefix of the expected canonical bytes`
    );
  }

  const scratchInfo = await lstat(scratch);
  if (sameFileIdentity(fileInfo, scratchInfo)) {
    if (!scratchBytes.equals(publishedValue)) {
      throw invalidResidue(
        `${policy.label} linked publication residue is not an exact complete pair`
      );
    }
    requireResidueLinkCount(
      fileInfo,
      2,
      `${policy.label} linked publication residue has an unsafe link count`,
      invalidResidue
    );
    requireResidueLinkCount(
      scratchInfo,
      2,
      `${policy.label} linked publication residue has an unsafe link count`,
      invalidResidue
    );
  } else if (
    !scratchBytes.equals(publishedValue)
    || !hasResidueLinkCount(fileInfo, 1)
    || !hasResidueLinkCount(scratchInfo, 1)
  ) {
    throw invalidResidue(
      `${policy.label} distinct publication residue is not an exact complete pair`
    );
  }
  return "published";
}

/**
 * Write a complete private scratch inode, then atomically claim the reserved
 * final name without replacement. The final directory entry is durable before
 * this returns; scratch cleanup has its own durability barrier.
 *
 * The scratch inode is written under a private staging name first, and
 * exclusively `flock`ed there before `scratch` -- the name
 * `recoverPrivatePublication` actually watches -- ever exists. Linking a
 * locked inode to a new name does not create a window in which that name is
 * visible but unlocked, unlike locking a name only after creating it: nothing
 * observes the staging name (it is random and nothing else in this module
 * looks for it), so `scratch`'s very first appearance is already backed by
 * a held lock. This process keeps that lock through `link` and the cleanup
 * `unlink`, which is the fact recovery trusts to tell a live writer apart
 * from a crashed one: the kernel releases the lock the instant this process
 * dies, so a crashed writer's residue is unlocked and a live one's is not,
 * with certainty rather than a timeout.
 */
export async function publishPrivateFileNoReplace(
  file: string,
  bytes: Uint8Array,
  policy: PrivateFilePolicy
): Promise<void> {
  requireBoundedBytes(bytes, policy);
  await recoverPrivatePublication(file, policy);
  if (await optionalPathInfo(file) !== null) throw alreadyExists(file);

  const scratch = privatePublicationScratchPath(file);
  const scratchPolicy = strictScratchPolicy(policy);
  const directory = path.dirname(file);
  await inspectPrivateDirectory(directory, policy.label);
  const staging = `${scratch}.${randomUUID()}`;

  let handle: FileHandle | undefined;
  let lock: OsFileLock | undefined;
  try {
    handle = await open(
      staging,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600
    );
    lock = await lockFile(handle.fd, staging);
    if (process.platform !== "win32") await handle.chmod(0o600);
    const created = await handle.stat();
    requirePrivateRegularFile(created, staging, scratchPolicy, 1);
    await handle.writeFile(bytes);
    await handle.sync();
    const written = await handle.stat();
    requirePrivateRegularFile(written, staging, scratchPolicy, 1);
    if (written.size !== bytes.byteLength) {
      throw new Error(`${policy.label} scratch write was incomplete: ${staging}`);
    }
    const pathInfo = await lstat(staging);
    requirePrivateRegularFile(pathInfo, staging, scratchPolicy, 1);
    requireSameIdentity(written, pathInfo, staging);

    // `scratch`'s first appearance is this `link`, already backed by the
    // lock held above. The staging name never serves another purpose after
    // this, whichever way it goes: a failure here (most plausibly `EEXIST`,
    // meaning another writer already owns `scratch`) is this attempt's own
    // to clean up, not a reason to touch whatever is already at `scratch`.
    try {
      await link(staging, scratch);
    } finally {
      await unlink(staging);
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
  } finally {
    await lock?.unlock();
    await handle?.close();
  }
}

/**
 * Recover only this final/scratch pair. An unpublished scratch is discarded.
 * If both names are the same inode, publication already happened and cleanup
 * is completed. A valid final always wins over a distinct typed scratch.
 *
 * A same-inode or lone-scratch pair looks identical whether it is a crashed
 * writer's leftovers or a live writer mid-publish, from one stat snapshot.
 * Elapsed time cannot tell those apart either: `fsync` has no upper bound, so
 * no timeout distinguishes "slow" from "gone". A non-blocking claim on the
 * writer's own `flock` can, with certainty: contention proves a writer is
 * still working and this backs off untouched; success proves none is, because
 * the kernel released a crashed writer's lock with the process that held it.
 */
export async function recoverPrivatePublication(
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

  const claim = await claimScratchForRecovery(scratch);
  if (claim === null) return;
  try {
    // The claim's success proves no writer is active now, but a writer we
    // raced a moment ago may have finished normally in between -- unlinking
    // its own scratch -- rather than crashing. Re-derive from here instead of
    // trusting the snapshot taken before the claim.
    const [currentFinal, currentScratch] = await Promise.all([
      optionalPathInfo(file),
      optionalPathInfo(scratch)
    ]);
    if (currentScratch === null) {
      if (currentFinal !== null) await inspectPrivateRegularFile(file, policy, 1);
      return;
    }
    if (currentFinal === null) {
      await inspectPrivateRegularFile(scratch, scratchPolicy, 1);
      await unlink(scratch);
      await syncPrivateDirectory(directory, policy.label);
      return;
    }

    const sameInode = sameFileIdentity(currentFinal, currentScratch);
    const expectedLinks = sameInode ? 2 : 1;
    const finalInfo = await inspectPrivateRegularFile(file, policy, expectedLinks);
    const scratchInfo = await inspectPrivateRegularFile(scratch, scratchPolicy, expectedLinks);
    if (sameInode) requireSameIdentity(finalInfo, scratchInfo, scratch);

    await unlink(scratch);
    await syncPrivateDirectory(directory, policy.label);
    const recovered = await inspectPrivateRegularFile(file, policy, 1);
    requireSameIdentity(finalInfo, recovered, file);
  } finally {
    await claim.lock.unlock();
    await claim.handle.close();
  }
}

/**
 * Try to claim the same lock a live writer holds on this scratch. `null`
 * covers both "nothing to claim" (the scratch is already gone -- a writer
 * finished, or another recovery pass already acted) and "a live writer holds
 * it" (`EWOULDBLOCK`): either way, recovery has nothing safe to do.
 */
async function claimScratchForRecovery(
  scratch: string
): Promise<{ readonly handle: FileHandle; readonly lock: OsFileLock } | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(scratch, constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  }
  try {
    const lock = await lockFile(handle.fd, scratch);
    return { handle, lock };
  } catch (error) {
    await handle.close();
    if (isLockContention(error)) return null;
    throw error;
  }
}

export async function readOptionalPrivateFile(
  file: string,
  policy: PrivateFilePolicy
): Promise<Buffer | null> {
  await recoverPrivatePublication(file, policy);
  try {
    if (await optionalPathInfo(file) === null) return null;
    await inspectPrivateDirectory(path.dirname(file), policy.label);
    return await readBoundedRegularFile(file, policy.maxBytes, regularFileOptions(policy, 1));
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

/** Batch immutable siblings under one validated private directory. Receipt
 * reads use this to recover every typed publication first, then validate the
 * shared directory once more before bounded no-follow reads. */
export async function readOptionalPrivateFiles(
  files: readonly string[],
  policy: PrivateFilePolicy
): Promise<readonly (Buffer | null)[]> {
  if (files.length === 0) return [];
  const directory = path.dirname(files[0]!);
  if (files.some((file) => path.dirname(file) !== directory)) {
    throw new Error(`${policy.label} batch crossed directories`);
  }
  await Promise.all(files.map(
    async (file) => await recoverPrivatePublicationBeforeRead(file, policy)
  ));
  await inspectPrivateDirectory(directory, policy.label);
  return await Promise.all(files.map(async (file) => {
    try {
      return await readBoundedRegularFile(
        file,
        policy.maxBytes,
        regularFileOptions(policy, 1)
      );
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return null;
      throw error;
    }
  }));
}

async function recoverPrivatePublicationBeforeRead(
  file: string,
  policy: PrivateFilePolicy
): Promise<void> {
  if (await optionalPathInfo(privatePublicationScratchPath(file)) === null) {
    return;
  }
  await recoverPrivatePublication(file, policy);
}

export async function removePrivateFile(
  file: string,
  policy: PrivateFilePolicy
): Promise<void> {
  await recoverPrivatePublication(file, policy);
  try {
    await inspectPrivateRegularFile(file, policy, 1);
    await unlink(file);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return;
    throw error;
  }
  await syncPrivateDirectory(path.dirname(file), policy.label);
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

async function readTypedResidueOrAbsent(
  file: string,
  policy: PrivateFilePolicy,
  invalidResidue: InvalidPrivatePublicationResidue
): Promise<Buffer | null> {
  try {
    return await readBoundedRegularFile(file, policy.maxBytes, {
      requirePrivate: true,
      allowedLinkCounts: [1, 2]
    });
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw invalidResidue(
      `${path.basename(file)} is not safe private publication residue`,
      error
    );
  }
}

function isBufferPrefix(candidate: Buffer, expected: Buffer): boolean {
  return candidate.byteLength <= expected.byteLength
    && candidate.equals(expected.subarray(0, candidate.byteLength));
}

function requireResidueLinkCount(
  info: Stats,
  expected: 1 | 2,
  detail: string,
  invalidResidue: InvalidPrivatePublicationResidue
): void {
  if (!hasResidueLinkCount(info, expected)) throw invalidResidue(detail);
}

function hasResidueLinkCount(info: Stats, expected: 1 | 2): boolean {
  return process.platform === "win32" || Number(info.nlink) === expected;
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

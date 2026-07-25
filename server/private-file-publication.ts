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

  await unlink(scratch);
  await syncPrivateDirectory(directory, policy.label);
  const published = await inspectPrivateRegularFile(file, policy, 1);
  requireSameIdentity(finalInfo, published, file);
}

/**
 * Recover only this final/scratch pair. An unpublished scratch is discarded.
 * If both names are the same inode, publication already happened and cleanup
 * is completed. A valid final always wins over a distinct typed scratch.
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

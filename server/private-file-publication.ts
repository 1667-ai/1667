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
  sameFileIdentity,
  UnsafeLinkCountError
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
    await finishPreLinkScratch(file, scratch, policy, scratchPolicy, directory, initialScratch);
    return;
  }

  if (sameFileIdentity(initialFinal, initialScratch)) {
    await finishSameInodePublication(file, scratch, policy, scratchPolicy, directory);
    return;
  }

  // Distinct scratch and final: an abandoned attempt that never reached
  // `link`, sitting beside an already-published final. `publishPrivateFileNoReplace`
  // refuses to start a fresh attempt while `file` already exists, so nothing
  // live is racing this cleanup.
  const finalInfo = await inspectPrivateRegularFile(file, policy, 1);
  await inspectPrivateRegularFile(scratch, scratchPolicy, 1);
  await unlink(scratch);
  await syncPrivateDirectory(directory, policy.label);
  const recovered = await inspectPrivateRegularFile(file, policy, 1);
  requireSameIdentity(finalInfo, recovered, file);
}

/**
 * A scratch exists and the final name does not: exactly the shape a writer's
 * own scratch is in before its `link` call lands, and exactly what an
 * abandoned pre-link crash leaves behind. The two are indistinguishable from
 * one snapshot, so wait for the state to prove itself one way or the other
 * before deleting anything: a live writer settles this in its own bounded
 * fsync-and-link step, while a genuinely abandoned scratch never changes.
 * Unlinking on the strength of a single stale observation would delete a live
 * writer's own scratch before it ever reaches `link`.
 */
async function finishPreLinkScratch(
  file: string,
  scratch: string,
  policy: PrivateFilePolicy,
  scratchPolicy: PrivateFilePolicy,
  directory: string,
  initialScratch: Stats
): Promise<void> {
  await awaitPreLinkScratchSettled(file, scratch, initialScratch);
  const [currentFinal, currentScratch] = await Promise.all([
    optionalPathInfo(file),
    optionalPathInfo(scratch)
  ]);
  const unchanged = currentFinal === null
    && currentScratch !== null
    && sameFileIdentity(initialScratch, currentScratch)
    && Number(currentScratch.nlink) === 1;
  if (!unchanged) {
    // Something moved while waiting — a writer reached `link`, or another
    // recovery pass already acted. Decide again from fresh state rather than
    // continue down a branch that assumed the old one.
    await recoverPrivatePublication(file, policy);
    return;
  }
  try {
    await inspectPrivateRegularFile(scratch, scratchPolicy, 1);
    await unlink(scratch);
  } catch (error) {
    // One last, vanishingly small window between the check above and here:
    // treat it the same as "something moved" rather than crash a concurrent
    // writer or reader that resolved it in the meantime.
    if (isErrorCode(error, "ENOENT") || error instanceof UnsafeLinkCountError) {
      await recoverPrivatePublication(file, policy);
      return;
    }
    throw error;
  }
  await syncPrivateDirectory(directory, policy.label);
}

/**
 * Wait, without mutating anything, for a lone pre-link scratch to prove it is
 * settled: still the same inode, still nlink 1, with `file` still absent. A
 * live writer changes this quickly (write, fsync, `link`); a genuinely
 * abandoned scratch never does, so exhausting the bound is itself the signal
 * that nothing is using it.
 */
async function awaitPreLinkScratchSettled(
  file: string,
  scratch: string,
  initialScratch: Stats
): Promise<void> {
  if (process.platform === "win32") return;
  for (let attempt = 0; attempt < PUBLICATION_SETTLE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(2 ** attempt, PUBLICATION_SETTLE_STEP_MS)));
    }
    const [fileInfo, scratchInfo] = await Promise.all([
      optionalPathInfo(file),
      optionalPathInfo(scratch)
    ]);
    if (
      fileInfo !== null
      || scratchInfo === null
      || !sameFileIdentity(initialScratch, scratchInfo)
      || Number(scratchInfo.nlink) !== 1
    ) {
      return;
    }
  }
}

/**
 * A final entry and its scratch sibling share one inode: exactly the shape
 * `publishPrivateFileNoReplace` holds between its `link` and its cleanup
 * `unlink`. That could be a crash artifact, or it could be a live writer
 * finishing right now — a plain read cannot tell the two apart from one
 * snapshot, and a concurrent caller cannot either. Wait for it to settle on
 * its own before touching either name: unlinking `scratch` on the assumption
 * this is abandoned would delete a live writer's own scratch out from under
 * it (that unlink is exactly the call `publishPrivateFileNoReplace` still has
 * pending). Only once the wait is exhausted — no writer is finishing this —
 * does recovery take over and complete the cleanup itself.
 */
async function finishSameInodePublication(
  file: string,
  scratch: string,
  policy: PrivateFilePolicy,
  scratchPolicy: PrivateFilePolicy,
  directory: string
): Promise<void> {
  await awaitOwnPublicationSettled(file, scratch);
  const [currentFinal, currentScratch] = await Promise.all([
    optionalPathInfo(file),
    optionalPathInfo(scratch)
  ]);
  if (currentScratch === null) {
    // A writer (ours or a concurrent recovery call) already finished. Confirm
    // the result rather than act on stale expectations.
    if (currentFinal !== null) await inspectPrivateRegularFile(file, policy, 1);
    return;
  }
  if (currentFinal === null || !sameFileIdentity(currentFinal, currentScratch)) {
    // The shape changed while waiting; decide again against what is actually
    // there now instead of continuing down a stale branch.
    await recoverPrivatePublication(file, policy);
    return;
  }

  try {
    const finalInfo = await inspectPrivateRegularFile(file, policy, 2);
    const scratchInfo = await inspectPrivateRegularFile(scratch, scratchPolicy, 2);
    requireSameIdentity(finalInfo, scratchInfo, scratch);
    await unlink(scratch);
    await syncPrivateDirectory(directory, policy.label);
    const recovered = await inspectPrivateRegularFile(file, policy, 1);
    requireSameIdentity(finalInfo, recovered, file);
  } catch (error) {
    // One last, vanishingly small window between the fresh check above and
    // here: treat it the same as "something moved" rather than crash a
    // concurrent writer or reader that resolved it in the meantime.
    if (isErrorCode(error, "ENOENT") || error instanceof UnsafeLinkCountError) {
      await recoverPrivatePublication(file, policy);
      return;
    }
    throw error;
  }
}

const PUBLICATION_SETTLE_ATTEMPTS = 20;
const PUBLICATION_SETTLE_STEP_MS = 64;

/**
 * Wait, without mutating anything, for a proven own-publication window to
 * settle. The caller has already confirmed `file` and `scratch` share one
 * inode with `nlink === 2` — the exact shape `publishPrivateFileNoReplace`
 * holds between its `link` and its cleanup `unlink`. A live writer finishes
 * that in a handful of local syscalls plus one directory fsync, so this
 * returns almost immediately in the case it exists for. A pair that never
 * settles is not a slow publication: the writer is gone, and the caller falls
 * back to its own settled behaviour (a read fails closed; recovery finishes
 * the cleanup itself).
 */
async function awaitOwnPublicationSettled(file: string, scratch: string): Promise<void> {
  if (process.platform === "win32") return;
  for (let attempt = 0; attempt < PUBLICATION_SETTLE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(2 ** attempt, PUBLICATION_SETTLE_STEP_MS)));
    }
    const [fileInfo, scratchInfo] = await Promise.all([
      optionalPathInfo(file),
      optionalPathInfo(scratch)
    ]);
    if (!isProvenOwnPublicationWindow(fileInfo, scratchInfo)) return;
  }
}

/**
 * `nlink === 2` alone never justifies patience: a genuine second hard link
 * must fail closed immediately, since a reader cannot otherwise tell it apart
 * from this module's own transient publication state. Proof requires the
 * exact companion this protocol produces — a scratch sibling at the reserved
 * suffix path sharing the file's precise inode.
 */
function isProvenOwnPublicationWindow(
  fileInfo: Stats | null,
  scratchInfo: Stats | null
): boolean {
  return process.platform !== "win32"
    && fileInfo !== null
    && scratchInfo !== null
    && Number(fileInfo.nlink) === 2
    && sameFileIdentity(fileInfo, scratchInfo);
}

/**
 * Read a reserved file this module may still be publishing. `nlink === 2` is
 * rejected exactly like any other unsafe link count unless a same-suffix
 * scratch sibling shares its inode. Only that proven, self-explained window
 * gets a bounded wait for the writer's commit barrier and cleanup unlink; an
 * unexplained `nlink === 2` is rejected on the first read, with no retry and
 * no added latency.
 */
async function readReservedPrivateFile(
  file: string,
  policy: PrivateFilePolicy
): Promise<Buffer> {
  try {
    return await readBoundedRegularFile(file, policy.maxBytes, regularFileOptions(policy, 1));
  } catch (error) {
    if (!(error instanceof UnsafeLinkCountError)) throw error;
    const scratch = privatePublicationScratchPath(file);
    const [fileInfo, scratchInfo] = await Promise.all([
      optionalPathInfo(file),
      optionalPathInfo(scratch)
    ]);
    if (!isProvenOwnPublicationWindow(fileInfo, scratchInfo)) throw error;
    await awaitOwnPublicationSettled(file, scratch);
    return await readBoundedRegularFile(file, policy.maxBytes, regularFileOptions(policy, 1));
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
    return await readReservedPrivateFile(file, policy);
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
      return await readReservedPrivateFile(file, policy);
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

import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import {
  readBoundedRegularFile,
  sameFileIdentity
} from "./data-directory-file-read.js";
import {
  privatePublicationScratchPath,
  type PrivateFilePolicy
} from "./private-file-publication.js";
import { withReservedPathOwnership } from "./reserved-path-owner.js";

export type TypedPrivatePublicationResidue =
  | "none"
  | "scratch"
  | "published";

export type InvalidPrivatePublicationResidue = (
  detail: string,
  cause?: unknown
) => Error;

/**
 * Read-only recognition of states emitted by private no-replace publication.
 * A lone scratch may be a prefix of any accepted value. Once the published
 * name exists, both names must describe its one exact accepted value.
 *
 * Recognition runs while this process owns the reserved pathname, so a live
 * publication in this process is never mistaken for residue.
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
  return await withReservedPathOwnership(file, async () =>
    await inspectTypedResidueOwned(file, acceptedValues, policy, invalidResidue));
}

async function inspectTypedResidueOwned(
  file: string,
  acceptedValues: readonly Uint8Array[],
  policy: PrivateFilePolicy,
  invalidResidue: InvalidPrivatePublicationResidue
): Promise<TypedPrivatePublicationResidue> {
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

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

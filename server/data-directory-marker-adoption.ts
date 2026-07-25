import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  noFollowFlag,
  requireBoundedRegularFile,
  requireSameFileIdentity,
  sameFileSnapshot
} from "./data-directory-file-read.js";
import {
  dataDirectoryOwnerMarkerText,
  MAX_DATA_DIRECTORY_OWNER_MARKER_BYTES,
  parseDataDirectoryOwnerMarkerBytes,
  readDataDirectoryFormat
} from "./data-directory-format.js";
import {
  type DataDirectoryFormat,
  DATA_DIRECTORY_OWNER_MARKER,
  DATA_DIRECTORY_OWNER_MARKER_NEXT,
  LEGACY_PREVIEW_DATA_MARKER,
  LEGACY_PREVIEW_DATA_MARKER_TEXT
} from "./data-directory-layout.js";
import { ServiceError } from "./errors.js";
import {
  inspectTypedPrivatePublicationResidue,
  removePrivateFile,
  type PrivateFilePolicy
} from "./private-file-publication.js";

const MARKER_LABEL = "Data-directory owner marker";
const OWNER_MARKER_POLICY: PrivateFilePolicy = Object.freeze({
  label: MARKER_LABEL,
  maxBytes: MAX_DATA_DIRECTORY_OWNER_MARKER_BYTES
});

export type DataDirectoryFormatSource = "owner-marker" | "legacy-preview";

export interface LockedDataDirectoryMarkerAdoption {
  readonly dataFormat: DataDirectoryFormat;
  readonly source: DataDirectoryFormatSource;
}

export async function assertRetainedDataDirectory(
  dataDir: string,
  handle: FileHandle
): Promise<void> {
  await requireRetainedDataDirectory(dataDir, handle);
}

/**
 * Read the format this directory declares while the caller holds its lock.
 *
 * ADR007 reduced this to a version read. The double-read across a durability
 * barrier it used to perform defended a marker in a directory 1667 did not own;
 * the single-writer lock is held by the time this runs, so nothing else can
 * publish a different marker underneath it.
 */
export async function adoptLockedDataDirectoryMarker(
  dataDir: string,
  dataDirectoryHandle: FileHandle
): Promise<LockedDataDirectoryMarkerAdoption> {
  await requireRetainedDataDirectory(dataDir, dataDirectoryHandle);
  const visible = await readVisibleMarker(dataDir);
  const validatedFormat = await readDataDirectoryFormat(dataDir);
  if (validatedFormat !== visible.dataFormat) {
    throw markerAdoptionError(dataDir, "validated marker format differs from the marker");
  }
  if (visible.source === "owner-marker") {
    await discardOwnerMarkerNextResidue(dataDir);
    await requireRetainedDataDirectory(dataDir, dataDirectoryHandle);
  }
  return visible;
}

/** A crash between staging and publication leaves the `.next` name behind; it
 * carries no state, so recognizing and removing it is the whole recovery. */
async function discardOwnerMarkerNextResidue(dataDir: string): Promise<void> {
  const nextPath = path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER_NEXT);
  await inspectTypedPrivatePublicationResidue(
    nextPath,
    ([1, 2] as const).map((dataFormat) =>
      Buffer.from(dataDirectoryOwnerMarkerText(dataFormat), "utf8")),
    OWNER_MARKER_POLICY,
    (detail, cause) => markerAdoptionError(dataDir, detail, cause)
  );
  await removePrivateFile(nextPath, OWNER_MARKER_POLICY);
}

async function readVisibleMarker(
  dataDir: string
): Promise<LockedDataDirectoryMarkerAdoption> {
  const ownerPath = path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER);
  try {
    const bytes = await readMarkerBytes(ownerPath, true);
    if (await pathExists(path.join(dataDir, LEGACY_PREVIEW_DATA_MARKER))) {
      throw markerAdoptionError(
        ownerPath,
        "both current and legacy-preview markers are present"
      );
    }
    return {
      dataFormat: parseDataDirectoryOwnerMarkerBytes(bytes, ownerPath).dataFormat,
      source: "owner-marker"
    };
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }

  const legacyPath = path.join(dataDir, LEGACY_PREVIEW_DATA_MARKER);
  const bytes = await readMarkerBytes(legacyPath, false);
  if (!bytes.equals(Buffer.from(LEGACY_PREVIEW_DATA_MARKER_TEXT, "utf8"))) {
    throw markerAdoptionError(legacyPath, "legacy-preview marker bytes differ");
  }
  return { dataFormat: 1, source: "legacy-preview" };
}

/** One stable bounded no-follow read: the marker may not change under it. */
async function readMarkerBytes(
  markerPath: string,
  requirePrivate: boolean
): Promise<Buffer> {
  const policy = { requirePrivate, allowedLinkCounts: [1] } as const;
  const bounded = (info: Stats) => requireBoundedRegularFile(
    info,
    markerPath,
    MAX_DATA_DIRECTORY_OWNER_MARKER_BYTES,
    policy
  );
  let handle: FileHandle | undefined;
  try {
    const pathInfo = await lstat(markerPath);
    bounded(pathInfo);
    handle = await open(markerPath, constants.O_RDONLY | noFollowFlag());
    const before = await handle.stat();
    bounded(before);
    requireSameFileIdentity(pathInfo, before, markerPath);

    const bytes = Buffer.alloc(Number(before.size) + 1);
    let total = 0;
    while (total < bytes.byteLength) {
      const result = await handle.read(bytes, total, bytes.byteLength - total, total);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
    }

    const after = await handle.stat();
    bounded(after);
    if (total !== Number(before.size) || !sameFileSnapshot(before, after)) {
      throw markerAdoptionError(markerPath, "marker changed while being read");
    }
    return bytes.subarray(0, total);
  } catch (error) {
    if (isErrorCode(error, "ENOENT") || error instanceof ServiceError) throw error;
    throw markerAdoptionError(markerPath, "marker is not a stable bounded regular file", error);
  } finally {
    await handle?.close();
  }
}

async function requireRetainedDataDirectory(
  dataDir: string,
  handle: FileHandle
): Promise<Stats> {
  const opened = await handle.stat();
  requireRetainedDirectory(opened, dataDir);
  const linked = await lstat(dataDir);
  requireRetainedDirectory(linked, dataDir);
  requireSameFileIdentity(opened, linked, dataDir);
  return opened;
}

/** ADR007 keeps the retained descriptor that roots every later open, and drops
 * the mode and owner assertions about a directory the user chose. */
function requireRetainedDirectory(info: Stats, dataDir: string): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw markerAdoptionError(dataDir, "retained data directory is not a directory");
  }
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
    return false;
  }
}

function markerAdoptionError(target: string, detail: string, cause?: unknown): ServiceError {
  const failure = new ServiceError(
    500,
    `1667 data marker adoption failed: ${target} (${detail})`
  );
  if (cause !== undefined) failure.cause = cause;
  return failure;
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

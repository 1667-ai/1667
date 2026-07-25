import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  noFollowFlag,
  requireBoundedRegularFile,
  requireSameFileIdentity,
  sameFileIdentity,
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

interface MarkerSnapshot extends LockedDataDirectoryMarkerAdoption {
  readonly bytes: Buffer;
  readonly info: Stats;
}

/**
 * Commit and adopt the marker mapping selected while the caller owns the data
 * lock. The retained directory handle prevents a path replacement from
 * redirecting the durability barrier. Format-specific stores remain unopened
 * until this returns.
 */
export async function adoptLockedDataDirectoryMarker(
  dataDir: string,
  dataDirectoryHandle: FileHandle
): Promise<LockedDataDirectoryMarkerAdoption> {
  await requireRetainedDataDirectory(dataDir, dataDirectoryHandle);
  const visible = await readVisibleMarkerSnapshot(dataDir);
  await syncRetainedDataDirectory(dataDir, dataDirectoryHandle);
  const reopened = await readVisibleMarkerSnapshot(dataDir);

  if (
    visible.source !== reopened.source
    || visible.dataFormat !== reopened.dataFormat
    || !visible.bytes.equals(reopened.bytes)
    || !sameFileIdentity(visible.info, reopened.info)
  ) {
    throw markerAdoptionError(
      dataDir,
      "visible marker changed across the locked directory durability barrier"
    );
  }

  await requireRetainedDataDirectory(dataDir, dataDirectoryHandle);
  const validatedFormat = await readDataDirectoryFormat(dataDir);
  if (validatedFormat !== reopened.dataFormat) {
    throw markerAdoptionError(
      dataDir,
      "validated marker format changed after durable adoption"
    );
  }
  if (reopened.source === "owner-marker") {
    await validateOwnerMarkerNextResidue(dataDir);
    await removePrivateFile(
      path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER_NEXT),
      OWNER_MARKER_POLICY
    );
    await requireRetainedDataDirectory(dataDir, dataDirectoryHandle);
  }
  return { dataFormat: reopened.dataFormat, source: reopened.source };
}

async function validateOwnerMarkerNextResidue(dataDir: string): Promise<void> {
  const nextPath = path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER_NEXT);
  await inspectTypedPrivatePublicationResidue(
    nextPath,
    ([1, 2] as const).map((dataFormat) =>
      Buffer.from(dataDirectoryOwnerMarkerText(dataFormat), "utf8")),
    { label: "owner-marker", maxBytes: MAX_DATA_DIRECTORY_OWNER_MARKER_BYTES },
    (detail, cause) => markerAdoptionError(dataDir, detail, cause)
  );
}

async function readVisibleMarkerSnapshot(dataDir: string): Promise<MarkerSnapshot> {
  const ownerPath = path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER);
  try {
    const snapshot = await readMarkerSnapshot(ownerPath, true);
    if (await pathExists(path.join(dataDir, LEGACY_PREVIEW_DATA_MARKER))) {
      throw markerAdoptionError(
        ownerPath,
        "both current and legacy-preview markers are present"
      );
    }
    return {
      ...snapshot,
      dataFormat: parseDataDirectoryOwnerMarkerBytes(
        snapshot.bytes,
        ownerPath
      ).dataFormat,
      source: "owner-marker"
    };
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }

  const legacyPath = path.join(dataDir, LEGACY_PREVIEW_DATA_MARKER);
  const snapshot = await readMarkerSnapshot(legacyPath, false);
  if (!snapshot.bytes.equals(Buffer.from(LEGACY_PREVIEW_DATA_MARKER_TEXT, "utf8"))) {
    throw markerAdoptionError(legacyPath, "legacy-preview marker bytes differ");
  }
  return { ...snapshot, dataFormat: 1, source: "legacy-preview" };
}

async function readMarkerSnapshot(
  markerPath: string,
  requirePrivate: boolean
): Promise<Pick<MarkerSnapshot, "bytes" | "info">> {
  const policy = { requirePrivate, allowedLinkCounts: [1] } as const;
  let handle: FileHandle | undefined;
  try {
    const pathInfo = await lstat(markerPath);
    requireBoundedRegularFile(
      pathInfo,
      markerPath,
      MAX_DATA_DIRECTORY_OWNER_MARKER_BYTES,
      policy
    );
    handle = await open(markerPath, constants.O_RDONLY | noFollowFlag());
    const before = await handle.stat();
    requireBoundedRegularFile(
      before,
      markerPath,
      MAX_DATA_DIRECTORY_OWNER_MARKER_BYTES,
      policy
    );
    requireSameFileIdentity(pathInfo, before, markerPath);

    const bytes = Buffer.alloc(Number(before.size) + 1);
    let total = 0;
    while (total < bytes.byteLength) {
      const result = await handle.read(bytes, total, bytes.byteLength - total, total);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
    }

    const after = await handle.stat();
    requireBoundedRegularFile(
      after,
      markerPath,
      MAX_DATA_DIRECTORY_OWNER_MARKER_BYTES,
      policy
    );
    if (total !== Number(before.size) || !sameFileSnapshot(before, after)) {
      throw markerAdoptionError(markerPath, "marker changed while being read");
    }
    const finalPathInfo = await lstat(markerPath);
    requireBoundedRegularFile(
      finalPathInfo,
      markerPath,
      MAX_DATA_DIRECTORY_OWNER_MARKER_BYTES,
      policy
    );
    requireSameFileIdentity(after, finalPathInfo, markerPath);
    return { bytes: bytes.subarray(0, total), info: after };
  } catch (error) {
    if (isErrorCode(error, "ENOENT") || error instanceof ServiceError) throw error;
    throw markerAdoptionError(markerPath, "marker is not a stable bounded regular file", error);
  } finally {
    await handle?.close();
  }
}

async function syncRetainedDataDirectory(
  dataDir: string,
  handle: FileHandle
): Promise<void> {
  const before = await requireRetainedDataDirectory(dataDir, handle);
  await handle.sync();
  const after = await requireRetainedDataDirectory(dataDir, handle);
  requireSameFileIdentity(before, after, dataDir);
}

async function requireRetainedDataDirectory(
  dataDir: string,
  handle: FileHandle
): Promise<Stats> {
  const opened = await handle.stat();
  requirePrivateDataDirectory(opened, dataDir);
  const linked = await lstat(dataDir);
  requirePrivateDataDirectory(linked, dataDir);
  requireSameFileIdentity(opened, linked, dataDir);
  return opened;
}

function requirePrivateDataDirectory(info: Stats, dataDir: string): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw markerAdoptionError(dataDir, "retained data directory is not a directory");
  }
  if (process.platform === "win32") return;
  if ((info.mode & 0o777) !== 0o700) {
    throw markerAdoptionError(dataDir, "retained data directory permissions are unsafe");
  }
  if (typeof process.geteuid === "function" && info.uid !== process.geteuid()) {
    throw markerAdoptionError(dataDir, "retained data directory owner is unsafe");
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

import { lstat } from "node:fs/promises";
import path from "node:path";
import {
  assertNfcJsonStrings,
  canonicalJson,
  decodeCanonicalUtf8
} from "./canonical-json.js";
import { readBoundedRegularFile } from "./data-directory-file-read.js";
import { type DataDirectoryFormatReadOptions, requireSupportedDataDirectoryFormat } from "./data-directory-format-compatibility.js";
import { ServiceError } from "./errors.js";
import { parseSettingsStateV2Bytes } from "./settings-v2-codec.js";
import { INITIAL_SETTINGS_STATE_V2_TEXT } from "./settings-v2-default.js";
import { MAX_SETTINGS_STATE_BYTES } from "./settings-v2-scalars.js";
import {
  publishSettingsFile,
  readOptionalMutableSettingsAuthority,
  readOptionalSettingsFile,
  writePrivateSettingsFile
} from "./settings-file-io.js";
import {
  inspectTypedPrivatePublicationResidue,
  privatePublicationScratchPath,
  publishPrivateFileNoReplace,
  readOptionalPrivateFile,
  type PrivateFilePolicy
} from "./private-file-publication.js";
import { closedRecord, closedShape, literal } from "./story-wire-validation.js";
import {
  type DataDirectoryFormat,
  DATA_DIRECTORY_OWNER_MARKER,
  DATA_DIRECTORY_OWNER_MARKER_NEXT,
  LEGACY_PREVIEW_DATA_MARKER,
  LEGACY_PREVIEW_DATA_MARKER_TEXT,
  SETTINGS_STATE_V2_FILE,
  SETTINGS_STATE_V2_NEXT_FILE,
  SETTINGS_STATE_V2_NEXT_SCRATCH
} from "./data-directory-layout.js";

export * from "./data-directory-layout.js";

export const MAX_DATA_DIRECTORY_OWNER_MARKER_BYTES = 4 * 1024;
const OWNER_MARKER_POLICY: PrivateFilePolicy = Object.freeze({
  label: "Data-directory owner marker",
  maxBytes: MAX_DATA_DIRECTORY_OWNER_MARKER_BYTES
});
const CURRENT_OWNER_MARKER_READ_POLICY = Object.freeze({
  requirePrivate: true
});
const OWNER_MARKER_SHAPE = closedShape([
  "product",
  "markerSchema",
  "dataFormat",
  "lockProtocol"
]);

export interface DataDirectoryOwnerMarker {
  readonly product: "1667";
  readonly markerSchema: 1;
  readonly dataFormat: DataDirectoryFormat;
  readonly lockProtocol: 1;
}

export function dataDirectoryOwnerMarkerText(dataFormat: DataDirectoryFormat): string {
  return canonicalJson({
    product: "1667",
    markerSchema: 1,
    dataFormat,
    lockProtocol: 1
  } satisfies DataDirectoryOwnerMarker);
}

/**
 * Strict marker read for services whose caller already owns the external data
 * lock. It performs no mutation and admits format 2 only with valid state.
 */
export async function readDataDirectoryFormat(
  dataDir: string,
  options: DataDirectoryFormatReadOptions = {}
): Promise<DataDirectoryFormat> {
  const ownerMarker = path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER);
  let ownerBytes: Buffer;
  try {
    ownerBytes = await readBoundedRegularFile(
      ownerMarker,
      MAX_DATA_DIRECTORY_OWNER_MARKER_BYTES,
      CURRENT_OWNER_MARKER_READ_POLICY
    );
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) {
      throw invalidMarkerError(ownerMarker, "marker is not a bounded regular file", error);
    }
    const dataFormat = await readLegacyPreviewDataFormat(dataDir, error);
    requireSupportedDataDirectoryFormat(dataFormat, options.supportedFormats);
    return dataFormat;
  }

  if (await pathExists(path.join(dataDir, LEGACY_PREVIEW_DATA_MARKER))) {
    throw invalidMarkerError(ownerMarker, "both current and legacy-preview markers are present");
  }
  const dataFormat = parseDataDirectoryOwnerMarkerBytes(ownerBytes, ownerMarker).dataFormat;
  requireSupportedDataDirectoryFormat(dataFormat, options.supportedFormats);
  if (dataFormat === 2) await validateSettingsStateV2(dataDir);
  return dataFormat;
}

export async function hasDataDirectoryFormatMarker(dataDir: string): Promise<boolean> {
  try {
    await readDataDirectoryFormat(dataDir);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

export async function writeInitialDataDirectoryFormat(
  dataDir: string,
  dataFormat: DataDirectoryFormat
): Promise<void> {
  if (dataFormat === 2) {
    await resumeInitialSettingsStateV2(dataDir);
  } else {
    await requireInitialSettingsPathsAbsent(dataDir);
  }

  await publishDataDirectoryOwnerMarker(dataDir, dataFormat);
}

export function parseDataDirectoryOwnerMarkerBytes(
  bytes: Uint8Array,
  markerPath = DATA_DIRECTORY_OWNER_MARKER
): DataDirectoryOwnerMarker {
  if (bytes.byteLength > MAX_DATA_DIRECTORY_OWNER_MARKER_BYTES) {
    throw invalidMarkerError(markerPath, `marker exceeds ${MAX_DATA_DIRECTORY_OWNER_MARKER_BYTES} bytes`);
  }
  try {
    const text = decodeCanonicalUtf8(bytes, "data-directory owner marker");
    const value = JSON.parse(text) as unknown;
    const marker = closedRecord(value, "data-directory owner marker", OWNER_MARKER_SHAPE);
    literal(marker.product, "1667", "data-directory owner marker.product");
    literal(marker.markerSchema, 1, "data-directory owner marker.markerSchema");
    literal(marker.lockProtocol, 1, "data-directory owner marker.lockProtocol");
    if (marker.dataFormat !== 1 && marker.dataFormat !== 2) {
      throw new Error("data-directory owner marker.dataFormat must be 1 or 2");
    }
    assertNfcJsonStrings(value, "data-directory owner marker");
    if (canonicalJson(value) !== text) {
      throw new Error("data-directory owner marker must be canonical JSON");
    }
    return {
      product: "1667",
      markerSchema: 1,
      dataFormat: marker.dataFormat,
      lockProtocol: 1
    };
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw invalidMarkerError(markerPath, "marker is not the exact supported canonical record", error);
  }
}

async function readLegacyPreviewDataFormat(dataDir: string, ownerMissingError: unknown): Promise<1> {
  const legacyMarker = path.join(dataDir, LEGACY_PREVIEW_DATA_MARKER);
  let bytes: Buffer;
  try {
    bytes = await readBoundedRegularFile(legacyMarker, MAX_DATA_DIRECTORY_OWNER_MARKER_BYTES);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) throw ownerMissingError;
    throw invalidMarkerError(legacyMarker, "legacy-preview marker is not a bounded regular file", error);
  }
  try {
    if (decodeCanonicalUtf8(bytes, "legacy-preview data marker") !== LEGACY_PREVIEW_DATA_MARKER_TEXT) {
      throw new Error("legacy-preview marker bytes differ");
    }
  } catch (error) {
    throw invalidMarkerError(legacyMarker, "legacy-preview marker is invalid", error);
  }
  return 1;
}

async function validateSettingsStateV2(dataDir: string): Promise<void> {
  const statePath = path.join(dataDir, SETTINGS_STATE_V2_FILE);
  try {
    const bytes = await readOptionalMutableSettingsAuthority(
      statePath,
      MAX_SETTINGS_STATE_BYTES
    );
    if (bytes === null) throw new Error("Format-2 settings state is missing");
    parseSettingsStateV2Bytes(bytes);
  } catch (error) {
    const failure = new ServiceError(
      500,
      `1667 format-2 settings state is missing or invalid: ${statePath}`
    );
    failure.cause = error;
    throw failure;
  }
}

/**
 * Publish only the owner marker, resuming an interrupted attempt. Adoption uses
 * this to carry a legacy directory's format across without letting the
 * initializer touch the settings state it just moved.
 */
export async function publishDataDirectoryOwnerMarker(
  dataDir: string,
  dataFormat: DataDirectoryFormat
): Promise<void> {
  const nextPath = path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER_NEXT);
  const markerPath = path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER);
  const expected = Buffer.from(dataDirectoryOwnerMarkerText(dataFormat), "utf8");

  let nextBytes = await readOptionalPrivateFile(nextPath, OWNER_MARKER_POLICY);
  if (nextBytes === null) {
    await publishPrivateFileNoReplace(nextPath, expected, OWNER_MARKER_POLICY);
    nextBytes = expected;
  }
  requireExactOwnerMarkerBytes(nextBytes, nextPath, dataFormat);

  // The complete private `.next` is non-authoritative until this rename and
  // directory barrier. A crash before either point remains resumable.
  await publishSettingsFile(nextPath, markerPath);
}

async function resumeInitialSettingsStateV2(dataDir: string): Promise<void> {
  const residue = await inspectInitialSettingsStateV2(dataDir);
  if (residue === "final") return;

  const bytes = Buffer.from(INITIAL_SETTINGS_STATE_V2_TEXT, "utf8");
  const nextPath = path.join(dataDir, SETTINGS_STATE_V2_NEXT_FILE);
  const finalPath = path.join(dataDir, SETTINGS_STATE_V2_FILE);
  const recoveredNext = await readOptionalSettingsFile(
    nextPath,
    MAX_SETTINGS_STATE_BYTES
  );
  if (recoveredNext === null) {
    await writePrivateSettingsFile(nextPath, bytes);
  } else {
    requireExactInitialSettingsStateBytes(recoveredNext, nextPath);
  }

  // A failed directory barrier after rename leaves an exact canonical final
  // file. Preserve that evidence: the next initializer can validate it under
  // the OS-locked initialization fence and finish publishing the marker.
  await publishSettingsFile(nextPath, finalPath);
}

type InitialSettingsStateResidue = "none" | "scratch" | "next" | "final";

async function inspectInitialSettingsStateV2(
  dataDir: string
): Promise<InitialSettingsStateResidue> {
  const nextPath = path.join(dataDir, SETTINGS_STATE_V2_NEXT_FILE);
  const finalPath = path.join(dataDir, SETTINGS_STATE_V2_FILE);
  const scratchPath = path.join(dataDir, SETTINGS_STATE_V2_NEXT_SCRATCH);
  const expected = Buffer.from(INITIAL_SETTINGS_STATE_V2_TEXT, "utf8");
  const [nextResidue, finalPresent] = await Promise.all([
    inspectTypedPublicationResidue(
      nextPath,
      scratchPath,
      expected,
      MAX_SETTINGS_STATE_BYTES,
      "settings-state"
    ),
    requireExactInitialSettingsStateOrAbsent(finalPath)
  ]);
  if (finalPresent && nextResidue !== "none") {
    throw initializationResidueError(
      dataDir,
      "both pre-publication and final settings state residue are present"
    );
  }
  return finalPresent ? "final" : nextResidue;
}

async function requireExactInitialSettingsStateOrAbsent(file: string): Promise<boolean> {
  let bytes: Buffer;
  try {
    bytes = await readBoundedRegularFile(file, MAX_SETTINGS_STATE_BYTES, {
      requirePrivate: true
    });
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw initializationResidueError(
      path.dirname(file),
      `${path.basename(file)} is not a safe bounded regular file`,
      error
    );
  }
  try {
    requireExactInitialSettingsStateBytes(bytes, file);
  } catch (error) {
    throw initializationResidueError(
      path.dirname(file),
      `${path.basename(file)} is not the exact canonical initial settings state`,
      error
    );
  }
  return true;
}

function requireExactInitialSettingsStateBytes(bytes: Buffer, file: string): void {
  parseSettingsStateV2Bytes(bytes);
  if (!bytes.equals(Buffer.from(INITIAL_SETTINGS_STATE_V2_TEXT, "utf8"))) {
    throw new Error(`${file} differs from the canonical initial settings state`);
  }
}

function requireExactOwnerMarkerBytes(
  bytes: Buffer,
  file: string,
  dataFormat: DataDirectoryFormat
): void {
  const marker = parseDataDirectoryOwnerMarkerBytes(bytes, file);
  if (
    marker.dataFormat !== dataFormat
    || !bytes.equals(Buffer.from(dataDirectoryOwnerMarkerText(dataFormat), "utf8"))
  ) {
    throw initializationResidueError(
      path.dirname(file),
      `${path.basename(file)} is not the expected canonical owner marker`
    );
  }
}

type TypedPublicationResidue = "none" | "scratch" | "next";

/**
 * Recognize only scratch states emitted by private no-replace publication:
 * a prefix scratch, an exact next, their linked publication pair, or an exact
 * next plus a distinct complete scratch awaiting cleanup.
 */
async function inspectTypedPublicationResidue(
  nextPath: string,
  scratchPath: string,
  expected: Buffer,
  maxBytes: number,
  label: string
): Promise<TypedPublicationResidue> {
  if (scratchPath !== privatePublicationScratchPath(nextPath)) {
    throw new Error(`${label} scratch path does not match its next path`);
  }
  const residue = await inspectTypedPrivatePublicationResidue(
    nextPath,
    [expected],
    { label, maxBytes },
    (detail, cause) =>
      initializationResidueError(path.dirname(nextPath), detail, cause)
  );
  return residue === "published" ? "next" : residue;
}

async function requireInitialSettingsPathsAbsent(dataDir: string): Promise<void> {
  await requirePathAbsent(path.join(dataDir, SETTINGS_STATE_V2_NEXT_FILE));
  await requirePathAbsent(path.join(dataDir, SETTINGS_STATE_V2_NEXT_SCRATCH));
  await requirePathAbsent(path.join(dataDir, SETTINGS_STATE_V2_FILE));
}

async function requirePathAbsent(file: string): Promise<void> {
  if (await pathExists(file)) {
    throw initializationResidueError(
      path.dirname(file),
      `unexpected reserved path is present: ${path.basename(file)}`
    );
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

function invalidMarkerError(markerPath: string, detail: string, cause?: unknown): ServiceError {
  const failure = new ServiceError(
    500,
    `1667 data marker is invalid: ${markerPath} (${detail})`
  );
  if (cause !== undefined) failure.cause = cause;
  return failure;
}

function initializationResidueError(
  dataDir: string,
  detail: string,
  cause?: unknown
): ServiceError {
  const failure = new ServiceError(
    500,
    `1667 data initialization residue is invalid: ${dataDir} (${detail})`
  );
  if (cause !== undefined) failure.cause = cause;
  return failure;
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

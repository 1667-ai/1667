import path from "node:path";
import {
  dataDirectoryOwnerMarkerText,
  MAX_DATA_DIRECTORY_OWNER_MARKER_BYTES,
  parseDataDirectoryOwnerMarkerBytes,
  readDataDirectoryFormat
} from "./data-directory-format.js";
import {
  DATA_DIRECTORY_OWNER_MARKER,
  DATA_DIRECTORY_OWNER_MARKER_NEXT
} from "./data-directory-layout.js";
import { publishSettingsFile } from "./settings-file-io.js";
import {
  publishPrivateFileNoReplace,
  readOptionalPrivateFile,
  type PrivateFilePolicy
} from "./private-file-publication.js";

const FORMAT_TWO_MARKER = Buffer.from(dataDirectoryOwnerMarkerText(2), "utf8");
const MARKER_POLICY: PrivateFilePolicy = Object.freeze({
  label: "Data-directory owner marker upgrade",
  maxBytes: MAX_DATA_DIRECTORY_OWNER_MARKER_BYTES
});

/** Durably stage, but never activate, the exact format-2 owner marker. */
export async function stageDataDirectoryFormat2Marker(dataDir: string): Promise<void> {
  const current = await readDataDirectoryFormat(dataDir);
  if (current !== 1) {
    throw new Error(`Settings migration requires data format 1, found ${current}`);
  }
  const nextPath = path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER_NEXT);
  const existing = await readOptionalPrivateFile(nextPath, MARKER_POLICY);
  if (existing === null) {
    await publishPrivateFileNoReplace(nextPath, FORMAT_TWO_MARKER, MARKER_POLICY);
    return;
  }
  requireFormatTwoMarker(existing, nextPath);
}

/** Marker replacement is Release B's activation point and always happens last. */
export async function publishDataDirectoryFormat2Marker(dataDir: string): Promise<void> {
  const nextPath = path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER_NEXT);
  const markerPath = path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER);
  const next = await readOptionalPrivateFile(nextPath, MARKER_POLICY);
  if (next === null) throw new Error("Format-2 owner marker upgrade is not staged");
  requireFormatTwoMarker(next, nextPath);
  await publishSettingsFile(nextPath, markerPath);
  if (await readDataDirectoryFormat(dataDir) !== 2) {
    throw new Error("Format-2 owner marker activation could not be verified");
  }
}

function requireFormatTwoMarker(bytes: Uint8Array, file: string): void {
  const marker = parseDataDirectoryOwnerMarkerBytes(bytes, file);
  if (marker.dataFormat !== 2 || !Buffer.from(bytes).equals(FORMAT_TWO_MARKER)) {
    throw new Error(`${file} is not the exact format-2 owner marker`);
  }
}

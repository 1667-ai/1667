import { rename } from "node:fs/promises";
import path from "node:path";
import { readBoundedMutableAuthorityFile } from "./data-directory-file-read.js";
import {
  inspectPrivateDirectory,
  publishPrivateFileNoReplace,
  readOptionalPrivateFile,
  removePrivateFile
} from "./private-file-publication.js";
import { MAX_SETTINGS_STATE_BYTES } from "./settings-v2-scalars.js";
import { syncDirectory } from "./story-lifecycle.js";

const SETTINGS_FILE_LABEL = "Reserved settings file";

/** Read one reserved settings file through a no-follow handle. */
export async function readOptionalSettingsFile(
  file: string,
  maxBytes: number,
  options: { readonly allowLegacyReadMode?: boolean } = {}
): Promise<Buffer | null> {
  return await readOptionalPrivateFile(file, {
    label: SETTINGS_FILE_LABEL,
    maxBytes,
    allowLegacyReadMode: options.allowLegacyReadMode
  });
}

/** Read the replace-in-place format-2 authority as one stable opened snapshot. */
export async function readOptionalMutableSettingsAuthority(
  file: string,
  maxBytes: number
): Promise<Buffer | null> {
  try {
    await inspectPrivateDirectory(path.dirname(file), SETTINGS_FILE_LABEL);
    return await readBoundedMutableAuthorityFile(file, maxBytes, {
      requirePrivate: true
    });
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

/** Durably publish one complete reserved replacement without overwriting it. */
export async function writePrivateSettingsFile(
  file: string,
  bytes: Uint8Array
): Promise<void> {
  await publishPrivateFileNoReplace(file, bytes, {
    label: SETTINGS_FILE_LABEL,
    maxBytes: MAX_SETTINGS_STATE_BYTES
  });
}

/** Publish an already-fsynced reserved replacement and flush its directory. */
export async function publishSettingsFile(nextFile: string, finalFile: string): Promise<void> {
  await rename(nextFile, finalFile);
  await syncDirectory(path.dirname(finalFile));
}

export async function removeSettingsFile(
  file: string,
  options: { readonly allowLegacyReadMode?: boolean } = {}
): Promise<void> {
  await removePrivateFile(file, {
    label: SETTINGS_FILE_LABEL,
    maxBytes: MAX_SETTINGS_STATE_BYTES,
    allowLegacyReadMode: options.allowLegacyReadMode
  });
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

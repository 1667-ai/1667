import { rename } from "node:fs/promises";
import path from "node:path";
import { readBoundedMutableAuthorityFile } from "./data-directory-file-read.js";
import {
  inspectPrivateDirectory,
  publishPrivateFileNoReplace,
  readOptionalPrivateFile,
  removePrivateFile
} from "./private-file-publication.js";
import { withReservedPathOwnership } from "./reserved-path-owner.js";
import { MAX_SETTINGS_STATE_V5_BYTES } from "../shared/settings-v5-limits.js";
import { syncDirectory } from "./story-lifecycle.js";

const SETTINGS_FILE_LABEL = "Reserved settings file";
const WINDOWS_REPLACE_ATTEMPTS = 200;
const WINDOWS_REPLACE_RETRY_MS = 10;

export interface SettingsPublicationOptions {
  readonly waitForWindowsContention?: (
    attempt: number
  ) => Promise<void>;
}

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
    return await withReservedPathOwnership(file, async () => {
      await inspectPrivateDirectory(path.dirname(file), SETTINGS_FILE_LABEL);
      return await readBoundedMutableAuthorityFile(file, maxBytes, {
        requirePrivate: true
      });
    });
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

/** Durably publish one complete reserved replacement without overwriting it. */
export async function writePrivateSettingsFile(
  file: string,
  bytes: Uint8Array,
  maxBytes: number = MAX_SETTINGS_STATE_V5_BYTES
): Promise<void> {
  await publishPrivateFileNoReplace(file, bytes, {
    label: SETTINGS_FILE_LABEL,
    maxBytes
  });
}

/** Publish an already-fsynced reserved replacement and flush its directory. */
export async function publishSettingsFile(
  nextFile: string,
  finalFile: string,
  options: SettingsPublicationOptions = {}
): Promise<void> {
  await withReservedPathOwnership(finalFile, async () => {
    await renameSettingsFile(nextFile, finalFile, options);
    await syncDirectory(path.dirname(finalFile));
  });
}

async function renameSettingsFile(
  nextFile: string,
  finalFile: string,
  options: SettingsPublicationOptions
): Promise<void> {
  for (let attempt = 0; attempt < WINDOWS_REPLACE_ATTEMPTS; attempt += 1) {
    try {
      await rename(nextFile, finalFile);
      return;
    } catch (error) {
      if (process.platform !== "win32"
        || !isWindowsReplaceContention(error)
        || attempt + 1 === WINDOWS_REPLACE_ATTEMPTS) {
        throw error;
      }
      if (options.waitForWindowsContention !== undefined) {
        await options.waitForWindowsContention(attempt + 1);
      } else {
        await new Promise((resolve) =>
          setTimeout(resolve, WINDOWS_REPLACE_RETRY_MS));
      }
    }
  }
}

export async function removeSettingsFile(
  file: string,
  options: { readonly allowLegacyReadMode?: boolean } = {}
): Promise<void> {
  await removePrivateFile(file, {
    label: SETTINGS_FILE_LABEL,
    maxBytes: MAX_SETTINGS_STATE_V5_BYTES,
    allowLegacyReadMode: options.allowLegacyReadMode
  });
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isWindowsReplaceContention(error: unknown): boolean {
  return isErrorCode(error, "EPERM") || isErrorCode(error, "EACCES");
}

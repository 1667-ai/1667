import { rename } from "node:fs/promises";
import path from "node:path";
import {
  publishPrivateFileNoReplace,
  readOptionalPrivateFile,
  removePrivateFile,
  syncPrivateDirectory,
  type PrivateFilePolicy
} from "./private-file-publication.js";

const NEXT_SUFFIX = ".1667-replace-v1.next";
const WINDOWS_REPLACE_ATTEMPTS = 200;
const WINDOWS_REPLACE_RETRY_MS = 10;

/** Recover an unpublished replacement. The linked authority always wins. */
export async function recoverPrivateFileReplacement(
  file: string,
  policy: PrivateFilePolicy
): Promise<void> {
  const next = replacementPath(file);
  const nextBytes = await readOptionalPrivateFile(next, policy);
  if (nextBytes === null) return;
  await readOptionalPrivateFile(file, policy);
  await removePrivateFile(next, policy);
}

/** Atomically replace or create one complete private file. */
export async function replacePrivateFile(
  file: string,
  bytes: Uint8Array,
  policy: PrivateFilePolicy
): Promise<void> {
  await recoverPrivateFileReplacement(file, policy);
  const next = replacementPath(file);
  await publishPrivateFileNoReplace(next, bytes, policy);
  await renamePrivateFile(next, file);
  await syncPrivateDirectory(path.dirname(file), policy.label);
  if (await readOptionalPrivateFile(file, policy) === null) {
    throw new Error(`${policy.label} replacement is absent: ${file}`);
  }
}

/** Remove the authority and any unpublished replacement. */
export async function removePrivateFileWithReplacement(
  file: string,
  policy: PrivateFilePolicy
): Promise<void> {
  await recoverPrivateFileReplacement(file, policy);
  await removePrivateFile(file, policy);
}

function replacementPath(file: string): string {
  return `${file}${NEXT_SUFFIX}`;
}

async function renamePrivateFile(
  source: string,
  destination: string
): Promise<void> {
  for (let attempt = 0; attempt < WINDOWS_REPLACE_ATTEMPTS; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (process.platform !== "win32"
        || !isWindowsReplaceContention(error)
        || attempt + 1 === WINDOWS_REPLACE_ATTEMPTS) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, WINDOWS_REPLACE_RETRY_MS));
    }
  }
}

function isWindowsReplaceContention(error: unknown): boolean {
  return isErrorCode(error, "EPERM") || isErrorCode(error, "EACCES");
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

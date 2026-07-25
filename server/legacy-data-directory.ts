import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { DATA_DIRECTORY_MIGRATION_EXCLUDED_ENTRY_NAMES } from "./data-directory-layout.js";

declare const VALIDATED_LEGACY_V1: unique symbol;
export interface ValidatedLegacyV1DataDirectory {
  readonly dataDir: string;
  readonly dataFormat: 1;
  readonly [VALIDATED_LEGACY_V1]: true;
}

export async function validateLegacyServeDataDirectory(
  dataDirInput: string
): Promise<ValidatedLegacyV1DataDirectory> {
  const dataDir = path.resolve(dataDirInput);
  let info;
  try {
    info = await lstat(dataDir);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      throw new Error("Legacy serve requires an existing nonempty data directory");
    }
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Legacy serve data must be a real directory");
  }
  const canonical = await realpath(dataDir);
  if (canonical !== dataDir) {
    throw new Error("Legacy serve data directory must be canonical and must not use symlinks");
  }
  const entries = await readdir(canonical);
  if (entries.length === 0) {
    throw new Error("Legacy serve refuses an empty data directory");
  }
  const reserved = new Set<string>(DATA_DIRECTORY_MIGRATION_EXCLUDED_ENTRY_NAMES);
  const collision = entries.find((entry) => reserved.has(entry));
  if (collision !== undefined) {
    throw new Error(`Legacy serve refuses reserved ownership path ${collision}`);
  }
  const storiesPath = path.join(canonical, "stories");
  const stories = await lstat(storiesPath).catch((error: unknown) => {
    if (isErrorCode(error, "ENOENT")) {
      throw new Error("Legacy serve requires a recognized v1 data directory with a stories directory");
    }
    throw error;
  });
  if (!stories.isDirectory() || stories.isSymbolicLink()) {
    throw new Error("Legacy serve requires stories to be a real directory");
  }
  return Object.freeze({
    dataDir: canonical,
    dataFormat: 1
  }) as ValidatedLegacyV1DataDirectory;
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

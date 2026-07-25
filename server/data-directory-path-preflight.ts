import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { ServiceError } from "./errors.js";

/** Reject path indirection before hardened packaged admission can mutate it. */
export async function assertNoSymbolicDirectoryComponents(
  target: string
): Promise<void> {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep)) {
    if (component.length === 0) continue;
    cursor = path.join(cursor, component);
    let info: Stats;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new ServiceError(
        422,
        `1667 data paths cannot traverse symbolic links: ${cursor}`,
        "unprocessable"
      );
    }
    if (!info.isDirectory()) {
      throw new ServiceError(
        422,
        `1667 data path component is not a directory: ${cursor}`,
        "unprocessable"
      );
    }
  }
}

export async function requireExistingDataDirectory(
  target: string,
  invalid: (target: string) => Error
): Promise<void> {
  try {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) throw invalid(target);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
    throw new ServiceError(
      409,
      `1667 data directory does not exist: ${target}. `
        + "Use --initialize-new --offline-exclusive for an absent target.",
      "data_directory_unowned"
    );
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

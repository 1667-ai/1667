import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { PROVIDER_SECRET_VALUE_ENTRY_NAMES } from "./data-directory-layout.js";
import { ServiceError } from "./errors.js";

/**
 * ADR007: a plaintext key must never sit in a folder the user may commit or
 * sync. The project tier is one; the machine tier is not, so a project tier
 * that *is* the machine tier has nothing to refuse.
 */
export async function assertNoProjectTierSecrets(
  projectDir: string,
  machineDir: string
): Promise<void> {
  if (await sameDirectory(projectDir, machineDir)) return;
  for (const entry of PROVIDER_SECRET_VALUE_ENTRY_NAMES) {
    const file = path.join(projectDir, entry);
    if (!await exists(file)) continue;
    throw new ServiceError(
      409,
      `1667 refuses to open a project holding a provider secret file: ${file}. `
        + `Move it into the machine tier at ${path.join(machineDir, entry)}, `
        + "then start again; the project was left untouched.",
      "data_directory_unowned"
    );
  }
}

async function sameDirectory(left: string, right: string): Promise<boolean> {
  const [canonicalLeft, canonicalRight] = await Promise.all([
    canonicalize(left),
    canonicalize(right)
  ]);
  return canonicalLeft === canonicalRight;
}

async function canonicalize(directory: string): Promise<string> {
  try {
    return await realpath(directory);
  } catch {
    return path.resolve(directory);
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

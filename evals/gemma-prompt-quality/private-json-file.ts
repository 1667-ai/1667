import { randomBytes } from "node:crypto";
import { open, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

const TEMPORARY_FILE_ATTEMPTS = 10;

/** Write JSON only after the target file has private owner permissions. */
export async function writePrivateJson(pathname: string, value: unknown): Promise<void> {
  const { temporaryPath, file } = await openPrivateTemporaryFile(pathname);
  try {
    try {
      await file.chmod(0o600);
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    } finally {
      await file.close();
    }
    await rename(temporaryPath, pathname);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function openPrivateTemporaryFile(pathname: string): Promise<{
  readonly temporaryPath: string;
  readonly file: FileHandle;
}> {
  const directory = dirname(pathname);
  for (let attempt = 0; attempt < TEMPORARY_FILE_ATTEMPTS; attempt += 1) {
    const candidate = join(directory, `.1667-private-json-${randomBytes(16).toString("hex")}.tmp`);
    try {
      return { temporaryPath: candidate, file: await open(candidate, "wx", 0o600) };
    } catch (error: unknown) {
      if (isExistingFileError(error)) continue;
      throw error;
    }
  }
  throw new Error("Could not create a private temporary JSON file");
}

function isExistingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && "code" in error && error.code === "EEXIST";
}

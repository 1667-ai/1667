import { fileURLToPath } from "node:url";
import path from "node:path";
import { AI_1667_BUILD_IDENTITY } from "../shared/build-identity.js";
import { resolvePlatformDataDirectory } from "./platform-data-directory.js";

export const REPOSITORY_ROOT = moduleRepositoryRoot();

/** Resolve configuration independently of the entrypoint's current working directory. */
export function resolveDataDirectory(configured = process.env.AI_1667_DATA): string {
  return resolvePlatformDataDirectory({
    ...(configured === undefined ? {} : { configured }),
    packaged: AI_1667_BUILD_IDENTITY.artifactTarget !== "source",
    cwd: REPOSITORY_ROOT
  });
}

function moduleRepositoryRoot(): string {
  try {
    return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  } catch (error) {
    if (process.platform !== "win32"
      || process.versions.bun === undefined) {
      throw error;
    }
    return process.cwd();
  }
}

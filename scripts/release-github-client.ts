import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { isExecutableFile } from "./release-boundary-validation.js";

const execFileAsync = promisify(execFile);
const MAX_GH_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface GitHubReleaseEnvironment {
  readonly GITHUB_REPOSITORY?: string;
  readonly RELEASE_GH_PATH?: string;
  readonly GH_TOKEN?: string;
  readonly HOME?: string;
}

export async function runReleaseGh(
  gh: string,
  args: readonly string[],
  environment: GitHubReleaseEnvironment
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return await execFileAsync(gh, [...args], {
    encoding: "utf8",
    env: {
      GH_TOKEN: environment.GH_TOKEN,
      HOME: environment.HOME,
      LANG: "C",
      LC_ALL: "C"
    },
    maxBuffer: MAX_GH_OUTPUT_BYTES,
    timeout: 5 * 60_000,
    windowsHide: true
  });
}

export function boundedGhExecutable(value: string): string {
  if (!path.isAbsolute(value)) throw new Error("GitHub CLI path must be absolute");
  const requested = lstatSync(value);
  if (!requested.isFile() || requested.isSymbolicLink()) {
    throw new Error("GitHub CLI must be an executable regular file");
  }
  const file = realpathSync(value);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0
    || !isExecutableFile(file, stat.mode)) {
    throw new Error("GitHub CLI must be an executable regular file");
  }
  return file;
}

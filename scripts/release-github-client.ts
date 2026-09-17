import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { isExecutableFile } from "./release-boundary-validation.js";

const execFileAsync = promisify(execFile);
const MAX_GH_OUTPUT_BYTES = 8 * 1024 * 1024;
const GH_TIMEOUT_MS = 5 * 60_000;
/** The ceiling a caller may raise `timeoutMs` to. Release asset transfers
 *  move more than a gigabyte in one command, which took 78 seconds on one
 *  runner and more than the 5-minute default on another, so they need their
 *  own deadline; every metadata call keeps the default. */
export const MAX_GH_ASSET_TIMEOUT_MS = 25 * 60_000;

export interface GitHubReleaseEnvironment {
  readonly GITHUB_REPOSITORY?: string;
  readonly RELEASE_GH_PATH?: string;
  readonly GH_TOKEN?: string;
  readonly HOME?: string;
}

export interface ReleaseGhLimits {
  readonly maximumOutputBytes?: number;
  readonly timeoutMs?: number;
}

export async function runReleaseGh(
  gh: string,
  args: readonly string[],
  environment: GitHubReleaseEnvironment,
  limits: ReleaseGhLimits = {}
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const maximumOutputBytes = limits.maximumOutputBytes ?? MAX_GH_OUTPUT_BYTES;
  const timeoutMs = limits.timeoutMs ?? GH_TIMEOUT_MS;
  if (!Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes <= 0
    || maximumOutputBytes > MAX_GH_OUTPUT_BYTES) {
    throw new Error("GitHub CLI output limit is invalid");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
    || timeoutMs > MAX_GH_ASSET_TIMEOUT_MS) {
    throw new Error("GitHub CLI timeout is invalid");
  }
  const executable = boundedGhExecutable(gh);
  try {
    return await execFileAsync(executable, [...args], {
      encoding: "utf8",
      env: {
        GH_TOKEN: environment.GH_TOKEN,
        HOME: environment.HOME,
        LANG: "C",
        LC_ALL: "C"
      },
      maxBuffer: maximumOutputBytes,
      timeout: timeoutMs,
      windowsHide: true
    });
  } catch (error) {
    // `execFile` reports only the command line, so a failed release command
    // otherwise gives no reason at all. Keep the command's own message and
    // add what it wrote, bounded, so a release failure is diagnosable.
    throw new Error(ghFailureMessage(error), { cause: error });
  }
}

const MAX_GH_FAILURE_DETAIL = 2000;

function ghFailureMessage(error: unknown): string {
  if (!(error instanceof Error)) return "GitHub CLI failed";
  const detail = error as { readonly stderr?: unknown; readonly signal?: unknown };
  const stderr = typeof detail.stderr === "string" ? detail.stderr.trim() : "";
  const killed = detail.signal === "SIGTERM" ? " (timed out)" : "";
  return stderr === ""
    ? `${error.message}${killed}`
    : `${error.message}${killed}: ${stderr.slice(0, MAX_GH_FAILURE_DETAIL)}`;
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

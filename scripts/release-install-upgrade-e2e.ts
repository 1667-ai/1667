#!/usr/bin/env -S node --import tsx

import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import { isSemVer } from "../shared/semver.js";
import { runInstallUpgradeE2e } from "./release-install-upgrade-e2e-lib.js";
import { StepError } from "./release-install-upgrade-e2e-verify.js";
import {
  terminateActiveCommands,
  type InstallUpgradeE2eOptions
} from "./release-install-upgrade-e2e-process.js";

export const USAGE = `Usage: npm run release:verify-install-upgrade -- --from-version <semver> [--from-channel beta|stable] [--homepage-url <url>] [--current-url <url>] [--previous-url <url>]

Options:
  --from-version <semver>  Previous release version to test upgrade from (required).
  --from-channel <channel> Channel of the previous release: beta or stable (default: beta).
  --homepage-url <url>     Homepage installer script URL (default: https://1667.ai/install.sh).
  --current-url <url>      Canonical GitHub release installer URL for current release.
  --previous-url <url>     Canonical GitHub release installer URL for previous release.
  -h, --help               Show help information.
`;

export type CliArgs = InstallUpgradeE2eOptions;

export type CliParseResult =
  | { kind: "help"; text: string }
  | { kind: "args"; args: CliArgs };

let scratchRootToDelete: string | null = null;

async function cleanupScratch(): Promise<void> {
  // A running installer can still write into the scratch directory, and it can
  // recreate a path this removes. Ending those command groups first keeps the
  // removal final.
  terminateActiveCommands();
  if (scratchRootToDelete !== null) {
    const target = scratchRootToDelete;
    scratchRootToDelete = null;
    await rm(target, { recursive: true, force: true });
  }
}

function registerSignalHandlers(): void {
  const handleSignal = (code: number) => {
    void cleanupScratch().finally(() => {
      process.exit(code);
    });
  };

  process.once("SIGINT", () => handleSignal(130));
  process.once("SIGTERM", () => handleSignal(143));
  process.once("SIGHUP", () => handleSignal(129));
}

export function validateInstallerUrl(rawUrl: string, paramName: string): string {
  if (!rawUrl || typeof rawUrl !== "string") {
    throw new Error(`Error: ${paramName} requires a non-empty URL.`);
  }
  if (/[\s\0-\x1F\x7F'"`\\]/.test(rawUrl)) {
    throw new Error(`Error: ${paramName} contains disallowed control or quote characters.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Error: ${paramName} requires a valid URL.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Error: ${paramName} must not contain credentials.`);
  }
  if (parsed.hash) {
    throw new Error(`Error: ${paramName} must not contain a URL fragment.`);
  }
  if (parsed.search) {
    throw new Error(`Error: ${paramName} must not contain query parameters.`);
  }
  if (parsed.protocol === "https:") {
    return parsed.href;
  }
  if (
    parsed.protocol === "http:" &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1" || parsed.hostname === "[::1]")
  ) {
    return parsed.href;
  }
  throw new Error(`Error: ${paramName} must use HTTPS or loopback HTTP.`);
}

/** Returns the text after the first `=`. Splitting on every `=` would drop a
 *  URL query or a path segment that contains one. */
function inlineValue(arg: string): string {
  return arg.slice(arg.indexOf("=") + 1);
}

export function parseCliArgs(argv: readonly string[]): CliParseResult {
  let fromVersion: string | null = null;
  let fromChannel: "beta" | "stable" = "beta";
  let rawHomepageUrl: string | null = null;
  let rawCurrentUrl: string | null = null;
  let rawPreviousUrl: string | null = null;

  const currentVersion = packageJson.version;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      return { kind: "help", text: USAGE };
    }
    if (arg === "--from-version" || arg.startsWith("--from-version=")) {
      const value = arg.includes("=") ? inlineValue(arg) : argv[++i];
      if (!value || !isSemVer(value)) {
        throw new Error(`Error: --from-version requires a valid semver string.\n\n${USAGE}`);
      }
      fromVersion = value;
    } else if (arg === "--from-channel" || arg.startsWith("--from-channel=")) {
      const value = arg.includes("=") ? inlineValue(arg) : argv[++i];
      if (value !== "beta" && value !== "stable") {
        throw new Error(`Error: --from-channel must be 'beta' or 'stable'.\n\n${USAGE}`);
      }
      fromChannel = value;
    } else if (arg === "--homepage-url" || arg.startsWith("--homepage-url=")) {
      const value = arg.includes("=") ? inlineValue(arg) : argv[++i];
      if (!value) {
        throw new Error(`Error: --homepage-url requires a non-empty URL.\n\n${USAGE}`);
      }
      rawHomepageUrl = value;
    } else if (arg === "--current-url" || arg.startsWith("--current-url=")) {
      const value = arg.includes("=") ? inlineValue(arg) : argv[++i];
      if (!value) {
        throw new Error(`Error: --current-url requires a non-empty URL.\n\n${USAGE}`);
      }
      rawCurrentUrl = value;
    } else if (arg === "--previous-url" || arg.startsWith("--previous-url=")) {
      const value = arg.includes("=") ? inlineValue(arg) : argv[++i];
      if (!value) {
        throw new Error(`Error: --previous-url requires a non-empty URL.\n\n${USAGE}`);
      }
      rawPreviousUrl = value;
    } else {
      throw new Error(`Error: Unknown argument '${arg}'.\n\n${USAGE}`);
    }
  }

  if (fromVersion === null) {
    throw new Error(`Error: Missing required option --from-version.\n\n${USAGE}`);
  }

  const homepageUrl = rawHomepageUrl
    ? validateInstallerUrl(rawHomepageUrl, "--homepage-url")
    : "https://1667.ai/install.sh";

  const currentUrl = rawCurrentUrl
    ? validateInstallerUrl(rawCurrentUrl, "--current-url")
    // The gate verifies a stable release. runInstallUpgradeE2e refuses a
    // prerelease checkout before it downloads anything.
    : `https://github.com/1667-ai/1667/releases/download/v${currentVersion}/install-stable.sh`;

  const previousUrl = rawPreviousUrl
    ? validateInstallerUrl(rawPreviousUrl, "--previous-url")
    : `https://github.com/1667-ai/1667/releases/download/v${fromVersion}/install-${fromChannel}.sh`;

  return {
    kind: "args",
    args: {
      fromVersion,
      fromChannel,
      homepageUrl,
      currentUrl,
      previousUrl
    }
  };
}

async function main(): Promise<void> {
  registerSignalHandlers();

  const scriptArgv = process.argv.slice(2);
  let parseResult: CliParseResult;
  try {
    parseResult = parseCliArgs(scriptArgv);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${msg}\n`);
    process.exitCode = 2;
    return;
  }

  if (parseResult.kind === "help") {
    process.stdout.write(parseResult.text);
    return;
  }

  const baseDir = path.join(homedir(), ".cache", "1667-tests");
  await mkdir(baseDir, { recursive: true, mode: 0o755 });
  await chmod(baseDir, 0o755);
  const realBaseDir = await realpath(baseDir);
  const rawScratchRoot = await mkdtemp(path.join(realBaseDir, "release-e2e-"));
  const scratchRoot = await realpath(rawScratchRoot);
  scratchRootToDelete = scratchRoot;

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    await runInstallUpgradeE2e(parseResult.args, scratchRoot, repoRoot);
  } catch (err: unknown) {
    if (err instanceof StepError) {
      process.stderr.write(`${err.message}\n`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: ${msg}\n`);
    }
    process.exitCode = 1;
  } finally {
    await cleanupScratch();
  }
}

/** Only a direct invocation runs the gate, so a test can import the argument
 *  and URL rules without starting a release verification. */
function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void main();
}

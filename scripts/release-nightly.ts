#!/usr/bin/env -S node --import tsx

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  nightlyReleaseVersion,
  nightlyRunDecision
} from "./release-nightly-version.js";
import { repositoryPackageVersions } from "./release-source-facts.js";

export {
  NIGHTLY_CHANNEL,
  NIGHTLY_RELEASE_TAG,
  type NightlyVersion,
  nightlyReleaseVersion,
  parseNightlyVersion,
  isNightlyVersion,
  type NightlyRunDecision,
  nightlyRunDecision
} from "./release-nightly-version.js";

const USAGE = [
  "usage: release-nightly.ts version <commit> <timestamp>",
  "       release-nightly.ts decide <head-commit> [previous-commit]"
].join("\n");

function runCommand(argv: readonly string[]): void {
  const [command] = argv;
  if (command === "version") {
    if (argv.length !== 3) throw new Error(USAGE);
    const commit = argv[1]!;
    const timestamp = argv[2]!;
    const base = repositoryPackageVersions().root;
    const version = nightlyReleaseVersion(base, timestamp, commit);
    process.stdout.write(`${version}\n`);
    return;
  }
  if (command === "decide") {
    if (argv.length < 2 || argv.length > 3) throw new Error(USAGE);
    const headCommit = argv[1]!;
    const rawPrevious = argv[2];
    const previousCommit = (rawPrevious === undefined || rawPrevious === "") ? null : rawPrevious;
    const decision = nightlyRunDecision(headCommit, previousCommit);
    if (decision.kind === "build") {
      process.stdout.write("build\n");
    } else {
      process.stdout.write(`skip ${decision.reason}\n`);
    }
    return;
  }
  throw new Error(USAGE);
}

function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    runCommand(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release-nightly: ${message}\n`);
    process.exitCode = 1;
  }
}

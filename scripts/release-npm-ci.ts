#!/usr/bin/env -S node --import tsx

import {
  lstatSync,
  readdirSync,
  realpathSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_TAG_REF } from "./release-evidence-inspection.js";
import { runReleaseGh } from "./release-github-client.js";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const RUN_ID = /^[1-9][0-9]*$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SIGNER_WORKFLOW =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u;
const CI_GH_LIMITS = Object.freeze({
  maximumOutputBytes: 1024 * 1024,
  timeoutMs: 2 * 60_000
});

export interface ReleaseCiEnvironment {
  readonly GITHUB_REPOSITORY?: string;
  readonly GITHUB_RUN_ID?: string;
  readonly GITHUB_REF?: string;
  readonly GITHUB_SHA?: string;
  readonly SIGNER_WORKFLOW?: string;
  readonly RELEASE_GH_PATH?: string;
  readonly GH_TOKEN?: string;
  readonly HOME?: string;
}

export async function releaseRunTimestamp(
  environment: ReleaseCiEnvironment,
  ghExecutable = releaseGhExecutable(environment)
): Promise<string> {
  const repository = requiredMatch(
    environment.GITHUB_REPOSITORY,
    REPOSITORY,
    "GITHUB_REPOSITORY"
  );
  const runId = requiredMatch(environment.GITHUB_RUN_ID, RUN_ID, "GITHUB_RUN_ID");
  const { stdout, stderr } = await runReleaseGh(
    ghExecutable,
    ["api", `repos/${repository}/actions/runs/${runId}`, "--jq", ".created_at"],
    environment,
    CI_GH_LIMITS
  );
  if (stderr !== "") throw new Error("GitHub CLI wrote timestamp diagnostics");
  const raw = stdout.trim();
  const milliseconds = Date.parse(raw);
  if (!Number.isFinite(milliseconds)) {
    throw new Error("GitHub Actions run has an invalid creation timestamp");
  }
  return new Date(milliseconds).toISOString();
}

export async function verifyReleaseAttestations(
  directory: string,
  expectedFiles: number,
  environment: ReleaseCiEnvironment,
  ghExecutable = releaseGhExecutable(environment)
): Promise<readonly string[]> {
  if (!Number.isSafeInteger(expectedFiles) || expectedFiles <= 0 || expectedFiles > 100) {
    throw new Error("Expected attestation file count is invalid");
  }
  const repository = requiredMatch(
    environment.GITHUB_REPOSITORY,
    REPOSITORY,
    "GITHUB_REPOSITORY"
  );
  const sourceRef = requiredMatch(environment.GITHUB_REF, RELEASE_TAG_REF, "GITHUB_REF");
  const sourceCommit = requiredMatch(environment.GITHUB_SHA, COMMIT, "GITHUB_SHA");
  const signerWorkflow = requiredMatch(
    environment.SIGNER_WORKFLOW,
    SIGNER_WORKFLOW,
    "SIGNER_WORKFLOW"
  );
  const requestedRoot = path.resolve(directory);
  const rootStat = lstatSync(requestedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Release attestation input must be a real directory");
  }
  const root = realpathSync(requestedRoot);
  const files = releaseInputFiles(root);
  if (files.length !== expectedFiles) {
    throw new Error(
      `Release input holds ${files.length} files, expected ${expectedFiles}`
    );
  }
  for (const file of files) {
    await runReleaseGh(ghExecutable, [
      "attestation",
      "verify",
      file,
      "--repo",
      repository,
      "--signer-workflow",
      signerWorkflow,
      "--source-ref",
      sourceRef,
      "--source-digest",
      sourceCommit,
      "--deny-self-hosted-runners"
    ], environment, CI_GH_LIMITS);
  }
  return Object.freeze(files);
}

function releaseGhExecutable(environment: ReleaseCiEnvironment): string {
  if (environment.RELEASE_GH_PATH === undefined) {
    throw new Error("RELEASE_GH_PATH is required");
  }
  return environment.RELEASE_GH_PATH;
}

function releaseInputFiles(root: string): readonly string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Release input ${candidate} is a symbolic link`);
      }
      if (entry.isDirectory()) {
        visit(candidate);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Release input ${candidate} is not a file`);
      const stat = lstatSync(candidate);
      if (stat.size <= 0) throw new Error(`Release input ${candidate} is empty`);
      files.push(candidate);
    }
  };
  visit(root);
  files.sort();
  return Object.freeze(files);
}

function requiredMatch(
  value: string | undefined,
  pattern: RegExp,
  name: string
): string {
  if (value === undefined || !pattern.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
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
    const [command, argument, countInput] = process.argv.slice(2);
    if (command === "timestamp" && process.argv.length === 3) {
      process.stdout.write(`${await releaseRunTimestamp(process.env)}\n`);
    } else if (command === "verify-attestations" && process.argv.length === 5
      && argument !== undefined && countInput !== undefined) {
      const files = await verifyReleaseAttestations(
        argument,
        Number(countInput),
        process.env
      );
      process.stdout.write(`verified ${files.length} release attestations\n`);
    } else {
      throw new Error(
        "usage: release-npm-ci.ts timestamp"
        + " | release-npm-ci.ts verify-attestations <directory> <count>"
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release-npm-ci: ${message}\n`);
    process.exitCode = 1;
  }
}

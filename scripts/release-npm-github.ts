#!/usr/bin/env -S node --import tsx

import { execFile } from "node:child_process";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isSemVer } from "../shared/semver.js";
import { PUBLISHED_ARTIFACT_TARGETS } from "../shared/release-targets.js";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import {
  directoryAssetDigests,
  formatReleaseChecksums
} from "./release-github-assets.js";

const execFileAsync = promisify(execFile);
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const MAX_GH_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_NOTES_BYTES = 64 * 1024;
const FIXED_ASSETS = Object.freeze([
  "artifact-manifest.json",
  "artifact-manifest.sha256",
  "checksums.txt"
]);
const SBOM_ASSETS = Object.freeze([
  "launcher",
  ...PUBLISHED_ARTIFACT_TARGETS
].map((target) => `${target}.spdx.json`));

export interface GitHubReleaseEnvironment {
  readonly GITHUB_REPOSITORY?: string;
  readonly RELEASE_GH_PATH?: string;
  readonly GH_TOKEN?: string;
  readonly HOME?: string;
}

export interface PublishGitHubReleaseOptions {
  readonly version: string;
  readonly assetsDirectory: string;
  readonly notesFile: string;
  readonly environment: GitHubReleaseEnvironment;
  readonly ghExecutable?: string;
}

interface ReleaseState {
  readonly isDraft: boolean;
  readonly isImmutable: boolean;
  readonly isPrerelease: boolean;
}

export async function publishOrVerifyGitHubRelease(
  options: PublishGitHubReleaseOptions
): Promise<void> {
  if (!isSemVer(options.version)) throw new Error("GitHub release version is not SemVer");
  const repository = requiredMatch(
    options.environment.GITHUB_REPOSITORY,
    REPOSITORY,
    "GITHUB_REPOSITORY"
  );
  const gh = boundedExecutable(
    options.ghExecutable
      ?? requiredValue(options.environment.RELEASE_GH_PATH, "RELEASE_GH_PATH")
  );
  const assets = verifyNpmReleaseAssetDirectory(options.assetsDirectory);
  const notes = boundedFile(options.notesFile, "GitHub release notes", MAX_NOTES_BYTES);
  const tag = `v${options.version}`;
  let state = await releaseState(gh, tag, repository, options.environment);
  if (state?.isDraft === true) {
    await runGh(gh, ["release", "delete", tag, "--repo", repository, "--yes"], options.environment);
    state = null;
  }
  let created = false;
  if (state === null) {
    await runGh(gh, [
      "release",
      "create",
      tag,
      ...assets,
      "--repo",
      repository,
      "--draft",
      "--verify-tag",
      "--prerelease",
      "--latest=false",
      "--title",
      `1667 v${options.version}`,
      "--notes-file",
      notes
    ], options.environment);
    created = true;
  } else {
    requireImmutablePrerelease(state, "Existing");
  }
  await verifyDownloadedRelease(gh, tag, repository, assets, options.environment);
  if (!created) return;
  await runGh(
    gh,
    ["release", "edit", tag, "--repo", repository, "--draft=false"],
    options.environment
  );
  const published = await releaseState(gh, tag, repository, options.environment);
  if (published === null) throw new Error("Published GitHub release disappeared");
  requireImmutablePrerelease(published, "Published");
  if (published.isDraft) throw new Error("Published GitHub release is still a draft");
}

export function verifyNpmReleaseAssetDirectory(directory: string): readonly string[] {
  const root = realpathSync(directory);
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error("GitHub release assets must be regular files");
  }
  const names = entries.map((entry) => entry.name).sort();
  const tarballs = names.filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 5) throw new Error("GitHub release must contain five npm tarballs");
  const expected = [...FIXED_ASSETS, ...SBOM_ASSETS, ...tarballs].sort();
  if (names.length !== expected.length
    || names.some((name, index) => name !== expected[index])) {
    throw new Error("GitHub release contains an unexpected asset set");
  }
  const checksums = readFileSync(path.join(root, "checksums.txt"), "utf8");
  const regenerated = formatReleaseChecksums(directoryAssetDigests(root));
  if (checksums !== regenerated) throw new Error("GitHub release checksums do not match assets");
  return Object.freeze(names.map((name) => path.join(root, name)));
}

async function verifyDownloadedRelease(
  gh: string,
  tag: string,
  repository: string,
  expectedAssets: readonly string[],
  environment: GitHubReleaseEnvironment
): Promise<void> {
  const scratch = await mkdtemp(path.join(realpathSync(tmpdir()), "1667-npm-release-"));
  try {
    await runGh(
      gh,
      ["release", "download", tag, "--repo", repository, "--dir", scratch],
      environment
    );
    const downloaded = verifyNpmReleaseAssetDirectory(scratch);
    if (downloaded.length !== expectedAssets.length) {
      throw new Error("Downloaded GitHub release has the wrong asset count");
    }
    for (let index = 0; index < downloaded.length; index += 1) {
      const local = expectedAssets[index];
      const remote = downloaded[index];
      if (local === undefined || remote === undefined
        || path.basename(local) !== path.basename(remote)) {
        throw new Error("Downloaded GitHub release differs from the local assets");
      }
    }
    if (readFileSync(path.join(path.dirname(expectedAssets[0]!), "checksums.txt"), "utf8")
      !== readFileSync(path.join(scratch, "checksums.txt"), "utf8")) {
      throw new Error("Downloaded GitHub release differs from the local assets");
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function releaseState(
  gh: string,
  tag: string,
  repository: string,
  environment: GitHubReleaseEnvironment
): Promise<ReleaseState | null> {
  let stdout: string;
  try {
    ({ stdout } = await runGh(gh, [
      "release",
      "view",
      tag,
      "--repo",
      repository,
      "--json",
      "isDraft,isImmutable,isPrerelease"
    ], environment));
  } catch (error) {
    if (isMissingRelease(error)) return null;
    throw error;
  }
  const value = parseJsonRejectingDuplicateKeys(stdout);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub release state is not an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "isDraft,isImmutable,isPrerelease"
    || typeof record.isDraft !== "boolean"
    || typeof record.isImmutable !== "boolean"
    || typeof record.isPrerelease !== "boolean") {
    throw new Error("GitHub release state is invalid");
  }
  return Object.freeze({
    isDraft: record.isDraft,
    isImmutable: record.isImmutable,
    isPrerelease: record.isPrerelease
  });
}

function requireImmutablePrerelease(state: ReleaseState, label: string): void {
  if (state.isDraft || !state.isImmutable || !state.isPrerelease) {
    throw new Error(`${label} GitHub release is not an immutable prerelease`);
  }
}

async function runGh(
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

function isMissingRelease(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const detail = `${error.message}\n${
    String((error as { stdout?: unknown }).stdout ?? "")
  }\n${String((error as { stderr?: unknown }).stderr ?? "")}`;
  return /release not found|HTTP 404/iu.test(detail);
}

function boundedExecutable(value: string): string {
  if (!path.isAbsolute(value)) throw new Error("GitHub CLI path must be absolute");
  const stat = lstatSync(value);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
    throw new Error("GitHub CLI must be an executable regular file");
  }
  return boundedFile(value, "GitHub CLI", Number.MAX_SAFE_INTEGER, true);
}

function boundedFile(
  value: string,
  label: string,
  maximumBytes: number,
  executable = false
): string {
  const requested = lstatSync(value);
  if (!requested.isFile() || requested.isSymbolicLink()) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  const file = realpathSync(value);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maximumBytes
    || (executable && (stat.mode & 0o111) === 0)) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  return file;
}

function requiredMatch(
  value: string | undefined,
  pattern: RegExp,
  name: string
): string {
  if (value === undefined || !pattern.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function requiredValue(value: string | undefined, name: string): string {
  if (value === undefined || value === "") throw new Error(`${name} is required`);
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
    const [version, assetsDirectory, notesFile] = process.argv.slice(2);
    if (process.argv.length !== 5 || version === undefined
      || assetsDirectory === undefined || notesFile === undefined) {
      throw new Error("usage: release-npm-github.ts <version> <assets> <notes>");
    }
    await publishOrVerifyGitHubRelease({
      version,
      assetsDirectory,
      notesFile,
      environment: process.env
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release-npm-github: ${message}\n`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env -S node --import tsx

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
import { isSemVer } from "../shared/semver.js";
import { PUBLISHED_ARTIFACT_TARGETS } from "../shared/release-targets.js";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import { releaseArchiveFileName } from "./release-archive.js";
import {
  boundedGhExecutable,
  runReleaseGh as runGh,
  type GitHubReleaseEnvironment
} from "./release-github-client.js";
import { verifyRemoteReleaseTag } from "./release-github-tag.js";
import {
  directoryAssetDigests,
  formatReleaseChecksums
} from "./release-github-assets.js";
import { renderInstallScriptsForVersion } from "./release-install-script.js";
import {
  expectedGitHubReleaseAssetNames,
  expectedInstallerNames,
  isPrereleaseVersion
} from "./release-publication-assets.js";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const MAX_NOTES_BYTES = 64 * 1024;

export interface GitHubReleaseOptions {
  readonly version: string;
  readonly sourceCommit: string;
  readonly assetsDirectory: string;
  readonly notesFile: string;
  readonly environment: GitHubReleaseEnvironment;
  readonly ghExecutable?: string;
}

interface ReleaseState {
  readonly body: string;
  readonly isDraft: boolean;
  readonly isImmutable: boolean;
  readonly isPrerelease: boolean;
  readonly name: string;
}

export async function publishOrVerifyGitHubRelease(
  options: GitHubReleaseOptions
): Promise<void> {
  const context = releaseContext(options);
  const { gh, prerelease, repository, tag } = context;
  const state = await preparedReleaseState(context);
  if (!state.isDraft) return;
  try {
    await runGh(
      gh,
      ["release", "edit", tag, "--repo", repository, "--draft=false"],
      context.environment
    );
  } catch (error) {
    const observed = await releaseState(gh, tag, repository, context.environment);
    if (observed === null || observed.isDraft || !observed.isImmutable
      || observed.isPrerelease !== prerelease) {
      throw error;
    }
  }
  const published = await preparedReleaseState(context);
  requireImmutableReleaseChannel(published, prerelease, "Published");
}

/** Verifies the prepared draft without changing it. */
export async function verifyPreparedGitHubRelease(
  options: GitHubReleaseOptions
): Promise<void> {
  await preparedReleaseState(releaseContext(options));
}

/** Creates and validates a draft before npm publication starts. */
export async function prepareOrVerifyGitHubRelease(
  options: GitHubReleaseOptions
): Promise<void> {
  const context = releaseContext(options);
  const { assets, gh, notes, prerelease, repository, tag, title, verifyTag } = context;
  const state = await releaseState(gh, tag, repository, context.environment);
  if (state !== null) {
    await preparedReleaseState(context);
    return;
  }
  await verifyTag();
  await runGh(gh, [
    "release",
    "create",
    tag,
    ...assets,
    "--repo",
    repository,
    "--draft",
    "--verify-tag",
    ...(prerelease ? ["--prerelease"] : []),
    "--latest=false",
    "--title",
    title,
    "--notes-file",
    notes
  ], context.environment);
  await preparedReleaseState(context);
}

async function preparedReleaseState(context: ReleaseContext): Promise<ReleaseState> {
  const { assets, environment, gh, prerelease, repository, tag, verifyTag } = context;
  await verifyTag();
  const state = await releaseState(gh, tag, repository, environment);
  if (state === null) throw new Error("Prepared GitHub release does not exist");
  if (state.isDraft) requireDraftReleaseChannel(state, prerelease);
  else requireImmutableReleaseChannel(state, prerelease, "Existing");
  requireReleaseContents(state, context);
  await verifyDownloadedRelease(gh, tag, repository, assets, environment);
  await verifyTag();
  return state;
}

interface ReleaseContext {
  readonly assets: readonly string[];
  readonly environment: GitHubReleaseEnvironment;
  readonly gh: string;
  readonly notes: string;
  readonly notesBody: string;
  readonly prerelease: boolean;
  readonly repository: string;
  readonly tag: string;
  readonly title: string;
  readonly verifyTag: () => Promise<void>;
}

function releaseContext(
  options: GitHubReleaseOptions
): ReleaseContext {
  if (!isSemVer(options.version)) throw new Error("GitHub release version is not SemVer");
  if (!COMMIT.test(options.sourceCommit)) {
    throw new Error("GitHub release source commit is not canonical");
  }
  // The one place this module decides prerelease vs. stable. Every check below
  // reads this value rather than assuming a channel, so a stable version's
  // release is required to be a stable release and a prerelease version's
  // release is required to stay a prerelease, in both directions.
  const prerelease = isPrereleaseVersion(options.version);
  const repository = requiredMatch(
    options.environment.GITHUB_REPOSITORY,
    REPOSITORY,
    "GITHUB_REPOSITORY"
  );
  const gh = boundedGhExecutable(
    options.ghExecutable
      ?? requiredValue(options.environment.RELEASE_GH_PATH, "RELEASE_GH_PATH")
  );
  const assets = verifyNpmReleaseAssetDirectory(
    options.assetsDirectory,
    options.version,
    repository
  );
  const notes = boundedFile(options.notesFile, "GitHub release notes", MAX_NOTES_BYTES);
  const notesBody = readFileSync(notes, "utf8");
  const tag = `v${options.version}`;
  const title = `1667 v${options.version}`;
  const verifyTag = async (): Promise<void> => await verifyRemoteReleaseTag({
    version: options.version,
    sourceCommit: options.sourceCommit,
    environment: options.environment,
    ghExecutable: gh
  });
  return Object.freeze({
    assets,
    environment: options.environment,
    gh,
    notes,
    notesBody,
    prerelease,
    repository,
    tag,
    title,
    verifyTag
  });
}

export function verifyNpmReleaseAssetDirectory(
  directory: string,
  version: string,
  repository: string
): readonly string[] {
  if (!isSemVer(version)) throw new Error("GitHub release version is not SemVer");
  if (!REPOSITORY.test(repository)) {
    throw new Error("GitHub release repository is invalid");
  }
  const root = realpathSync(directory);
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error("GitHub release assets must be regular files");
  }
  const names = entries.map((entry) => entry.name).sort();
  const expected = [...expectedGitHubReleaseAssetNames(version)];
  if (names.length !== expected.length
    || names.some((name, index) => name !== expected[index])) {
    throw new Error("GitHub release contains an unexpected asset set");
  }
  if (isPrereleaseVersion(version) && names.includes("install-stable.sh")) {
    throw new Error("Prerelease GitHub release must not contain install-stable.sh");
  }
  // Keep the explicit installer helper exercised for callers and tests.
  for (const installer of expectedInstallerNames(version)) {
    if (!names.includes(installer)) {
      throw new Error(`GitHub release is missing ${installer}`);
    }
  }
  for (const target of PUBLISHED_ARTIFACT_TARGETS) {
    const archive = releaseArchiveFileName(version, target);
    if (!names.includes(archive)) {
      throw new Error(`GitHub release is missing native archive ${archive}`);
    }
  }
  const assetDigests = directoryAssetDigests(root);
  const digestByName = new Map(assetDigests.map((entry) => [entry.name, entry.sha256]));
  // Bind each installer to digests of the exact native .tar.gz assets only.
  const archiveDigests: Record<string, string> = {};
  for (const target of PUBLISHED_ARTIFACT_TARGETS) {
    const archive = releaseArchiveFileName(version, target);
    const sha256 = digestByName.get(archive);
    if (sha256 === undefined) {
      throw new Error(`GitHub release is missing native archive ${archive}`);
    }
    archiveDigests[archive] = sha256;
  }
  const expectedInstallers = renderInstallScriptsForVersion({
    version,
    repository,
    digests: archiveDigests
  });
  for (const installer of expectedInstallerNames(version)) {
    const expectedBody = expectedInstallers[installer];
    if (expectedBody === undefined) {
      throw new Error(`GitHub release is missing deterministic installer ${installer}`);
    }
    const actual = readFileSync(path.join(root, installer));
    if (!actual.equals(Buffer.from(expectedBody, "utf8"))) {
      throw new Error(
        `GitHub release installer ${installer} does not match deterministic channel contents`
      );
    }
  }
  const checksums = readFileSync(path.join(root, "checksums.txt"), "utf8");
  const regenerated = formatReleaseChecksums(assetDigests);
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
    const downloaded = verifyNpmReleaseAssetDirectory(
      scratch,
      path.basename(tag).replace(/^v/, ""),
      repository
    );
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
      "body,isDraft,isImmutable,isPrerelease,name"
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
  if (Object.keys(record).sort().join(",") !== "body,isDraft,isImmutable,isPrerelease,name"
    || typeof record.body !== "string"
    || typeof record.isDraft !== "boolean"
    || typeof record.isImmutable !== "boolean"
    || typeof record.isPrerelease !== "boolean"
    || typeof record.name !== "string") {
    throw new Error("GitHub release state is invalid");
  }
  return Object.freeze({
    body: record.body,
    isDraft: record.isDraft,
    isImmutable: record.isImmutable,
    isPrerelease: record.isPrerelease,
    name: record.name
  });
}

function requireReleaseContents(state: ReleaseState, context: ReleaseContext): void {
  if (state.name !== context.title || state.body !== context.notesBody) {
    throw new Error("GitHub release title or notes do not match the prepared release");
  }
}

/**
 * Refuses a release that is not immutable, and refuses a release whose
 * `isPrerelease` flag disagrees with the version's own channel — in either
 * direction. A prerelease version publishing over a stable release, or a
 * stable version publishing over a prerelease, is a channel mismatch this
 * repository must never paper over: npm cannot move a dist-tag once it
 * publishes, so the GitHub release has to name the same channel npm just
 * used.
 */
function requireImmutableReleaseChannel(
  state: ReleaseState,
  expectedPrerelease: boolean,
  label: string
): void {
  if (state.isDraft || !state.isImmutable || state.isPrerelease !== expectedPrerelease) {
    throw new Error(
      `${label} GitHub release is not an immutable ${expectedPrerelease ? "prerelease" : "release"}`
    );
  }
}

function requireDraftReleaseChannel(
  state: ReleaseState,
  expectedPrerelease: boolean
): void {
  if (!state.isDraft || state.isImmutable || state.isPrerelease !== expectedPrerelease) {
    throw new Error(
      `Uploaded GitHub release is not a draft ${
        expectedPrerelease ? "prerelease" : "release"
      }`
    );
  }
}

function isMissingRelease(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const detail = `${error.message}\n${
    String((error as { stdout?: unknown }).stdout ?? "")
  }\n${String((error as { stderr?: unknown }).stderr ?? "")}`;
  return /release not found|HTTP 404/iu.test(detail);
}

function boundedFile(
  value: string,
  label: string,
  maximumBytes: number
): string {
  const requested = lstatSync(value);
  if (!requested.isFile() || requested.isSymbolicLink()) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  const file = realpathSync(value);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maximumBytes) {
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
    const command = process.argv[2];
    if (command === "verify-assets" && process.argv.length === 6) {
      const version = process.argv[3];
      const repository = process.argv[4];
      const directory = process.argv[5];
      if (version === undefined || repository === undefined || directory === undefined) {
        throw new Error(
          "usage: release-npm-github.ts verify-assets <version> <repository> <assets>"
        );
      }
      verifyNpmReleaseAssetDirectory(directory, version, repository);
    } else if (process.argv.length === 7
      && (command === "prepare" || command === "verify" || command === "publish")) {
      const version = process.argv[3];
      const sourceCommit = process.argv[4];
      const releaseAssets = process.argv[5];
      const releaseNotes = process.argv[6];
      if (version === undefined
        || sourceCommit === undefined || releaseAssets === undefined
        || releaseNotes === undefined) {
        throw new Error("GitHub release arguments are incomplete");
      }
      const options = {
        version,
        sourceCommit,
        assetsDirectory: releaseAssets,
        notesFile: releaseNotes,
        environment: process.env
      };
      if (command === "prepare") await prepareOrVerifyGitHubRelease(options);
      else if (command === "verify") await verifyPreparedGitHubRelease(options);
      else await publishOrVerifyGitHubRelease(options);
    } else {
      throw new Error(
        "usage: release-npm-github.ts verify-assets <version> <repository> <assets>"
        + " | release-npm-github.ts <prepare|verify|publish>"
        + " <version> <source-commit> <assets> <notes>"
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release-npm-github: ${message}\n`);
    process.exitCode = 1;
  }
}

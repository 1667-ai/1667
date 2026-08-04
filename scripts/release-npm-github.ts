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
import { releaseArchiveFileName } from "./release-archive.js";
import { isExecutableFile } from "./release-boundary-validation.js";
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

const execFileAsync = promisify(execFile);
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const MAX_GH_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_NOTES_BYTES = 64 * 1024;

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

export interface GitHubReleaseCompatibilityOptions {
  readonly version: string;
  readonly environment: GitHubReleaseEnvironment;
  readonly ghExecutable?: string;
}

interface ReleaseState {
  readonly isDraft: boolean;
  readonly isImmutable: boolean;
  readonly isPrerelease: boolean;
}

interface ReleaseStateWithAssets extends ReleaseState {
  readonly assetNames: readonly string[];
}

export async function publishOrVerifyGitHubRelease(
  options: PublishGitHubReleaseOptions
): Promise<void> {
  if (!isSemVer(options.version)) throw new Error("GitHub release version is not SemVer");
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
  const gh = boundedExecutable(
    options.ghExecutable
      ?? requiredValue(options.environment.RELEASE_GH_PATH, "RELEASE_GH_PATH")
  );
  const assets = verifyNpmReleaseAssetDirectory(
    options.assetsDirectory,
    options.version,
    repository
  );
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
      ...(prerelease ? ["--prerelease"] : []),
      "--latest=false",
      "--title",
      `1667 v${options.version}`,
      "--notes-file",
      notes
    ], options.environment);
    created = true;
  } else {
    requireImmutableReleaseChannel(state, prerelease, "Existing");
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
  requireImmutableReleaseChannel(published, prerelease, "Published");
  if (published.isDraft) throw new Error("Published GitHub release is still a draft");
}

/**
 * Refuses to let npm publication proceed against an existing GitHub release
 * for this tag that `publishOrVerifyGitHubRelease` could not later reconcile
 * with — issue #5 review.
 *
 * Once a stable version can reach `release-github.yml`'s archive path too,
 * both that workflow and this one can create a GitHub release for the same
 * `v<version>` tag, and they run in separate concurrency groups: nothing
 * serializes them against each other. `publishOrVerifyGitHubRelease` already
 * refuses a channel mismatch and an asset-set mismatch (an archive-only
 * release is missing the npm tarballs, the observations, and the artifact
 * manifest), but only in the `release` job, which runs after `publish` has
 * already written to npm. That write cannot be taken back. This performs the
 * same two checks — channel and asset-name set — from `preflight`, before
 * `publish` ever runs, so the same incompatibility fails while it is still
 * survivable instead of after.
 *
 * A missing release and an existing draft are both left to
 * `publishOrVerifyGitHubRelease`: a draft is deleted and recreated there, so
 * neither can conflict with what `release` will do.
 */
export async function assertGitHubReleaseCompatibleForPublication(
  options: GitHubReleaseCompatibilityOptions
): Promise<void> {
  if (!isSemVer(options.version)) throw new Error("GitHub release version is not SemVer");
  const prerelease = isPrereleaseVersion(options.version);
  const repository = requiredMatch(
    options.environment.GITHUB_REPOSITORY,
    REPOSITORY,
    "GITHUB_REPOSITORY"
  );
  const gh = boundedExecutable(
    options.ghExecutable
      ?? requiredValue(options.environment.RELEASE_GH_PATH, "RELEASE_GH_PATH")
  );
  const tag = `v${options.version}`;
  const existing = await releaseStateWithAssets(gh, tag, repository, options.environment);
  if (existing === null || existing.isDraft) return;
  if (!existing.isImmutable || existing.isPrerelease !== prerelease) {
    throw new Error(
      `Existing GitHub release ${tag} is not an immutable ${
        prerelease ? "prerelease" : "release"} npm publication can publish alongside`
    );
  }
  const expected = [...expectedGitHubReleaseAssetNames(options.version)].sort();
  const actual = [...existing.assetNames].sort();
  const matches = actual.length === expected.length
    && actual.every((name, index) => name === expected[index]);
  if (!matches) {
    throw new Error(
      `Existing GitHub release ${tag} does not carry the asset set npm publication expects`
      + " (an archive-only release cannot be published alongside)"
    );
  }
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

async function releaseStateWithAssets(
  gh: string,
  tag: string,
  repository: string,
  environment: GitHubReleaseEnvironment
): Promise<ReleaseStateWithAssets | null> {
  let stdout: string;
  try {
    ({ stdout } = await runGh(gh, [
      "release",
      "view",
      tag,
      "--repo",
      repository,
      "--json",
      "isDraft,isImmutable,isPrerelease,assets"
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
  if (Object.keys(record).sort().join(",") !== "assets,isDraft,isImmutable,isPrerelease"
    || typeof record.isDraft !== "boolean"
    || typeof record.isImmutable !== "boolean"
    || typeof record.isPrerelease !== "boolean"
    || !Array.isArray(record.assets)) {
    throw new Error("GitHub release state is invalid");
  }
  const assetNames = record.assets.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)
      || typeof (entry as Record<string, unknown>).name !== "string") {
      throw new Error(`GitHub release asset entry ${index} is invalid`);
    }
    return (entry as Record<string, unknown>).name as string;
  });
  return Object.freeze({
    isDraft: record.isDraft,
    isImmutable: record.isImmutable,
    isPrerelease: record.isPrerelease,
    assetNames: Object.freeze(assetNames)
  });
}

/**
 * Refuses a release that is not immutable, and refuses a release whose
 * `isPrerelease` flag disagrees with the version's own channel — in either
 * direction. A prerelease version publishing over a stable release, or a
 * stable version publishing over a prerelease, is a channel mismatch this
 * repository must never paper over: npm cannot move a dist-tag once it
 * publishes, so the GitHub release has to name the same channel npm just
 * used.
 *
 * `expectedPrerelease` is always `true` on the one path this repository
 * exercised before stable versions existed, so this refuses exactly what
 * `requireImmutablePrerelease` used to refuse there, and nothing less.
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
  if (!stat.isFile() || stat.isSymbolicLink() || !isExecutableFile(value, stat.mode)) {
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
    const [command, assetsDirectory, notesFile] = process.argv.slice(2);
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
    } else if (command === "check-existing" && process.argv.length === 4) {
      const version = process.argv[3];
      if (version === undefined) {
        throw new Error("usage: release-npm-github.ts check-existing <version>");
      }
      await assertGitHubReleaseCompatibleForPublication({ version, environment: process.env });
    } else if (process.argv.length === 5 && command !== undefined
      && assetsDirectory !== undefined && notesFile !== undefined) {
      await publishOrVerifyGitHubRelease({
        version: command,
        assetsDirectory,
        notesFile,
        environment: process.env
      });
    } else {
      throw new Error(
        "usage: release-npm-github.ts verify-assets <version> <repository> <assets>"
        + " | release-npm-github.ts check-existing <version>"
        + " | release-npm-github.ts <version> <assets> <notes>"
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release-npm-github: ${message}\n`);
    process.exitCode = 1;
  }
}

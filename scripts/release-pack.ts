#!/usr/bin/env -S node --import tsx

import { execFile } from "node:child_process";
import {
  chmodSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { canonicalJson } from "../server/canonical-json.js";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import {
  PUBLISHED_ARTIFACT_TARGETS,
  PUBLISHED_PACKAGE_COUNT,
  RELEASE_LAUNCHER_PACKAGE,
  releaseTargetForArtifact,
  type BuiltArtifactTarget
} from "../shared/release-targets.js";
import {
  parseReleasePackageManifest,
  validateReleaseTarballInspection
} from "./release-package-policy.js";
import { readReleaseTarball } from "./release-tar-reader.js";

const execFileAsync = promisify(execFile);
const MAX_STAGED_PACKAGE_JSON_BYTES = 64 * 1024;

export interface NpmPackInvocation {
  readonly nodeExecutable: string;
  readonly npmCli: string;
}

export interface ReleasePackageToPack {
  readonly artifactTarget: "launcher" | BuiltArtifactTarget;
  readonly packageName: string;
  readonly version: string;
  readonly directory: string;
}

export interface PackedReleasePackage {
  readonly artifactTarget: "launcher" | BuiltArtifactTarget;
  readonly packageName: string;
  readonly version: string;
  readonly stagingDirectory: string;
  readonly tarballPath: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface PackReleasePackagesOptions {
  readonly packages: readonly ReleasePackageToPack[];
  readonly outputDirectory: string;
  readonly npm: NpmPackInvocation;
}

/**
 * Packs and validates the exact publication matrix. The final directory
 * appears only after every tarball passes validation.
 */
export async function packReleasePackages(
  options: PackReleasePackagesOptions
): Promise<readonly PackedReleasePackage[]> {
  validatePublishedInputs(options.packages);
  const invocation = validateNpmInvocation(options.npm);
  const finalRoot = freshOutputPath(options.outputDirectory);
  const temporaryRoot = freshSiblingDirectory(finalRoot);
  try {
    const results = await Promise.allSettled(options.packages.map((entry) => {
      return packPreparedPackage(entry, temporaryRoot, invocation);
    }));
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (rejected !== undefined) throw rejected.reason;
    const packed = results.map((result) => {
      if (result.status !== "fulfilled") throw new Error("Release pack did not complete");
      return result.value;
    });
    renameSync(temporaryRoot, finalRoot);
    return Object.freeze(packed.map((entry) => {
      return Object.freeze({
        ...entry,
        tarballPath: path.join(finalRoot, path.basename(entry.tarballPath))
      });
    }));
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function packReleasePackage(
  staged: ReleasePackageToPack,
  outputDirectory: string,
  npm: NpmPackInvocation
): Promise<PackedReleasePackage> {
  const destination = boundedDirectory(outputDirectory, "Release pack output directory");
  return packPreparedPackage(staged, destination, validateNpmInvocation(npm));
}

async function packPreparedPackage(
  staged: ReleasePackageToPack,
  destination: string,
  invocation: NpmPackInvocation
): Promise<PackedReleasePackage> {
  const stagingDirectory = boundedDirectory(staged.directory, "Release package staging directory");
  const stagedManifest = parseReleasePackageManifest(
    readStagedPackageManifest(stagingDirectory),
    staged.version
  );
  assertManifestMatchesInput(stagedManifest, staged, "Staged package");
  const temporaryRoot = freshChildDirectory(destination, ".pack-");
  try {
    const { stdout } = await execFileAsync(
      invocation.nodeExecutable,
      [
        invocation.npmCli,
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        temporaryRoot
      ],
      {
        cwd: stagingDirectory,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          npm_config_ignore_scripts: "true"
        }
      }
    );
    const filename = packedFilename(
      parseJsonRejectingDuplicateKeys(stdout),
      staged.packageName
    );
    assertOnlyPackedFile(temporaryRoot, filename);
    const temporaryTarball = boundedFileInDirectory(temporaryRoot, filename);
    const parsed = await readReleaseTarball(createReadStream(temporaryTarball));
    const manifest = parseReleasePackageManifest(
      parsed.packageManifest,
      staged.version
    );
    assertManifestMatchesInput(manifest, staged, "npm pack");
    validateReleaseTarballInspection(parsed.inspection, manifest);
    const finalTarball = freshOutputPath(path.join(destination, filename));
    renameSync(temporaryTarball, finalTarball);
    rmSync(temporaryRoot, { recursive: true, force: true });
    return Object.freeze({
      artifactTarget: staged.artifactTarget,
      packageName: staged.packageName,
      version: manifest.version,
      stagingDirectory,
      tarballPath: finalTarball,
      sha256: parsed.gzip.sha256,
      bytes: parsed.gzip.bytes
    });
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

/**
 * npm sets these absolute paths for lifecycle scripts. The release workflow
 * invokes this command through npm after it pins and checks both tool versions.
 */
export function npmPackInvocationFromEnvironment(): NpmPackInvocation {
  const npmCli = process.env.npm_execpath;
  const nodeExecutable = process.env.npm_node_execpath;
  if (npmCli === undefined || nodeExecutable === undefined) {
    throw new Error("Run release-pack through npm so the pinned npm and Node paths are explicit");
  }
  return validateNpmInvocation({ npmCli, nodeExecutable });
}

function validatePublishedInputs(packages: readonly ReleasePackageToPack[]): void {
  if (packages.length !== PUBLISHED_PACKAGE_COUNT) {
    throw new Error(`Release pack requires exactly ${PUBLISHED_PACKAGE_COUNT} staged packages`);
  }
  const expectedVersion = packages[0]!.version;
  const expected = [
    ["launcher", RELEASE_LAUNCHER_PACKAGE],
    ...PUBLISHED_ARTIFACT_TARGETS.map((target) => [
      target,
      releaseTargetForArtifact(target).packageName
    ])
  ] as const;
  for (const [index, [artifactTarget, packageName]] of expected.entries()) {
    const staged = packages[index];
    if (staged?.artifactTarget !== artifactTarget || staged.packageName !== packageName) {
      throw new Error(`Release pack staging does not match ${packageName}`);
    }
    if (staged.version !== expectedVersion) {
      throw new Error("Release pack requires one version for all staged packages");
    }
  }
}

function validateNpmInvocation(value: NpmPackInvocation): NpmPackInvocation {
  return Object.freeze({
    nodeExecutable: boundedExecutable(value.nodeExecutable, "Release Node executable"),
    npmCli: boundedRegularFile(value.npmCli, "Release npm CLI")
  });
}

function packedFilename(value: unknown, packageName: string): string {
  if (!Array.isArray(value) || value.length !== 1
    || value[0] === null || typeof value[0] !== "object"
    || typeof (value[0] as Record<string, unknown>).filename !== "string") {
    throw new Error(`npm pack returned no unique archive for ${packageName}`);
  }
  const filename = (value[0] as { filename: string }).filename;
  if (filename.length === 0 || path.basename(filename) !== filename || filename.includes("\0")) {
    throw new Error(`npm pack returned an unsafe filename for ${packageName}`);
  }
  return filename;
}

function assertOnlyPackedFile(directory: string, filename: string): void {
  const entries = readdirSync(directory);
  if (entries.length !== 1 || entries[0] !== filename) {
    throw new Error(`npm pack wrote unexpected output for ${filename}`);
  }
}

function readStagedPackageManifest(directory: string): unknown {
  const file = path.join(directory, "package.json");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0
    || stat.size > MAX_STAGED_PACKAGE_JSON_BYTES) {
    throw new Error("Staged package.json must be a bounded regular file");
  }
  const resolved = realpathSync(file);
  if (path.dirname(resolved) !== directory) {
    throw new Error("Staged package.json escaped its staging directory");
  }
  return parseJsonRejectingDuplicateKeys(readFileSync(resolved, "utf8"));
}

function assertManifestMatchesInput(
  manifest: ReturnType<typeof parseReleasePackageManifest>,
  staged: ReleasePackageToPack,
  source: string
): void {
  if (manifest.name !== staged.packageName) {
    throw new Error(`${source} returned ${manifest.name}, expected ${staged.packageName}`);
  }
  const artifactTarget = manifest.kind === "launcher" ? "launcher" : manifest.target;
  if (artifactTarget !== staged.artifactTarget) {
    throw new Error(
      `${source} returned ${artifactTarget}, expected ${staged.artifactTarget}`
    );
  }
}

function boundedDirectory(value: string, label: string): string {
  const resolved = path.resolve(value);
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  return realpathSync(resolved);
}

function boundedRegularFile(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} must use an absolute path`);
  const stat = lstatSync(value);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    throw new Error(`${label} must be a non-empty regular file`);
  }
  return realpathSync(value);
}

function boundedExecutable(value: string, label: string): string {
  const file = boundedRegularFile(value, label);
  if ((lstatSync(file).mode & 0o111) === 0) throw new Error(`${label} is not executable`);
  return file;
}

function boundedFileInDirectory(directory: string, filename: string): string {
  const candidate = path.join(directory, filename);
  const file = boundedRegularFile(candidate, "Packed release tarball");
  if (path.dirname(file) !== directory) {
    throw new Error("Packed release tarball escaped its output directory");
  }
  return file;
}

function freshOutputPath(value: string): string {
  const requested = path.resolve(value);
  const parent = path.dirname(requested);
  mkdirSync(parent, { recursive: true, mode: 0o755 });
  const output = path.join(realpathSync(parent), path.basename(requested));
  try {
    lstatSync(output);
    throw new Error(`Release output already exists: ${output}`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return output;
}

function freshSiblingDirectory(finalDirectory: string): string {
  return freshChildDirectory(
    path.dirname(finalDirectory),
    `.${path.basename(finalDirectory)}-`
  );
}

function freshChildDirectory(parent: string, prefix: string): string {
  const directory = mkdtempSync(path.join(parent, prefix));
  chmodSync(directory, 0o755);
  return realpathSync(directory);
}

const USAGE = "usage: npm run release:pack -- <version> <staging-directory> <output-directory>";

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
    const [version, stagingDirectory, outputDirectory] = process.argv.slice(2);
    if (process.argv.length !== 5 || version === undefined
      || stagingDirectory === undefined || outputDirectory === undefined) {
      throw new Error(USAGE);
    }
    const root = path.resolve(stagingDirectory);
    const packages: ReleasePackageToPack[] = [
      {
        artifactTarget: "launcher",
        packageName: RELEASE_LAUNCHER_PACKAGE,
        version,
        directory: path.join(root, "launcher")
      },
      ...PUBLISHED_ARTIFACT_TARGETS.map((artifactTarget) => ({
        artifactTarget,
        packageName: releaseTargetForArtifact(artifactTarget).packageName,
        version,
        directory: path.join(root, artifactTarget)
      }))
    ];
    const packed = await packReleasePackages({
      packages,
      outputDirectory,
      npm: npmPackInvocationFromEnvironment()
    });
    process.stdout.write(`${canonicalJson({
      schemaVersion: 1,
      packages: packed.map((entry) => ({
        artifactTarget: entry.artifactTarget,
        packageName: entry.packageName,
        version: entry.version,
        tarballPath: entry.tarballPath,
        sha256: entry.sha256,
        bytes: entry.bytes
      }))
    })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release-pack: ${message}\n`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env -S node --import tsx

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../server/canonical-json.js";
import {
  releaseTargetForArtifact,
  PACKAGED_ARTIFACT_TARGETS,
  type CanonicalReleaseTarget,
  type PackagedArtifactTarget
} from "../shared/release-targets.js";
import { isSemVer } from "../shared/semver.js";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import { sha256Digest } from "./release-boundary-validation.js";
import { releaseNotesMarkdown } from "./release-github-notes.js";
import {
  createReleaseIdentitySet,
  releaseIdentityForTarget,
  type ReleaseSourceEvidence
} from "./release-identity.js";
import {
  createReleasePlatformManifest,
  RELEASE_LICENSE_FILES,
  RELEASE_LICENSE_FILE_DIGESTS
} from "./release-package-manifests.js";
import { createReleasePackageBuildManifest } from "./release-package-templates.js";
import {
  assertPublishedReleaseTarget,
  PUBLISHED_RELEASE_TARGETS,
  releaseArchiveStem,
  RELEASE_CHECKSUMS_FILE
} from "./release-publication.js";
import {
  defaultReleaseSbomInputs,
  readReleaseSboms,
  releaseSbomForPackage
} from "./release-sbom.js";

export const RELEASE_BUILD_MANIFEST_FILE = "build-manifest.json" as const;
export const RELEASE_SBOM_FILE = "sbom.spdx.json" as const;

const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 1024 * 1024;
/** Release asset basenames: a version may carry `+` build metadata. */
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;

export type ReleaseContentSource =
  | { readonly kind: "executable" }
  | {
      readonly kind: "repository-file";
      readonly repositoryPath: string;
      readonly sha256: string;
      readonly bytes: number;
    }
  | { readonly kind: "build-manifest" }
  | { readonly kind: "sbom" };

export interface ReleaseContentEntry {
  /** Path inside the assembled directory, POSIX separators. */
  readonly path: string;
  readonly mode: number;
  readonly source: ReleaseContentSource;
}

export interface ReleaseContentLayout {
  /**
   * Where the executable sits inside the assembled directory. A downloaded
   * archive puts it at the top level so `./<stem>/1667` runs; an npm package
   * declares `bin/1667`, which is why this is a parameter rather than a
   * constant. The npm stager, when it is written, calls this same function with
   * that path and adds `package.json` to what it writes; it must not grow a
   * second copy of the file list.
   */
  readonly executablePath: string;
}

/**
 * The exact contents of one release archive: nothing more, nothing less.
 *
 * The names come from the platform package manifest, so the archive a user
 * downloads and the tarball npm would publish carry the same set, and a file
 * added there cannot be silently missing here — an unrecognised name throws.
 * `LICENSE` and `NOTICE` are not optional and are not decoration. Apache-2.0
 * section 4(a) requires a copy of the licence for each recipient of the work
 * and 4(d) requires the NOTICE content in each distribution; an archive is
 * what a recipient receives, so the obligation is met inside the archive
 * rather than beside it. Both carry the reviewed digests, so a wrong or
 * truncated file fails staging instead of shipping.
 */
export function releaseContentFileSet(
  target: PackagedArtifactTarget,
  version: string,
  layout?: ReleaseContentLayout
): readonly ReleaseContentEntry[] {
  if (!isSemVer(version)) throw new Error(`Release contents need a SemVer version, not ${version}`);
  const descriptor = releaseTargetForArtifact(target);
  const executablePath = layout?.executablePath ?? path.posix.basename(descriptor.executable);
  const manifest = createReleasePlatformManifest(target, version);
  return Object.freeze(manifest.files.map((name) => {
    return contentEntry(name, descriptor, executablePath);
  }));
}

/** The archive layout: every file at the top level of the extracted directory. */
export function releaseArchiveFileSet(
  target: PackagedArtifactTarget,
  version: string
): readonly ReleaseContentEntry[] {
  assertPublishedReleaseTarget(target);
  const entries = releaseContentFileSet(target, version);
  for (const entry of entries) {
    if (entry.path.includes("/")) {
      throw new Error(`Release archive entry ${entry.path} is not at the top level`);
    }
  }
  return entries;
}

function contentEntry(
  name: string,
  descriptor: CanonicalReleaseTarget,
  executablePath: string
): ReleaseContentEntry {
  if (name === descriptor.executable) {
    return Object.freeze({
      path: executablePath,
      mode: descriptor.platform === "win32" ? 0o644 : 0o755,
      source: Object.freeze({ kind: "executable" as const })
    });
  }
  for (const licenceFile of RELEASE_LICENSE_FILES) {
    if (name !== licenceFile) continue;
    const pinned = RELEASE_LICENSE_FILE_DIGESTS[licenceFile];
    return Object.freeze({
      path: licenceFile,
      mode: 0o644,
      source: Object.freeze({
        kind: "repository-file" as const,
        repositoryPath: licenceFile,
        sha256: pinned.sha256,
        bytes: pinned.bytes
      })
    });
  }
  if (name === RELEASE_BUILD_MANIFEST_FILE) {
    return Object.freeze({
      path: RELEASE_BUILD_MANIFEST_FILE,
      mode: 0o644,
      source: Object.freeze({ kind: "build-manifest" as const })
    });
  }
  if (name === RELEASE_SBOM_FILE) {
    return Object.freeze({
      path: RELEASE_SBOM_FILE,
      mode: 0o644,
      source: Object.freeze({ kind: "sbom" as const })
    });
  }
  throw new Error(`Release contents have no source for ${name}`);
}

export interface ReleaseSourceEvidenceInput {
  readonly version: string;
  readonly sourceCommit: string;
  readonly buildTimestamp: string;
  readonly packageVersions: {
    readonly root: string;
    readonly tui: string;
    readonly rootLock: string;
    readonly rootLockPackage: string;
  };
}

/**
 * Source evidence for a GitHub pre-release build.
 *
 * The evidence codec is shared with npm preflight, where publication cannot be
 * withdrawn and the trust anchor is a maintainer who ran `git verify-tag`
 * themselves; it therefore accepts `tagObjectType: "annotated"` with
 * `tagSignature: "verified"` and no other value. A GitHub pre-release anchors
 * somewhere else: the build-provenance attestation GitHub's Sigstore instance
 * issues over each archive, which binds the bytes to this workflow, this
 * repository, and this commit, and which `gh attestation verify` checks. The
 * tag fields below name the tag the release publishes at `sourceCommit`. No
 * shipped file and no line of the release notes claims a verified tag
 * signature, and npm publication still requires the signed-tag evidence
 * documented in docs/RELEASING.md.
 */
export function githubReleaseSourceEvidence(
  input: ReleaseSourceEvidenceInput
): ReleaseSourceEvidence {
  if (!isSemVer(input.version)) {
    throw new Error(`Release evidence needs a SemVer version, not ${input.version}`);
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    productVersion: input.version,
    sourceCommit: input.sourceCommit,
    sourceDirty: false as const,
    tagName: `v${input.version}`,
    tagObjectType: "annotated" as const,
    tagSignature: "verified" as const,
    tagTargetCommit: input.sourceCommit,
    buildTimestamp: input.buildTimestamp,
    packageVersions: Object.freeze({ ...input.packageVersions })
  });
}

export interface ReleaseAssetDigest {
  readonly name: string;
  readonly sha256: string;
}

/**
 * `checksums.txt`, in the `sha256sum -c` format: one `<hex>  <name>` line per
 * uploaded asset, sorted by name. The file cannot cover itself, so an entry
 * for it is dropped rather than rejected — the release job creates the file by
 * redirection before this runs, and a rerun must not fail on its own output.
 */
export function formatReleaseChecksums(assets: readonly ReleaseAssetDigest[]): string {
  const covered = assets.filter((asset) => asset.name !== RELEASE_CHECKSUMS_FILE);
  if (covered.length === 0) throw new Error("Release checksums would cover no assets");
  const seen = new Set<string>();
  for (const asset of covered) {
    if (!ASSET_NAME.test(asset.name)) throw new Error(`Release asset name ${asset.name} is invalid`);
    if (seen.has(asset.name)) throw new Error(`Release checksums repeat ${asset.name}`);
    seen.add(asset.name);
    sha256Digest(asset.sha256, asset.name);
  }
  return [...covered]
    .sort((left, right) => compareNames(left.name, right.name))
    .map((asset) => `${asset.sha256}  ${asset.name}\n`)
    .join("");
}

export interface StagedReleaseFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface StagedReleaseArchive {
  readonly target: PackagedArtifactTarget;
  readonly version: string;
  readonly stem: string;
  readonly directory: string;
  readonly files: readonly StagedReleaseFile[];
}

export interface StageReleaseArchiveOptions {
  /** Release source evidence, as written by the `evidence` command. */
  readonly evidencePath: string;
  readonly target: PackagedArtifactTarget;
  /** Directory holding the freshly built executable, normally `tui/dist`. */
  readonly buildDirectory: string;
  /** Directory that receives the archive directory. */
  readonly outputDirectory: string;
}

/**
 * Materialises the directory the workflow tars. Every entry in the file set is
 * written or the command fails: there is no path that produces an archive with
 * a missing file, and the assembled directory is compared against the file set
 * afterwards so a stray file cannot ride along either.
 */
export function stageReleaseArchive(options: StageReleaseArchiveOptions): StagedReleaseArchive {
  const evidencePath = path.resolve(options.evidencePath);
  const identities = createReleaseIdentitySet(readJsonFile(evidencePath, MAX_EVIDENCE_BYTES));
  const version = identities.evidence.productVersion;
  const target = options.target;
  const descriptor = releaseTargetForArtifact(target);
  const stem = releaseArchiveStem(version, target);
  const directory = path.join(path.resolve(options.outputDirectory), stem);
  mkdirSync(directory, { recursive: true, mode: 0o755 });

  const sbom = releaseSbomForPackage(
    readReleaseSboms(defaultReleaseSbomInputs(evidencePath)),
    descriptor.packageName
  );
  const buildManifest = createReleasePackageBuildManifest(
    identities.evidence,
    descriptor.packageName,
    target
  );
  const files: StagedReleaseFile[] = [];
  for (const entry of releaseArchiveFileSet(target, version)) {
    const destination = path.join(directory, entry.path);
    if (entry.source.kind === "executable") {
      const executable = boundedRegularFile(
        path.join(path.resolve(options.buildDirectory), path.posix.basename(descriptor.executable)),
        MAX_EXECUTABLE_BYTES,
        "Release executable"
      );
      copyFileSync(executable, destination);
    } else if (entry.source.kind === "repository-file") {
      writeFileSync(destination, reviewedRepositoryFile(entry.source));
    } else if (entry.source.kind === "build-manifest") {
      writeFileSync(destination, `${canonicalJson(buildManifest)}\n`, "utf8");
    } else {
      writeFileSync(destination, `${sbom.text}\n`, "utf8");
    }
    chmodSync(destination, entry.mode);
    files.push(digestOf(directory, entry.path));
  }
  assertDirectoryHolds(directory, files.map((file) => file.path));
  return Object.freeze({
    target,
    version,
    stem,
    directory,
    files: Object.freeze(files)
  });
}

/** Reads a repository-root file and refuses any bytes but the reviewed ones. */
function reviewedRepositoryFile(
  source: Extract<ReleaseContentSource, { kind: "repository-file" }>
): Buffer {
  const file = path.join(repositoryRoot(), source.repositoryPath);
  const bytes = readFileSync(boundedRegularFile(file, source.bytes, source.repositoryPath));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== source.bytes || sha256 !== source.sha256) {
    throw new Error(`${source.repositoryPath} is not the reviewed file this release may ship`);
  }
  return bytes;
}

function assertDirectoryHolds(directory: string, expected: readonly string[]): void {
  const staged = readdirSync(directory).sort(compareNames);
  const wanted = [...expected].sort(compareNames);
  if (staged.length !== wanted.length || staged.some((name, index) => name !== wanted[index])) {
    throw new Error(
      `Staged ${directory} holds ${staged.join(", ")}; the release requires ${wanted.join(", ")}`
    );
  }
}

function digestOf(directory: string, name: string): StagedReleaseFile {
  const bytes = readFileSync(path.join(directory, name));
  if (bytes.byteLength === 0) throw new Error(`Staged ${name} is empty`);
  return Object.freeze({
    path: name,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength
  });
}

export function directoryAssetDigests(directory: string): readonly ReleaseAssetDigest[] {
  const resolved = path.resolve(directory);
  return Object.freeze(readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== RELEASE_CHECKSUMS_FILE)
    .map((entry) => {
      const file = digestOf(resolved, entry.name);
      return Object.freeze({ name: file.path, sha256: file.sha256 });
    }));
}

function compareNames(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function boundedRegularFile(file: string, maximumBytes: number, label: string): string {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maximumBytes) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  return realpathSync(file);
}

function readJsonFile(file: string, maximumBytes: number): unknown {
  const bytes = readFileSync(boundedRegularFile(file, maximumBytes, file));
  return parseJsonRejectingDuplicateKeys(bytes.toString("utf8"));
}

function repositoryRoot(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function packagedTarget(value: string | undefined): PackagedArtifactTarget {
  const target = PACKAGED_ARTIFACT_TARGETS.find((candidate) => candidate === value);
  if (target === undefined) throw new Error(`Unsupported release target ${String(value)}`);
  return target;
}

function repositoryPackageVersions(): ReleaseSourceEvidenceInput["packageVersions"] {
  const root = repositoryRoot();
  const rootPackage = readJsonFile(path.join(root, "package.json"), MAX_EVIDENCE_BYTES);
  const tuiPackage = readJsonFile(path.join(root, "tui", "package.json"), MAX_EVIDENCE_BYTES);
  const rootLock = readJsonFile(path.join(root, "package-lock.json"), 8 * 1024 * 1024);
  const lockPackages = property(rootLock, "packages");
  return {
    root: stringProperty(rootPackage, "version"),
    tui: stringProperty(tuiPackage, "version"),
    rootLock: stringProperty(rootLock, "version"),
    rootLockPackage: stringProperty(property(lockPackages, ""), "version")
  };
}

function property(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Release input has no ${key || "root"} member`);
  }
  return (value as Record<string, unknown>)[key];
}

function stringProperty(value: unknown, key: string): string {
  const member = property(value, key);
  if (typeof member !== "string" || member.length === 0) {
    throw new Error(`Release input has no ${key}`);
  }
  return member;
}

const USAGE = [
  "usage: release-github-assets.ts <command>",
  "  targets                                          published targets, as JSON",
  "  evidence <version> <commit> <timestamp>          release source evidence, as JSON",
  "  identity <evidence.json> <target>                build identity for the compiler",
  "  stage <evidence.json> <target> <build-dir> <out> archive directory; prints its name",
  "  checksums <directory>                            checksums.txt for every asset there",
  "  notes <version>                                  release notes, as Markdown"
].join("\n");

function runCommand(argv: readonly string[]): string {
  const [command, ...rest] = argv;
  if (command === "targets") {
    if (rest.length !== 0) throw new Error(USAGE);
    return `${JSON.stringify(PUBLISHED_RELEASE_TARGETS)}\n`;
  }
  if (command === "evidence") {
    const [version, sourceCommit, buildTimestamp] = rest;
    if (rest.length !== 3 || version === undefined || sourceCommit === undefined
      || buildTimestamp === undefined) {
      throw new Error(USAGE);
    }
    const evidence = githubReleaseSourceEvidence({
      version,
      sourceCommit,
      buildTimestamp,
      packageVersions: repositoryPackageVersions()
    });
    // Constructed and then parsed: the workflow never writes evidence the
    // release identity codec would reject at the next step.
    createReleaseIdentitySet(evidence);
    return `${canonicalJson(evidence)}\n`;
  }
  if (command === "identity") {
    const [evidencePath, target] = rest;
    if (rest.length !== 2 || evidencePath === undefined) throw new Error(USAGE);
    const identities = createReleaseIdentitySet(
      readJsonFile(path.resolve(evidencePath), MAX_EVIDENCE_BYTES)
    );
    return `${canonicalJson(releaseIdentityForTarget(identities, packagedTarget(target)))}\n`;
  }
  if (command === "stage") {
    const [evidencePath, target, buildDirectory, outputDirectory] = rest;
    if (rest.length !== 4 || evidencePath === undefined || buildDirectory === undefined
      || outputDirectory === undefined) {
      throw new Error(USAGE);
    }
    const staged = stageReleaseArchive({
      evidencePath,
      target: packagedTarget(target),
      buildDirectory,
      outputDirectory
    });
    for (const file of staged.files) {
      process.stderr.write(`staged ${file.sha256} ${String(file.bytes).padStart(9)} ${file.path}\n`);
    }
    return `${staged.stem}\n`;
  }
  if (command === "checksums") {
    const [directory] = rest;
    if (rest.length !== 1 || directory === undefined) throw new Error(USAGE);
    return formatReleaseChecksums(directoryAssetDigests(directory));
  }
  if (command === "notes") {
    const [version] = rest;
    if (rest.length !== 1 || version === undefined) throw new Error(USAGE);
    return releaseNotesMarkdown(version);
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
    process.stdout.write(runCommand(process.argv.slice(2)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release-github-assets: ${message}\n`);
    process.exitCode = 1;
  }
}

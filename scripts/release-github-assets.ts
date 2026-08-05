#!/usr/bin/env -S node --import tsx

import {
  readdirSync,
  realpathSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../server/canonical-json.js";
import {
  releaseTargetForArtifact,
  releaseTargetForRuntime,
  BUILT_ARTIFACT_TARGETS,
  PUBLISHED_ARTIFACT_TARGETS,
  type BuiltArtifactTarget,
  type CanonicalReleaseTarget
} from "../shared/release-targets.js";
import {
  releaseArchiveStem,
  RELEASE_CHECKSUMS_FILE
} from "./release-archive.js";
import { releaseArchiveFileSet } from "./release-archive-layout.js";
import { sha256Digest } from "./release-boundary-validation.js";
import {
  digestStagedFile,
  releaseContentFileSet,
  stageReleaseContent,
  type StagedReleaseFile
} from "./release-content.js";
import { releaseIdentityForTarget } from "./release-identity.js";
import { createReleasePlatformPackageTemplate } from "./release-package-templates.js";
import {
  createReleaseSboms,
  releaseSbomForPackage,
  repositoryReleaseComponentSources
} from "./release-sbom.js";
import {
  collectRepositoryReleaseSource,
  releaseIdentitiesForSource,
  releaseSbomSourceForSource,
  type CollectedReleaseSource,
  type ReleaseSourceFacts
} from "./release-source-facts.js";

/** Release asset basenames: a version may carry `+` build metadata. */
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;

export {
  RELEASE_BUILD_MANIFEST_FILE,
  RELEASE_SBOM_FILE,
  releaseContentFileSet
} from "./release-content.js";
export {
  releaseArchiveFileSet,
  releaseArchiveMemberPaths,
  releaseArchiveMemberRelPaths,
  publishedShellArchiveMemberRelLayout
} from "./release-archive-layout.js";

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

export interface StagedReleaseArchive {
  readonly target: BuiltArtifactTarget;
  readonly version: string;
  readonly stem: string;
  readonly directory: string;
  readonly files: readonly StagedReleaseFile[];
}

/** The three source facts, plus where to read the build from and write to. */
export interface StageReleaseArchiveOptions {
  readonly source: CollectedReleaseSource;
  readonly target: BuiltArtifactTarget;
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
export function stageReleaseArchive(
  options: StageReleaseArchiveOptions
): StagedReleaseArchive {
  const identities = releaseIdentitiesForSource(options.source);
  const sbomSource = releaseSbomSourceForSource(options.source);
  const version = identities.source.productVersion;
  const target = options.target;
  const descriptor = releaseTargetForArtifact(target);
  const stem = releaseArchiveStem(version, target);
  const directory = path.join(path.resolve(options.outputDirectory), stem);
  const entries = releaseArchiveFileSet(target, version);
  const template = createReleasePlatformPackageTemplate(identities, target);
  const sbom = releaseSbomForPackage(
    createReleaseSboms(sbomSource, repositoryReleaseComponentSources()),
    descriptor.packageName
  );
  const staged = stageReleaseContent({
    template,
    sbom,
    entries,
    executable: path.join(
      path.resolve(options.buildDirectory),
      path.posix.basename(descriptor.executable)
    ),
    directory
  });
  return Object.freeze({
    target,
    version,
    stem,
    directory: staged.directory,
    files: staged.files
  });
}

export function directoryAssetDigests(directory: string): readonly ReleaseAssetDigest[] {
  const resolved = path.resolve(directory);
  return Object.freeze(readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== RELEASE_CHECKSUMS_FILE)
    .map((entry) => {
      const file = digestStagedFile(resolved, entry.name);
      return Object.freeze({ name: file.path, sha256: file.sha256 });
    }));
}

function compareNames(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Refuses to build a target on a machine that is not that target.
 *
 * `bun build --compile` emits an executable for the machine it runs on. The
 * release path supplies the build identity instead of deriving one, so the
 * `artifactTarget` stamped into `build-manifest.json` is whatever the matrix
 * said, and the smoke that compares the executable against that same supplied
 * identity structurally cannot see a difference. The only thing binding a
 * matrix target to a machine is the runner label map in the workflow, and
 * GitHub repoints labels. So read the machine, map it through the one release
 * target table, and refuse anything but the target that was asked for. A
 * refused build is a missing archive, which stops the release; an unrefused
 * one is an attested archive that cannot execute on the platform it names.
 */
export function assertRunnerBuildsTarget(
  target: BuiltArtifactTarget,
  platform: string,
  arch: string
): CanonicalReleaseTarget {
  const host = releaseTargetForRuntime(platform, arch);
  if (host === null) {
    throw new Error(`This machine is ${platform}-${arch}, which is no release target`);
  }
  if (host.artifactTarget !== target) {
    throw new Error(
      `This machine builds ${host.artifactTarget}, but ${target} was asked for`
    );
  }
  return host;
}

function builtTarget(value: string | undefined): BuiltArtifactTarget {
  const target = BUILT_ARTIFACT_TARGETS.find((candidate) => candidate === value);
  if (target === undefined) throw new Error(`Unsupported release target ${String(value)}`);
  return target;
}

/**
 * Each command that needs a release identity collects one validated source in
 * memory. No command accepts or produces a source evidence document.
 */
const USAGE = [
  "usage: release-github-assets.ts <command>",
  "  targets",
  "      the published targets, as JSON",
  "  runner <target>",
  "      accept or reject this machine as that target's build host",
  "  identity <version> <commit> <timestamp> <target>",
  "      the build identity the compiler embeds",
  "  stage <version> <commit> <timestamp> <target> <build-dir> <out>",
  "      the archive directory; prints its name",
  "  checksums <directory>",
  "      checksums.txt for every asset there"
].join("\n");

function sourceFacts(rest: readonly string[]): ReleaseSourceFacts {
  const [version, sourceCommit, buildTimestamp] = rest;
  if (version === undefined || sourceCommit === undefined || buildTimestamp === undefined) {
    throw new Error(USAGE);
  }
  return Object.freeze({ version, sourceCommit, buildTimestamp });
}

function runCommand(argv: readonly string[]): string {
  const [command, ...rest] = argv;
  if (command === "targets") {
    if (rest.length !== 0) throw new Error(USAGE);
    return `${JSON.stringify(PUBLISHED_ARTIFACT_TARGETS)}\n`;
  }
  if (command === "runner") {
    const [target] = rest;
    if (rest.length !== 1 || target === undefined) throw new Error(USAGE);
    const host = assertRunnerBuildsTarget(builtTarget(target), process.platform, process.arch);
    return `this machine builds ${host.artifactTarget}\n`;
  }
  if (command === "identity") {
    if (rest.length !== 4) throw new Error(USAGE);
    const identities = releaseIdentitiesForSource(
      collectRepositoryReleaseSource(sourceFacts(rest))
    );
    return `${canonicalJson(releaseIdentityForTarget(identities, builtTarget(rest[3])))}\n`;
  }
  if (command === "stage") {
    const [buildDirectory, outputDirectory] = rest.slice(4);
    if (rest.length !== 6 || buildDirectory === undefined || outputDirectory === undefined) {
      throw new Error(USAGE);
    }
    const staged = stageReleaseArchive({
      source: collectRepositoryReleaseSource(sourceFacts(rest)),
      target: builtTarget(rest[3]),
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

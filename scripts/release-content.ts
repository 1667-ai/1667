import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../server/canonical-json.js";
import {
  releaseTargetForArtifact,
  type BuiltArtifactTarget,
  type CanonicalReleaseTarget
} from "../shared/release-targets.js";
import { isSemVer } from "../shared/semver.js";
import {
  createReleaseLauncherManifest,
  createReleasePlatformManifest,
  RELEASE_LICENSE_FILES,
  RELEASE_LICENSE_FILE_DIGESTS,
  RELEASE_PACKAGE_NOTICE
} from "./release-package-manifests.js";
import {
  type ReleasePackageTemplate
} from "./release-package-templates.js";
import { type ReleaseSbom } from "./release-sbom.js";

export const RELEASE_BUILD_MANIFEST_FILE = "build-manifest.json" as const;
export const RELEASE_SBOM_FILE = "sbom.spdx.json" as const;

const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAX_LAUNCHER_BYTES = 128 * 1024;

export type ReleaseContentArtifact = "launcher" | BuiltArtifactTarget;
export type ReleaseContentDistribution = "npm-package" | "release-archive";

export type ReleaseContentSource =
  | { readonly kind: "executable" }
  | {
      readonly kind: "repository-file";
      readonly repositoryPath: string;
      readonly sha256: string;
      readonly bytes: number;
    }
  | { readonly kind: "package-notice" }
  | { readonly kind: "build-manifest" }
  | { readonly kind: "sbom" };

export interface ReleaseContentEntry {
  /** Path inside the assembled directory, with POSIX separators. */
  readonly path: string;
  readonly mode: number;
  readonly source: ReleaseContentSource;
}

export interface ReleaseContentLayout {
  readonly executablePath: string;
}

export interface StagedReleaseFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface StagedReleaseContent {
  readonly artifactTarget: ReleaseContentArtifact;
  readonly packageName: string;
  readonly directory: string;
  readonly files: readonly StagedReleaseFile[];
}

export interface StageReleaseContentOptions {
  /** Selects the canonical NOTICE policy for this distribution. */
  readonly distribution: ReleaseContentDistribution;
  readonly template: ReleasePackageTemplate;
  readonly sbom: ReleaseSbom;
  /** Validated entries that the materializer must write without reconstruction. */
  readonly entries: readonly ReleaseContentEntry[];
  /** Exact launcher source or native executable to stage. */
  readonly executable: string;
  /** Fresh directory that receives the assembled content. */
  readonly directory: string;
  readonly layout?: ReleaseContentLayout;
}

/**
 * Returns the common contents of one release archive or npm package.
 * The package manifest owns the names. An unrecognised name throws.
 */
export function releaseContentFileSet(
  artifactTarget: ReleaseContentArtifact,
  version: string,
  layout?: ReleaseContentLayout
): readonly ReleaseContentEntry[] {
  if (!isSemVer(version)) throw new Error(`Release contents need a SemVer version, not ${version}`);
  const descriptor = artifactTarget === "launcher"
    ? null
    : releaseTargetForArtifact(artifactTarget);
  const executable = descriptor?.executable ?? "bin/1667.js";
  const executablePath = layout?.executablePath ?? path.posix.basename(executable);
  const manifest = artifactTarget === "launcher"
    ? createReleaseLauncherManifest(version)
    : createReleasePlatformManifest(artifactTarget, version);
  return contentFileSet(
    manifest.files,
    executable,
    descriptor?.platform ?? null,
    executablePath,
    "release-archive"
  );
}

/** Returns package content from the supplied canonical template. */
export function releasePackageContentFileSet(
  template: ReleasePackageTemplate,
  layout?: ReleaseContentLayout
): readonly ReleaseContentEntry[] {
  const artifactTarget = template.buildManifest.artifactTarget;
  const descriptor = artifactTarget === "launcher"
    ? null
    : releaseTargetForArtifact(artifactTarget);
  const executable = descriptor?.executable ?? "bin/1667.js";
  return contentFileSet(
    template.packageManifest.files,
    executable,
    descriptor?.platform ?? null,
    layout?.executablePath ?? path.posix.basename(executable),
    "npm-package"
  );
}

/**
 * Materialises the content shared by release archives and npm packages.
 * The destination must not exist. The function validates the full tree before
 * it returns.
 */
export function stageReleaseContent(
  options: StageReleaseContentOptions
): StagedReleaseContent {
  const template = options.template;
  const artifactTarget = template.buildManifest.artifactTarget;
  const packageName = template.packageManifest.name;
  if (options.sbom.packageName !== packageName
    || options.sbom.artifactTarget !== artifactTarget) {
    throw new Error(`Release SBOM does not match ${packageName}`);
  }
  const entries = options.entries;
  assertEntriesMatchTemplate(entries, template, options.layout, options.distribution);
  const finalDirectory = freshOutputPath(options.directory);
  const directory = temporarySiblingDirectory(finalDirectory);
  try {
    const files: StagedReleaseFile[] = [];
    for (const entry of entries) {
      const destination = path.join(directory, entry.path);
      createParentDirectories(directory, path.dirname(destination));
      if (entry.source.kind === "executable") {
        const executable = boundedRegularFile(
          path.resolve(options.executable),
          artifactTarget === "launcher" ? MAX_LAUNCHER_BYTES : MAX_EXECUTABLE_BYTES,
          "Release executable"
        );
        copyFileSync(executable, destination);
      } else if (entry.source.kind === "repository-file") {
        writeFileSync(destination, reviewedRepositoryFile(entry.source));
      } else if (entry.source.kind === "package-notice") {
        writeFileSync(destination, RELEASE_PACKAGE_NOTICE, "utf8");
      } else if (entry.source.kind === "build-manifest") {
        writeFileSync(destination, `${canonicalJson(template.buildManifest)}\n`, "utf8");
      } else {
        writeFileSync(destination, `${options.sbom.text}\n`, "utf8");
      }
      chmodSync(destination, entry.mode);
      files.push(digestStagedFile(directory, entry.path));
    }
    assertDirectoryHolds(directory, files.map((file) => file.path));
    renameSync(directory, finalDirectory);
    return Object.freeze({
      artifactTarget,
      packageName,
      directory: finalDirectory,
      files: Object.freeze(files)
    });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function digestStagedFile(directory: string, name: string): StagedReleaseFile {
  const bytes = readFileSync(path.join(directory, name));
  if (bytes.byteLength === 0) throw new Error(`Staged ${name} is empty`);
  return Object.freeze({
    path: name,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength
  });
}

function contentEntry(
  name: string,
  executable: string,
  platform: CanonicalReleaseTarget["platform"] | null,
  executablePath: string,
  distribution: ReleaseContentDistribution
): ReleaseContentEntry {
  if (name === executable) {
    return Object.freeze({
      path: executablePath,
      mode: platform === "win32" ? 0o644 : 0o755,
      source: Object.freeze({ kind: "executable" as const })
    });
  }
  for (const licenceFile of RELEASE_LICENSE_FILES) {
    if (name !== licenceFile) continue;
    if (name === "NOTICE" && distribution === "npm-package") {
      return Object.freeze({
        path: licenceFile,
        mode: 0o644,
        source: Object.freeze({ kind: "package-notice" as const })
      });
    }
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

function contentFileSet(
  files: readonly string[],
  executable: string,
  platform: CanonicalReleaseTarget["platform"] | null,
  executablePath: string,
  distribution: ReleaseContentDistribution
): readonly ReleaseContentEntry[] {
  return Object.freeze(files.map((name) => {
    return contentEntry(name, executable, platform, executablePath, distribution);
  }));
}

function assertEntriesMatchTemplate(
  entries: readonly ReleaseContentEntry[],
  template: ReleasePackageTemplate,
  layout: ReleaseContentLayout | undefined,
  distribution: ReleaseContentDistribution
): void {
  const expected = distribution === "npm-package"
    ? releasePackageContentFileSet(template, layout)
    : releaseContentFileSet(
        template.buildManifest.artifactTarget,
        template.packageManifest.version,
        layout
      );
  if (canonicalJson(entries) !== canonicalJson(expected)) {
    throw new Error(`Release contents do not match ${template.packageManifest.name}`);
  }
}

function freshOutputPath(value: string): string {
  const requested = path.resolve(value);
  const parent = path.dirname(requested);
  mkdirSync(parent, { recursive: true, mode: 0o755 });
  const directory = path.join(realpathSync(parent), path.basename(requested));
  try {
    lstatSync(directory);
    throw new Error(`Release staging directory already exists: ${directory}`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return directory;
}

function temporarySiblingDirectory(finalDirectory: string): string {
  const directory = mkdtempSync(path.join(
    path.dirname(finalDirectory),
    `.${path.basename(finalDirectory)}-`
  ));
  chmodSync(directory, 0o755);
  return realpathSync(directory);
}

function createParentDirectories(root: string, directory: string): void {
  const relative = path.relative(root, directory);
  if (relative === "" || relative === ".") return;
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    mkdirSync(current, { mode: 0o755 });
    chmodSync(current, 0o755);
  }
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
  const stagedFiles: string[] = [];
  const stagedDirectories: string[] = [];
  const visit = (current: string, relative: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const name = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        stagedDirectories.push(name);
        visit(path.join(current, entry.name), name);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        stagedFiles.push(name);
      } else {
        throw new Error(`Staged ${directory} contains an unsupported entry ${name}`);
      }
    }
  };
  visit(directory, "");
  const wantedFiles = [...expected].sort(compareNames);
  const wantedDirectories = [...new Set(expected.flatMap((name) => {
    const parts = name.split("/");
    return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join("/"));
  }))].sort(compareNames);
  stagedFiles.sort(compareNames);
  stagedDirectories.sort(compareNames);
  if (stagedFiles.length !== wantedFiles.length
    || stagedFiles.some((name, index) => name !== wantedFiles[index])
    || stagedDirectories.length !== wantedDirectories.length
    || stagedDirectories.some((name, index) => name !== wantedDirectories[index])) {
    throw new Error(
      `Staged ${directory} holds ${stagedFiles.join(", ")}; `
      + `the release requires ${wantedFiles.join(", ")}`
    );
  }
}

function boundedRegularFile(file: string, maximumBytes: number, label: string): string {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maximumBytes) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  return realpathSync(file);
}

function repositoryRoot(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function compareNames(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

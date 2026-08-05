#!/usr/bin/env -S node --import tsx

import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../server/canonical-json.js";
import {
  PUBLISHED_ARTIFACT_TARGETS,
  releaseTargetForArtifact,
  type PublishedArtifactTarget
} from "../shared/release-targets.js";
import {
  digestStagedFile,
  releasePackageContentFileSet,
  stageReleaseContent,
  type ReleaseContentArtifact,
  type StagedReleaseFile
} from "./release-content.js";
import { type ReleaseBuildIdentitySet } from "./release-identity.js";
import {
  type ReleasePackageJson
} from "./release-package-manifests.js";
import {
  createReleaseLauncherPackageTemplate,
  createReleasePlatformPackageTemplate,
  type ReleasePackageTemplate
} from "./release-package-templates.js";
import {
  createReleaseSboms,
  releaseSbomForPackage,
  repositoryReleaseComponentSources,
  type ReleaseSbomSet
} from "./release-sbom.js";
import {
  releaseDescriptionInputsForSource,
  type ReleaseDescriptionInputs,
  type ReleaseSourceFacts
} from "./release-source-facts.js";

export interface StagedReleasePackage {
  readonly artifactTarget: ReleaseContentArtifact;
  readonly packageName: string;
  readonly version: string;
  readonly published: boolean;
  readonly directory: string;
  readonly packageManifest: ReleasePackageJson;
  readonly files: readonly StagedReleaseFile[];
}

export interface StageReleasePackageOptions extends ReleaseSourceFacts {
  readonly artifactTarget: ReleaseContentArtifact;
  readonly executable: string;
  readonly outputDirectory: string;
}

export interface StagePublishedReleasePackagesOptions extends ReleaseSourceFacts {
  readonly buildDirectories: Readonly<Record<PublishedArtifactTarget, string>>;
  readonly outputDirectory: string;
}

export interface StagePreparedPublishedReleasePackagesOptions
  extends ReleaseDescriptionInputs {
  readonly buildDirectories: Readonly<Record<PublishedArtifactTarget, string>>;
  readonly outputDirectory: string;
}

/**
 * Stages one package with the content assembler used by GitHub release
 * archives. This entry point accepts a held target for native verification.
 */
export function stageReleasePackage(
  options: StageReleasePackageOptions
): StagedReleasePackage {
  const finalRoot = freshOutputPath(options.outputDirectory, options.artifactTarget);
  const temporaryRoot = freshSiblingDirectory(finalRoot);
  try {
    const { identities, sbomSource } = releaseDescriptionInputsForSource(options);
    const sboms = createReleaseSboms(
      sbomSource,
      repositoryReleaseComponentSources()
    );
    const staged = stagePreparedPackage({
      template: packageTemplate(identities, options.artifactTarget),
      sboms,
      executable: options.executable,
      outputDirectory: temporaryRoot,
      buildTimestamp: identities.source.buildTimestamp
    });
    renameSync(staged.directory, finalRoot);
    rmSync(temporaryRoot, { recursive: true, force: true });
    return rebasePackage(staged, finalRoot);
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Stages the exact npm publication matrix from the checked-out package
 * versions. The final directory appears only after all packages pass.
 */
export function stagePublishedReleasePackages(
  options: StagePublishedReleasePackagesOptions
): readonly StagedReleasePackage[] {
  return stagePreparedPublishedReleasePackages({
    ...releaseDescriptionInputsForSource(options),
    buildDirectories: options.buildDirectories,
    outputDirectory: options.outputDirectory
  });
}

/** Stages a package set from source data that a higher boundary prepared. */
export function stagePreparedPublishedReleasePackages(
  options: StagePreparedPublishedReleasePackagesOptions
): readonly StagedReleasePackage[] {
  const finalRoot = freshOutputPath(options.outputDirectory);
  const temporaryRoot = freshSiblingDirectory(finalRoot);
  try {
    const sboms = createReleaseSboms(
      options.sbomSource,
      repositoryReleaseComponentSources()
    );
    const launcher = stagePreparedPackage({
      template: createReleaseLauncherPackageTemplate(options.identities),
      sboms,
      executable: repositoryLauncher(),
      outputDirectory: temporaryRoot,
      buildTimestamp: options.identities.source.buildTimestamp
    });
    const platforms = PUBLISHED_ARTIFACT_TARGETS.map((artifactTarget) => {
      const descriptor = releaseTargetForArtifact(artifactTarget);
      return stagePreparedPackage({
        template: createReleasePlatformPackageTemplate(options.identities, artifactTarget),
        sboms,
        executable: path.join(
          path.resolve(options.buildDirectories[artifactTarget]),
          path.posix.basename(descriptor.executable)
        ),
        outputDirectory: temporaryRoot,
        buildTimestamp: options.identities.source.buildTimestamp
      });
    });
    const packages = [launcher, ...platforms];
    if (packages.some((entry) => !entry.published)) {
      throw new Error("Published release staging contains a held target");
    }
    renameSync(temporaryRoot, finalRoot);
    return Object.freeze(packages.map((entry) => {
      return rebasePackage(entry, path.join(finalRoot, entry.artifactTarget));
    }));
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

interface PreparedPackageOptions {
  readonly template: ReleasePackageTemplate;
  readonly sboms: ReleaseSbomSet;
  readonly executable: string;
  readonly outputDirectory: string;
  readonly buildTimestamp: string;
}

function stagePreparedPackage(options: PreparedPackageOptions): StagedReleasePackage {
  const template = options.template;
  const artifactTarget = template.buildManifest.artifactTarget;
  const descriptor = artifactTarget === "launcher"
    ? null
    : releaseTargetForArtifact(artifactTarget);
  const executablePath = descriptor?.executable ?? "bin/1667.js";
  const layout = { executablePath };
  const common = stageReleaseContent({
    template,
    sbom: releaseSbomForPackage(options.sboms, template.packageManifest.name),
    entries: releasePackageContentFileSet(template, layout),
    executable: options.executable,
    directory: path.join(options.outputDirectory, artifactTarget),
    layout
  });
  const packageJsonPath = path.join(common.directory, "package.json");
  writeFileSync(packageJsonPath, `${canonicalJson(template.packageManifest)}\n`, "utf8");
  chmodSync(packageJsonPath, 0o644);
  normalizeTreeModificationTimes(common.directory, options.buildTimestamp);
  return Object.freeze({
    artifactTarget,
    packageName: template.packageManifest.name,
    version: template.packageManifest.version,
    published: descriptor === null || descriptor.heldFromPublication === null,
    directory: common.directory,
    packageManifest: template.packageManifest,
    files: Object.freeze([
      digestStagedFile(common.directory, "package.json"),
      ...common.files
    ])
  });
}

function packageTemplate(
  identities: ReleaseBuildIdentitySet,
  artifactTarget: ReleaseContentArtifact
): ReleasePackageTemplate {
  return artifactTarget === "launcher"
    ? createReleaseLauncherPackageTemplate(identities)
    : createReleasePlatformPackageTemplate(identities, artifactTarget);
}

function normalizeTreeModificationTimes(directory: string, timestamp: string): void {
  const time = new Date(timestamp);
  const directories: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        directories.push(child);
        visit(child);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        utimesSync(child, time, time);
      } else {
        throw new Error(`Release package staging contains an unsupported entry ${child}`);
      }
    }
  };
  visit(directory);
  for (const child of directories.reverse()) utimesSync(child, time, time);
  utimesSync(directory, time, time);
}

function freshOutputPath(root: string, child?: string): string {
  const resolvedRoot = path.resolve(root);
  const requested = child === undefined ? resolvedRoot : path.join(resolvedRoot, child);
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
  const prefix = path.join(
    path.dirname(finalDirectory),
    `.${path.basename(finalDirectory)}-`
  );
  const directory = mkdtempSync(prefix);
  chmodSync(directory, 0o755);
  return realpathSync(directory);
}

function rebasePackage(
  staged: StagedReleasePackage,
  directory: string
): StagedReleasePackage {
  return Object.freeze({ ...staged, directory });
}

function repositoryLauncher(): string {
  return path.join(
    path.dirname(path.dirname(fileURLToPath(import.meta.url))),
    "release",
    "npm",
    "launcher.mjs"
  );
}

const USAGE = [
  "usage: release-stage-packages.ts <version> <commit> <timestamp> <builds-dir> <out>",
  "  each native executable must be at <builds-dir>/<target>/<executable>"
].join("\n");

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
    const [version, sourceCommit, buildTimestamp, buildsDirectory, outputDirectory] =
      process.argv.slice(2);
    if (process.argv.length !== 7 || version === undefined || sourceCommit === undefined
      || buildTimestamp === undefined || buildsDirectory === undefined
      || outputDirectory === undefined) {
      throw new Error(USAGE);
    }
    const buildRoot = path.resolve(buildsDirectory);
    const buildDirectories = Object.fromEntries(PUBLISHED_ARTIFACT_TARGETS.map((target) => {
      return [target, path.join(buildRoot, target)];
    })) as Record<PublishedArtifactTarget, string>;
    const packages = stagePublishedReleasePackages({
      version,
      sourceCommit,
      buildTimestamp,
      buildDirectories,
      outputDirectory
    });
    process.stdout.write(`${canonicalJson({
      schemaVersion: 1,
      packages: packages.map((entry) => ({
        artifactTarget: entry.artifactTarget,
        packageName: entry.packageName,
        version: entry.version,
        directory: entry.directory
      }))
    })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release-stage-packages: ${message}\n`);
    process.exitCode = 1;
  }
}

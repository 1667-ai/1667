import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isCanonicalTimestamp } from "../shared/build-identity.js";
import { isSemVer } from "../shared/semver.js";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import {
  assertReleasePackageVersions,
  createReleaseBuildIdentitySet,
  type ReleaseBuildIdentitySet,
  type ReleasePackageVersions
} from "./release-identity.js";
import {
  createReleaseSbomSource,
  type ReleaseSbomSource
} from "./release-sbom-source.js";

const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024;
const MAX_LOCKFILE_BYTES = 8 * 1024 * 1024;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/u;
const RELEASE_ARTIFACT_INPUTS: unique symbol = Symbol("release-artifact-inputs");

/**
 * The whole of what one release run has to agree on: the version being
 * released, the commit it is built from, and the single timestamp the run
 * stamps on every artifact.
 *
 * Three strings, and deliberately nothing larger. A collector validates these
 * facts before a producer uses them.
 */
export interface ReleaseSourceFacts {
  readonly version: string;
  readonly sourceCommit: string;
  readonly buildTimestamp: string;
}

export interface ReleaseArtifactInputs {
  readonly identities: ReleaseBuildIdentitySet;
  readonly sbomSource: ReleaseSbomSource;
}

/** One opaque and frozen source snapshot for all artifact producers. */
export interface CollectedReleaseSource {
  readonly [RELEASE_ARTIFACT_INPUTS]: true;
  readonly facts: Readonly<ReleaseSourceFacts>;
}

/** Collects source facts against the package versions in one repository. */
export function collectReleaseSourceFromRepository(
  facts: ReleaseSourceFacts,
  repositoryRoot: string
): CollectedReleaseSource {
  const root = boundedRepositoryRoot(repositoryRoot);
  const snapshot = validateReleaseSource(facts, repositoryPackageVersions(root));
  const collected = { facts: snapshot } as CollectedReleaseSource;
  Object.defineProperty(collected, RELEASE_ARTIFACT_INPUTS, { value: true });
  return Object.freeze(collected);
}

/** Derives all producer views from one collected source record. */
export function releaseArtifactInputs(
  source: CollectedReleaseSource
): ReleaseArtifactInputs {
  if (source[RELEASE_ARTIFACT_INPUTS] !== true
    || !Object.isFrozen(source) || !Object.isFrozen(source.facts)) {
    throw new Error("Release artifact source was not collected");
  }
  const facts = source.facts;
  return Object.freeze({
    identities: createReleaseBuildIdentitySet({
      productVersion: facts.version,
      sourceCommit: facts.sourceCommit,
      buildTimestamp: facts.buildTimestamp
    }),
    sbomSource: sbomSourceFromFacts(facts)
  });
}

function validateReleaseSource(
  facts: ReleaseSourceFacts,
  packageVersions: ReleasePackageVersions
): Readonly<ReleaseSourceFacts> {
  const snapshot = Object.freeze({
    version: facts.version,
    sourceCommit: facts.sourceCommit,
    buildTimestamp: facts.buildTimestamp
  });
  assertReleasePackageVersions(snapshot.version, packageVersions);
  if (!isSemVer(snapshot.version)) throw new Error("Release source version is not SemVer");
  if (!SOURCE_COMMIT.test(snapshot.sourceCommit)) {
    throw new Error("Release source commit is not canonical");
  }
  if (!isCanonicalTimestamp(snapshot.buildTimestamp)) {
    throw new Error("Release source timestamp is not canonical");
  }
  return snapshot;
}

/** Collects source facts against the package versions in this checkout. */
export function collectRepositoryReleaseSource(
  facts: ReleaseSourceFacts
): CollectedReleaseSource {
  return collectReleaseSourceFromRepository(facts, currentRepositoryRoot());
}

/** Collects only the validated source that the standalone SBOM command uses. */
export function collectRepositoryReleaseSbomSource(
  facts: ReleaseSourceFacts
): ReleaseSbomSource {
  return sbomSourceFromFacts(
    validateReleaseSource(facts, repositoryPackageVersions(currentRepositoryRoot()))
  );
}

function sbomSourceFromFacts(facts: ReleaseSourceFacts): ReleaseSbomSource {
  return createReleaseSbomSource({
    productVersion: facts.version,
    sourceCommit: facts.sourceCommit,
    buildTimestamp: facts.buildTimestamp,
    tagName: `v${facts.version}`
  });
}

/**
 * The versions this checkout declares. Each staging boundary requires all four
 * versions to equal the dispatched version.
 */
function repositoryPackageVersions(root: string): ReleasePackageVersions {
  const rootPackage = readJsonFile(path.join(root, "package.json"), MAX_PACKAGE_MANIFEST_BYTES);
  const tuiPackage = readJsonFile(
    path.join(root, "tui", "package.json"),
    MAX_PACKAGE_MANIFEST_BYTES
  );
  const rootLock = readJsonFile(path.join(root, "package-lock.json"), MAX_LOCKFILE_BYTES);
  const lockPackages = property(rootLock, "packages");
  return Object.freeze({
    root: stringProperty(rootPackage, "version"),
    tui: stringProperty(tuiPackage, "version"),
    rootLock: stringProperty(rootLock, "version"),
    rootLockPackage: stringProperty(property(lockPackages, ""), "version")
  });
}

function readJsonFile(file: string, maximumBytes: number): unknown {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maximumBytes) {
    throw new Error(`${file} must be a bounded regular file`);
  }
  return parseJsonRejectingDuplicateKeys(readFileSync(realpathSync(file)).toString("utf8"));
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

function currentRepositoryRoot(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function boundedRepositoryRoot(value: string): string {
  const resolved = path.resolve(value);
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Release repository root must be a real directory");
  }
  return realpathSync(resolved);
}

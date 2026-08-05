import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * The whole of what one release run has to agree on: the version being
 * released, the commit it is built from, and the single timestamp the run
 * stamps on every artifact.
 *
 * Three strings, and deliberately nothing larger. See
 * `releaseIdentitiesForSource` for why nothing larger may cross a job boundary.
 */
export interface ReleaseSourceFacts {
  readonly version: string;
  readonly sourceCommit: string;
  readonly buildTimestamp: string;
}

/** Builds the exact, authorization-free source record that an SBOM uses. */
export function releaseSbomSourceForFacts(facts: ReleaseSourceFacts): ReleaseSbomSource {
  return createReleaseSbomSource({
    productVersion: facts.version,
    sourceCommit: facts.sourceCommit,
    buildTimestamp: facts.buildTimestamp,
    tagName: `v${facts.version}`
  });
}

export interface ReleaseDescriptionInputs {
  readonly identities: ReleaseBuildIdentitySet;
  readonly sbomSource: ReleaseSbomSource;
}

/**
 * Derives build identities and the SBOM source from one immutable read of the
 * source facts.
 */
export function releaseDescriptionInputsForSource(
  facts: ReleaseSourceFacts
): ReleaseDescriptionInputs {
  const snapshot = Object.freeze({
    version: facts.version,
    sourceCommit: facts.sourceCommit,
    buildTimestamp: facts.buildTimestamp
  });
  return Object.freeze({
    identities: releaseIdentitiesForSource(snapshot),
    sbomSource: releaseSbomSourceForFacts(snapshot)
  });
}

/**
 * Refuses a product version that does not describe all package inputs in this
 * checkout.
 */
export function assertRepositoryPackageVersions(productVersion: string): void {
  assertReleasePackageVersions(productVersion, repositoryPackageVersions());
}

/**
 * The release identities for one run, built from the three source facts.
 *
 * The facts come from `prepare` rather than being recomputed on each runner so
 * that every target in a run writes the same version, commit and timestamp into
 * its `build-manifest.json`: one build described once, not one build per runner
 * minutes apart.
 */
export function releaseIdentitiesForSource(
  facts: ReleaseSourceFacts
): ReleaseBuildIdentitySet {
  return createReleaseBuildIdentitySet({
    productVersion: facts.version,
    sourceCommit: facts.sourceCommit,
    buildTimestamp: facts.buildTimestamp
  });
}

/**
 * The versions this checkout declares. Each staging boundary requires all four
 * versions to equal the dispatched version.
 */
export function repositoryPackageVersions(): ReleasePackageVersions {
  const root = repositoryRoot();
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

function repositoryRoot(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

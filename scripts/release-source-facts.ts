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
const COLLECTED_RELEASE_SOURCE: unique symbol = Symbol("CollectedReleaseSource");

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

/** One validated source value for all release artifact producers. */
export interface CollectedReleaseSource extends ReleaseSourceFacts {
  readonly [COLLECTED_RELEASE_SOURCE]: true;
  readonly identities: ReleaseBuildIdentitySet;
  readonly sbomSource: ReleaseSbomSource;
}

/** Collects source facts after it checks supplied package-version observations. */
export function collectReleaseSource(
  facts: ReleaseSourceFacts,
  packageVersions: ReleasePackageVersions
): CollectedReleaseSource {
  const snapshot = Object.freeze({
    version: facts.version,
    sourceCommit: facts.sourceCommit,
    buildTimestamp: facts.buildTimestamp
  });
  assertReleasePackageVersions(snapshot.version, packageVersions);
  const identities = createReleaseBuildIdentitySet({
    productVersion: snapshot.version,
    sourceCommit: snapshot.sourceCommit,
    buildTimestamp: snapshot.buildTimestamp
  });
  const sbomSource = createReleaseSbomSource({
    productVersion: snapshot.version,
    sourceCommit: snapshot.sourceCommit,
    buildTimestamp: snapshot.buildTimestamp,
    tagName: `v${snapshot.version}`
  });
  return Object.freeze({
    ...snapshot,
    [COLLECTED_RELEASE_SOURCE]: true as const,
    identities,
    sbomSource
  });
}

/** Collects source facts against the package versions in this checkout. */
export function collectRepositoryReleaseSource(
  facts: ReleaseSourceFacts
): CollectedReleaseSource {
  return collectReleaseSource(facts, repositoryPackageVersions());
}

/**
 * The versions this checkout declares. Each staging boundary requires all four
 * versions to equal the dispatched version.
 */
function repositoryPackageVersions(): ReleasePackageVersions {
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

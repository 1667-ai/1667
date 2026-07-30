/**
 * Canonical 7-field package build-manifest.json schema for launcher and
 * platform npm packages. Distinct from the executable BuildIdentity probe
 * contract (shared/build-identity.ts).
 */
import { isCanonicalTimestamp } from "./build-identity.js";
import {
  isBuiltArtifactTarget,
  type BuiltArtifactTarget
} from "./release-targets.js";
import { isSemVer } from "./semver.js";

export type PackageBuildArtifactTarget = "launcher" | BuiltArtifactTarget;

export interface PackageBuildManifest<
  ArtifactTarget extends PackageBuildArtifactTarget = PackageBuildArtifactTarget
> {
  readonly schemaVersion: 1;
  readonly product: "1667";
  readonly productVersion: string;
  readonly sourceCommit: string;
  readonly buildTimestamp: string;
  readonly packageName: string;
  readonly artifactTarget: ArtifactTarget;
}

export interface PackageBuildEvidence {
  readonly productVersion: string;
  readonly sourceCommit: string;
  readonly buildTimestamp: string;
}

export interface PackageBuildManifestExpectation<
  ArtifactTarget extends PackageBuildArtifactTarget = PackageBuildArtifactTarget
> {
  readonly packageName: string;
  readonly productVersion: string;
  readonly artifactTarget: ArtifactTarget;
  readonly sourceCommit?: string;
  readonly buildTimestamp?: string;
}

const SOURCE_COMMIT = /^[0-9a-f]{40}$/;
const PACKAGE_NAME = /^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;
const MANIFEST_KEY_SET: ReadonlySet<string> = new Set([
  "schemaVersion",
  "product",
  "productVersion",
  "sourceCommit",
  "buildTimestamp",
  "packageName",
  "artifactTarget"
]);

export function createPackageBuildManifest<
  ArtifactTarget extends PackageBuildArtifactTarget
>(
  evidence: PackageBuildEvidence,
  packageName: string,
  artifactTarget: ArtifactTarget
): PackageBuildManifest<ArtifactTarget> {
  return parsePackageBuildManifest(
    {
      schemaVersion: 1,
      product: "1667",
      productVersion: evidence.productVersion,
      sourceCommit: evidence.sourceCommit,
      buildTimestamp: evidence.buildTimestamp,
      packageName,
      artifactTarget
    },
    {
      packageName,
      productVersion: evidence.productVersion,
      artifactTarget,
      sourceCommit: evidence.sourceCommit,
      buildTimestamp: evidence.buildTimestamp
    }
  );
}

export function parsePackageBuildManifest(
  value: unknown
): PackageBuildManifest;
export function parsePackageBuildManifest<
  ArtifactTarget extends PackageBuildArtifactTarget
>(
  value: unknown,
  expected: PackageBuildManifestExpectation<ArtifactTarget>
): PackageBuildManifest<ArtifactTarget>;
/**
 * Parses and validates a package build-manifest object. When expected is set,
 * also proves packageName, version, artifactTarget, source commit, and timestamp,
 * and returns a manifest typed to that artifact target.
 */
export function parsePackageBuildManifest<
  ArtifactTarget extends PackageBuildArtifactTarget
>(
  value: unknown,
  expected?: PackageBuildManifestExpectation<ArtifactTarget>
): PackageBuildManifest | PackageBuildManifest<ArtifactTarget> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Package build-manifest must be an object");
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length !== MANIFEST_KEY_SET.size
    || keys.some((key) => !MANIFEST_KEY_SET.has(key))) {
    throw new Error("Package build-manifest has unknown or missing fields");
  }
  if (input.schemaVersion !== 1) {
    throw new Error("Package build-manifest schema is unsupported");
  }
  if (input.product !== "1667") {
    throw new Error("Package build-manifest product is invalid");
  }
  if (typeof input.productVersion !== "string" || !isSemVer(input.productVersion)) {
    throw new Error("Package build-manifest product version is invalid");
  }
  if (typeof input.sourceCommit !== "string" || !SOURCE_COMMIT.test(input.sourceCommit)) {
    throw new Error("Package build-manifest source commit is invalid");
  }
  if (typeof input.buildTimestamp !== "string"
    || !isCanonicalTimestamp(input.buildTimestamp)) {
    throw new Error("Package build-manifest build timestamp is invalid");
  }
  if (typeof input.packageName !== "string" || !PACKAGE_NAME.test(input.packageName)) {
    throw new Error("Package build-manifest package name is invalid");
  }
  const resolvedTarget = resolvePackageBuildArtifactTarget(input.artifactTarget);
  if (expected !== undefined) {
    if (input.packageName !== expected.packageName) {
      throw new Error("Package build-manifest package name did not match");
    }
    if (input.productVersion !== expected.productVersion) {
      throw new Error("Package build-manifest product version did not match");
    }
    if (resolvedTarget !== expected.artifactTarget) {
      throw new Error("Package build-manifest artifact target did not match");
    }
    if (expected.sourceCommit !== undefined
      && input.sourceCommit !== expected.sourceCommit) {
      throw new Error("Package build-manifest source commit did not match");
    }
    if (expected.buildTimestamp !== undefined
      && input.buildTimestamp !== expected.buildTimestamp) {
      throw new Error("Package build-manifest build timestamp did not match");
    }
    return Object.freeze({
      schemaVersion: 1,
      product: "1667",
      productVersion: input.productVersion,
      sourceCommit: input.sourceCommit,
      buildTimestamp: input.buildTimestamp,
      packageName: input.packageName,
      artifactTarget: expected.artifactTarget
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    product: "1667",
    productVersion: input.productVersion,
    sourceCommit: input.sourceCommit,
    buildTimestamp: input.buildTimestamp,
    packageName: input.packageName,
    artifactTarget: resolvedTarget
  });
}

function resolvePackageBuildArtifactTarget(value: unknown): PackageBuildArtifactTarget {
  if (value === "launcher") return "launcher";
  if (isBuiltArtifactTarget(value)) return value;
  throw new Error("Package build-manifest artifact target is invalid");
}

/** Alias kept for release pack call sites that still use the prior name. */
export const createReleasePackageBuildManifest = createPackageBuildManifest;

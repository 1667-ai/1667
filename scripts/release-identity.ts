import {
  HTTP_API_PROTOCOL_VERSION,
  HTTP_MAX_CLIENT_PROTOCOL_VERSION,
  HTTP_MIN_CLIENT_PROTOCOL_VERSION,
  BUILT_ARTIFACT_TARGETS,
  parseBuildIdentity,
  type BuildIdentity,
  type BuiltArtifactTarget
} from "../shared/build-identity.js";
import { exactRecord } from "./release-boundary-validation.js";
import { parseNightlyVersion } from "./release-nightly-version.js";

export type ReleaseBuildIdentity = Extract<BuildIdentity, { buildKind: "release" }>;

export interface ReleasePackageVersions {
  root: string;
  tui: string;
  rootLock: string;
  rootLockPackage: string;
}

/**
 * A nightly build carries the committed version plus a nightly prerelease, so
 * the four package versions describe its base. The npm release path is
 * unaffected, because there the product version is read from
 * packageVersions.root (scripts/release-evidence-inspection.ts), so the two can
 * never differ there.
 */
export function assertReleasePackageVersions(
  productVersion: string,
  packageVersions: ReleasePackageVersions
): void {
  const nightly = parseNightlyVersion(productVersion);
  const expectedVersion = nightly !== null ? nightly.base : productVersion;
  for (const [label, version] of Object.entries(packageVersions)) {
    if (version !== expectedVersion) {
      throw new Error(`Release ${label} version does not match ${productVersion}`);
    }
  }
}

export interface ReleaseSourceEvidence {
  schemaVersion: 1;
  productVersion: string;
  sourceCommit: string;
  sourceDirty: false;
  tagName: string;
  tagObjectType: "annotated";
  tagSignature: "verified";
  tagTargetCommit: string;
  buildTimestamp: string;
  packageVersions: ReleasePackageVersions;
}

export interface ReleaseIdentitySet {
  schemaVersion: 1;
  evidence: ReleaseSourceEvidence;
  identities: readonly ReleaseBuildIdentity[];
}

const EVIDENCE_KEYS = new Set([
  "schemaVersion",
  "productVersion",
  "sourceCommit",
  "sourceDirty",
  "tagName",
  "tagObjectType",
  "tagSignature",
  "tagTargetCommit",
  "buildTimestamp",
  "packageVersions"
]);
const PACKAGE_VERSION_KEYS = new Set([
  "root",
  "tui",
  "rootLock",
  "rootLockPackage"
]);

/**
 * Converts separately collected Git/package evidence into the only identities
 * release builds may embed. The caller remains responsible for obtaining
 * `tagSignature: "verified"` from a trusted `git verify-tag` invocation.
 */
export function createReleaseIdentitySet(value: unknown): ReleaseIdentitySet {
  const evidence = parseSourceEvidence(value);
  const identities = BUILT_ARTIFACT_TARGETS.map((artifactTarget) => {
    return releaseBuildIdentity(evidence, artifactTarget);
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    evidence,
    identities: Object.freeze(identities)
  });
}

export function releaseIdentityForTarget(
  set: ReleaseIdentitySet,
  target: BuiltArtifactTarget
): ReleaseBuildIdentity {
  const identity = set.identities.find((candidate) => candidate.artifactTarget === target);
  if (identity === undefined) throw new Error(`Release identity is missing target ${target}`);
  return identity;
}

function parseSourceEvidence(value: unknown): ReleaseSourceEvidence {
  const input = exactRecord(value, EVIDENCE_KEYS, "Release source evidence");
  if (input.schemaVersion !== 1) throw new Error("Release source evidence has an unsupported schema");
  if (input.sourceDirty !== false) throw new Error("Release source must be clean");
  if (input.tagObjectType !== "annotated") {
    throw new Error("Release source must use an annotated tag");
  }
  if (input.tagSignature !== "verified") {
    throw new Error("Release tag signature must be verified");
  }

  const productVersion = stringField(input.productVersion, "productVersion");
  const sourceCommit = stringField(input.sourceCommit, "sourceCommit");
  const tagName = stringField(input.tagName, "tagName");
  const tagTargetCommit = stringField(input.tagTargetCommit, "tagTargetCommit");
  const buildTimestamp = stringField(input.buildTimestamp, "buildTimestamp");
  if (tagName !== `v${productVersion}`) {
    throw new Error("Release tag must exactly match v<productVersion>");
  }
  if (tagTargetCommit !== sourceCommit) {
    throw new Error("Release tag target and source commit disagree");
  }

  const packageVersionsInput = exactRecord(
    input.packageVersions,
    PACKAGE_VERSION_KEYS,
    "Release package versions"
  );
  const packageVersions = Object.freeze({
    root: stringField(packageVersionsInput.root, "packageVersions.root"),
    tui: stringField(packageVersionsInput.tui, "packageVersions.tui"),
    rootLock: stringField(packageVersionsInput.rootLock, "packageVersions.rootLock"),
    rootLockPackage: stringField(
      packageVersionsInput.rootLockPackage,
      "packageVersions.rootLockPackage"
    )
  });
  assertReleasePackageVersions(productVersion, packageVersions);

  // Reuse the product's strict identity codec for SemVer, commit, timestamp,
  // and protocol-range validation before accepting the evidence.
  releaseBuildIdentity({
    schemaVersion: 1,
    productVersion,
    sourceCommit,
    sourceDirty: false,
    tagName,
    tagObjectType: "annotated",
    tagSignature: "verified",
    tagTargetCommit,
    buildTimestamp,
    packageVersions
  }, BUILT_ARTIFACT_TARGETS[0]);

  return Object.freeze({
    schemaVersion: 1 as const,
    productVersion,
    sourceCommit,
    sourceDirty: false as const,
    tagName,
    tagObjectType: "annotated" as const,
    tagSignature: "verified" as const,
    tagTargetCommit,
    buildTimestamp,
    packageVersions
  });
}

function releaseBuildIdentity(
  evidence: ReleaseSourceEvidence,
  artifactTarget: BuiltArtifactTarget
): ReleaseBuildIdentity {
  const identity = parseBuildIdentity({
    schemaVersion: 1,
    product: "1667",
    productVersion: evidence.productVersion,
    buildKind: "release",
    sourceCommit: evidence.sourceCommit,
    sourceDirty: false,
    buildTimestamp: evidence.buildTimestamp,
    artifactTarget,
    apiProtocolVersion: HTTP_API_PROTOCOL_VERSION,
    minClientProtocolVersion: HTTP_MIN_CLIENT_PROTOCOL_VERSION,
    maxClientProtocolVersion: HTTP_MAX_CLIENT_PROTOCOL_VERSION
  });
  if (identity.buildKind !== "release") {
    throw new Error("Release identity codec returned a non-release identity");
  }
  return Object.freeze(identity);
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

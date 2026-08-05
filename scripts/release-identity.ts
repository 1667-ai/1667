import {
  HTTP_API_PROTOCOL_VERSION,
  HTTP_MAX_CLIENT_PROTOCOL_VERSION,
  HTTP_MIN_CLIENT_PROTOCOL_VERSION,
  BUILT_ARTIFACT_TARGETS,
  parseBuildIdentity,
  type BuildIdentity,
  type BuiltArtifactTarget
} from "../shared/build-identity.js";
import { type PackageBuildEvidence } from "../shared/package-build-manifest.js";
import { exactRecord } from "./release-boundary-validation.js";

export type ReleaseBuildIdentity = Extract<BuildIdentity, { buildKind: "release" }>;

export interface ReleasePackageVersions {
  root: string;
  tui: string;
  rootLock: string;
  rootLockPackage: string;
}

export function assertReleasePackageVersions(
  productVersion: string,
  packageVersions: ReleasePackageVersions
): void {
  for (const [label, version] of Object.entries(packageVersions)) {
    if (version !== productVersion) {
      throw new Error(`Release ${label} version does not match ${productVersion}`);
    }
  }
}

/**
 * `tagObjectType` and `tagSignature` describe the release tag as it actually
 * is, not as a fixed claim. There is no user of this product yet, and the
 * signing-key requirement that once forced `"annotated"` and `"verified"`
 * returns before there is one — see docs/RELEASING.md. A lightweight tag and
 * an unsigned tag are accepted release sources now, so both fields carry a
 * real answer instead of a literal that could describe a check nobody ran.
 */
interface ReleaseSourceEvidenceBase {
  schemaVersion: 1;
  productVersion: string;
  sourceCommit: string;
  sourceDirty: false;
  tagName: string;
  tagTargetCommit: string;
  buildTimestamp: string;
  packageVersions: ReleasePackageVersions;
}

type ReleaseTagEvidence =
  | { tagObjectType: "annotated"; tagSignature: "verified" | "unsigned" }
  | { tagObjectType: "lightweight"; tagSignature: "unsigned" };

export type ReleaseSourceEvidence = ReleaseSourceEvidenceBase & ReleaseTagEvidence;

export interface ReleaseBuildIdentitySet<
  Source extends PackageBuildEvidence = PackageBuildEvidence
> {
  schemaVersion: 1;
  source: Source;
  identities: readonly ReleaseBuildIdentity[];
}

export type ReleaseIdentitySet = ReleaseBuildIdentitySet<ReleaseSourceEvidence>;

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
  return createIdentitySet(parseSourceEvidence(value));
}

/** Builds release identities from facts that make no tag-authorization claim. */
export function createReleaseBuildIdentitySet(
  value: PackageBuildEvidence
): ReleaseBuildIdentitySet {
  const source = Object.freeze({
    productVersion: value.productVersion,
    sourceCommit: value.sourceCommit,
    buildTimestamp: value.buildTimestamp
  });
  return createIdentitySet(source);
}

function createIdentitySet<Source extends PackageBuildEvidence>(
  source: Source
): ReleaseBuildIdentitySet<Source> {
  const identities = BUILT_ARTIFACT_TARGETS.map((artifactTarget) => {
    return releaseBuildIdentity(source, artifactTarget);
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    source,
    identities: Object.freeze(identities)
  });
}

export function releaseIdentityForTarget(
  set: ReleaseBuildIdentitySet,
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
  const tagEvidence = parseTagEvidence(input.tagObjectType, input.tagSignature);

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

  return Object.freeze({
    schemaVersion: 1 as const,
    productVersion,
    sourceCommit,
    sourceDirty: false as const,
    tagName,
    ...tagEvidence,
    tagTargetCommit,
    buildTimestamp,
    packageVersions
  });
}

function parseTagEvidence(objectType: unknown, signature: unknown): ReleaseTagEvidence {
  if (objectType === "lightweight") {
    if (signature !== "unsigned") {
      if (signature === "verified") {
        throw new Error("A verified release tag signature requires an annotated tag");
      }
      throw new Error("Release tag signature must be verified or unsigned");
    }
    return Object.freeze({ tagObjectType: objectType, tagSignature: signature });
  }
  if (objectType !== "annotated") {
    throw new Error("Release source tag must be annotated or lightweight");
  }
  if (signature !== "verified" && signature !== "unsigned") {
    throw new Error("Release tag signature must be verified or unsigned");
  }
  return Object.freeze({ tagObjectType: objectType, tagSignature: signature });
}

function releaseBuildIdentity(
  source: PackageBuildEvidence,
  artifactTarget: BuiltArtifactTarget
): ReleaseBuildIdentity {
  const identity = parseBuildIdentity({
    schemaVersion: 1,
    product: "1667",
    productVersion: source.productVersion,
    buildKind: "release",
    sourceCommit: source.sourceCommit,
    sourceDirty: false,
    buildTimestamp: source.buildTimestamp,
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

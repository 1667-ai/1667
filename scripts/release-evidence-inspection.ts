import { isCanonicalTimestamp } from "../shared/build-identity.js";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import {
  createReleaseIdentitySet,
  type ReleasePackageVersions,
  type ReleaseSourceEvidence
} from "./release-identity.js";

/**
 * Interprets captured Git output. Nothing here runs a subprocess or touches the
 * filesystem, so every refusal below is reachable from a unit test that supplies
 * strings, and the module that actually invokes Git stays thin enough to read.
 * `test/release-evidence.test.ts` drives the structural refusals that way and
 * keeps the fixture repositories as the proof that a real annotated and a real
 * lightweight tag both resolve the way this module expects.
 *
 * This module never verifies a tag signature. There is no user of this product
 * yet, and the protection a signing key requires returns before there is one;
 * until then a release runs from an ordinary annotated or lightweight tag, and
 * the evidence says so plainly rather than asserting a check nobody ran.
 * `ReleaseSourceEvidence` still types `sourceDirty` as `false`, so that document
 * cannot describe a failure either — every bad state below is an exception
 * naming what was wrong, never a field.
 */

const COMMIT = /^[0-9a-f]{40}$/;
const RELEASE_TAG_NAME_PATTERN =
  "v(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?";
const RELEASE_TAG_NAME = new RegExp(`^${RELEASE_TAG_NAME_PATTERN}$`);
const MAX_DETAIL_CHARACTERS = 400;

/** One captured Git invocation. Non-zero exits are data, not thrown errors, so
 *  the interpreting half decides which failure the caller is told about. */
export interface CommandOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ReleaseTagObservations {
  readonly tagName: string;
  readonly protectedRef: string;
  readonly headCommit: CommandOutcome;
  readonly workingTreeStatus: CommandOutcome;
  readonly tagObjectType: CommandOutcome;
  readonly tagObjectContents: CommandOutcome;
  readonly tagTargetCommit: CommandOutcome;
  readonly protectedReachability: CommandOutcome;
}

export interface ReleaseEvidenceObservations
  extends ReleaseTagObservations {
  readonly buildTimestamp: string;
  readonly rootManifest: CommandOutcome;
  readonly tuiManifest: CommandOutcome;
  readonly rootLock: CommandOutcome;
}

/**
 * What this module can honestly say about a release tag without a signing key:
 * its shape, the commit it names, and that the release commit descends from
 * the protected default branch. `tagSignature` is always `"unsigned"` here.
 * The collector rejects an annotated tag that contains signature armor. Thus,
 * this value states an observed absence instead of the absence of a check.
 */
interface InspectedReleaseTag {
  readonly tagName: string;
  readonly sourceCommit: string;
  readonly tagObjectType: "annotated" | "lightweight";
  readonly tagSignature: "unsigned";
  readonly tagTargetCommit: string;
}

/**
 * Turns one round of captured Git output into the evidence document, or throws.
 * The order matters: cheap structural refusals run before the version
 * cross-check, so a broken release reports the thing a maintainer can act on
 * first.
 */
export function assembleReleaseSourceEvidence(
  observations: ReleaseEvidenceObservations
): ReleaseSourceEvidence {
  const tag = inspectReleaseTag(observations);
  const tagName = tag.tagName;
  const buildTimestamp = requireCanonicalTimestamp(observations.buildTimestamp);
  const sourceCommit = tag.sourceCommit;
  const tagTargetCommit = tag.tagTargetCommit;

  const packageVersions = parseReleasePackageVersions({
    rootManifest: successfulOutput(observations.rootManifest, "Release root package manifest"),
    tuiManifest: successfulOutput(observations.tuiManifest, "Release tui package manifest"),
    rootLock: successfulOutput(observations.rootLock, "Release root package lock")
  });
  if (tagName !== `v${packageVersions.root}`) {
    throw new Error(`Release tag ${tagName} does not match product version ${packageVersions.root}`);
  }

  // Round-tripping through the validator the release build consumes means the
  // producer cannot emit a document its own consumer would reject.
  const identities = createReleaseIdentitySet({
    schemaVersion: 1,
    productVersion: packageVersions.root,
    sourceCommit,
    sourceDirty: false,
    tagName,
    tagObjectType: tag.tagObjectType,
    tagSignature: tag.tagSignature,
    tagTargetCommit,
    buildTimestamp,
    packageVersions
  });
  return identities.source;
}

function inspectReleaseTag(
  observations: ReleaseTagObservations
): InspectedReleaseTag {
  const tagName = requireReleaseTagName(observations.tagName);
  const sourceCommit = requireObjectName(
    observations.headCommit,
    "Release source commit"
  );
  requireCleanWorkingTree(observations.workingTreeStatus);
  const tagObjectType = releaseTagObjectType(observations.tagObjectType, tagName);
  requireUnsignedTagObject(tagObjectType, observations.tagObjectContents, tagName);
  const tagTargetCommit = requireObjectName(
    observations.tagTargetCommit,
    `Release tag ${tagName} target commit`
  );
  if (tagTargetCommit !== sourceCommit) {
    throw new Error(
      `Release tag ${tagName} does not point at the release commit ${sourceCommit}`
    );
  }
  requireProtectedReachability(
    observations.protectedReachability,
    sourceCommit,
    observations.protectedRef
  );
  return Object.freeze({
    tagName,
    sourceCommit,
    tagObjectType,
    tagSignature: "unsigned",
    tagTargetCommit
  });
}

const TAG_SIGNATURE_ARMOR =
  /-----BEGIN (?:PGP (?:MESSAGE|SIGNATURE)|SSH SIGNATURE|SIGNED MESSAGE)-----/u;

/** Refuses signature-bearing annotated tags because this collector does not
 *  verify them. A lightweight tag has no tag object to inspect. */
function requireUnsignedTagObject(
  objectType: "annotated" | "lightweight",
  contents: CommandOutcome,
  tagName: string
): void {
  if (objectType === "lightweight") return;
  const tagObject = successfulOutput(contents, `Release tag ${tagName} object`);
  if (TAG_SIGNATURE_ARMOR.test(tagObject)) {
    throw new Error(
      `Release tag ${tagName} contains a signature that this collector does not verify`
    );
  }
}

/** Reads the tag's real shape instead of refusing anything but an annotated
 *  tag: `git cat-file -t <tag>` reports `tag` for an annotated tag object and
 *  `commit` for a lightweight tag, a ref pointing straight at the commit.
 *  Anything else names something that cannot be a release tag. */
function releaseTagObjectType(
  objectType: CommandOutcome,
  tagName: string
): "annotated" | "lightweight" {
  if (objectType.exitCode !== 0) {
    throw new Error(`Release tag ${tagName} could not be resolved: ${commandDetail(objectType)}`);
  }
  const kind = objectType.stdout.trim();
  if (kind === "tag") return "annotated";
  if (kind === "commit") return "lightweight";
  throw new Error(`Release tag ${tagName} is not a tag or commit object but a ${truncate(kind)}`);
}

export interface ReleaseManifestSources {
  readonly rootManifest: string;
  readonly tuiManifest: string;
  readonly rootLock: string;
}

/** Reads the four product versions and refuses any disagreement between them. */
export function parseReleasePackageVersions(
  sources: ReleaseManifestSources
): ReleasePackageVersions {
  const lock = jsonObject(sources.rootLock, "package-lock.json");
  const lockPackages = jsonRecord(lock.packages, "package-lock.json packages");
  const lockRootPackage = jsonRecord(lockPackages[""], "package-lock.json root package entry");
  const versions = {
    root: versionField(jsonObject(sources.rootManifest, "package.json").version, "package.json"),
    tui: versionField(jsonObject(sources.tuiManifest, "tui/package.json").version, "tui/package.json"),
    rootLock: versionField(lock.version, "package-lock.json"),
    rootLockPackage: versionField(lockRootPackage.version, "package-lock.json root package entry")
  };
  if (new Set(Object.values(versions)).size !== 1) {
    throw new Error(`Release package versions disagree: ${JSON.stringify(versions)}`);
  }
  return Object.freeze(versions);
}

export function requireReleaseTagName(value: string): string {
  if (!RELEASE_TAG_NAME.test(value)) {
    throw new Error(`Release tag name ${JSON.stringify(value)} must be v<semver>`);
  }
  return value;
}

/**
 * The npm release runs on the tag, so every provenance record names that tag
 * ref. A branch ref moves when a maintainer merges work afterward, which is
 * why a branch is not accepted here.
 */
export const RELEASE_TAG_REF = new RegExp(`^refs/tags/${RELEASE_TAG_NAME_PATTERN}$`);

export function requireReleaseTagRef(value: string): string {
  if (!RELEASE_TAG_REF.test(value)) {
    throw new Error(
      `Release source ref ${JSON.stringify(value)} must be refs/tags/v<semver>`
    );
  }
  return value;
}

/** The timestamp shared by every target in a release, validated by the same
 *  predicate the build identity it ends up inside is validated with. */
export function requireCanonicalTimestamp(value: string): string {
  if (!isCanonicalTimestamp(value)) {
    throw new Error(
      `Release build timestamp ${JSON.stringify(value)} must be a millisecond-precision UTC instant`
    );
  }
  return value;
}

/** A full object name from a successful `rev-parse`, so a short or symbolic
 *  answer never reaches the document or a later command line. */
export function requireObjectName(outcome: CommandOutcome, label: string): string {
  const value = successfulOutput(outcome, label).trim();
  if (!COMMIT.test(value)) throw new Error(`${label} is not a full object name`);
  return value;
}

function requireCleanWorkingTree(status: CommandOutcome): void {
  const porcelain = successfulOutput(status, "Release working tree status");
  if (porcelain.trim().length !== 0) {
    throw new Error(`Release source tree is dirty: ${truncate(porcelain.trim())}`);
  }
}

function requireProtectedReachability(
  reachability: CommandOutcome,
  sourceCommit: string,
  protectedRef: string
): void {
  if (reachability.exitCode !== 0) {
    throw new Error(
      `Release commit ${sourceCommit} is not reachable from protected ref ${protectedRef}: ${commandDetail(reachability)}`
    );
  }
}

function successfulOutput(outcome: CommandOutcome, label: string): string {
  if (outcome.exitCode !== 0) {
    throw new Error(`${label} could not be read: ${commandDetail(outcome)}`);
  }
  return outcome.stdout;
}

function jsonObject(text: string, label: string): Record<string, unknown> {
  return jsonRecord(parseJsonRejectingDuplicateKeys(text), label);
}

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function versionField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} has no version string`);
  }
  return value;
}

function commandDetail(outcome: CommandOutcome): string {
  const detail = `${outcome.stderr}\n${outcome.stdout}`.trim().replace(/\s*\n\s*/g, " / ");
  return `exit ${outcome.exitCode}${detail.length === 0 ? "" : ` ${truncate(detail)}`}`;
}

function truncate(value: string): string {
  return value.length <= MAX_DETAIL_CHARACTERS
    ? value
    : `${value.slice(0, MAX_DETAIL_CHARACTERS)}…`;
}

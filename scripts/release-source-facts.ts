import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSemVer } from "../shared/semver.js";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import {
  createReleaseIdentitySet,
  type ReleaseIdentitySet,
  type ReleaseSourceEvidence
} from "./release-identity.js";

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

export interface ReleaseSourceEvidenceInput extends ReleaseSourceFacts {
  readonly packageVersions: {
    readonly root: string;
    readonly tui: string;
    readonly rootLock: string;
    readonly rootLockPackage: string;
  };
}

/**
 * Source evidence for a GitHub pre-release build, constructed in memory and
 * never written to disk by anything in this repository.
 *
 * The evidence codec is shared with npm preflight, where publication cannot be
 * withdrawn and the trust anchor is a maintainer who ran `git verify-tag`
 * themselves; it therefore accepts `tagObjectType: "annotated"` with
 * `tagSignature: "verified"` and no other value. A GitHub pre-release anchors
 * somewhere else: the build-provenance attestation GitHub's Sigstore instance
 * issues over each archive, which binds the bytes to this workflow, this
 * repository, and this commit, and which `gh attestation verify` checks.
 *
 * Exactly what escapes this process, and what does not: no shipped file and no
 * line of the release notes carries `tagSignature` or `tagObjectType`, so the
 * signature claim never leaves memory. `tagName` does ship — the SPDX document
 * comments each package with `Built from tag <tagName> at a clean working
 * tree` — and that is not a signature claim: it names the tag the release job
 * creates at `sourceCommit`, which is true once `gh release create` runs. npm
 * publication still requires the signed-tag evidence documented in
 * docs/RELEASING.md, obtained by a maintainer rather than by this workflow.
 */
export function githubReleaseSourceEvidence(
  input: ReleaseSourceEvidenceInput
): ReleaseSourceEvidence {
  if (!isSemVer(input.version)) {
    throw new Error(`Release evidence needs a SemVer version, not ${input.version}`);
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    productVersion: input.version,
    sourceCommit: input.sourceCommit,
    sourceDirty: false as const,
    tagName: `v${input.version}`,
    tagObjectType: "annotated" as const,
    tagSignature: "verified" as const,
    tagTargetCommit: input.sourceCommit,
    buildTimestamp: input.buildTimestamp,
    packageVersions: Object.freeze({ ...input.packageVersions })
  });
}

/**
 * The release identities for one run, built in the process that needs them from
 * the three source facts and the package versions in this checkout.
 *
 * Every job in the release workflow calls this with the three strings the
 * `prepare` job published as job outputs. Do not "simplify" that into building
 * the evidence once, writing it to a file, and uploading the file for the build
 * matrix to download. `ReleaseSourceEvidence` types `tagObjectType` and
 * `tagSignature` as the literals `"annotated"` and `"verified"`, so every copy
 * of that document asserts a verified signed tag. Nothing in this workflow
 * verifies a signature, and when the facts are known the tag does not exist yet
 * — the release job creates it last. `scripts/release-preflight.ts` accepts
 * exactly this document as its signed-tag evidence, and that is the gate in
 * front of npm publication, which cannot be withdrawn. A downloadable artifact
 * would therefore hand anyone who can read a workflow run a ready-made
 * credential for that gate. The three strings assert nothing, so they may cross
 * a job boundary; the document they build may not.
 *
 * The facts come from `prepare` rather than being recomputed on each runner so
 * that every target in a run writes the same version, commit and timestamp into
 * its `build-manifest.json`: one build described once, not one build per runner
 * minutes apart.
 */
export function releaseIdentitiesForSource(facts: ReleaseSourceFacts): ReleaseIdentitySet {
  return createReleaseIdentitySet(githubReleaseSourceEvidence({
    version: facts.version,
    sourceCommit: facts.sourceCommit,
    buildTimestamp: facts.buildTimestamp,
    packageVersions: repositoryPackageVersions()
  }));
}

/**
 * The versions this checkout declares. The identity codec requires all four to
 * equal the dispatched version, which is what makes a mistyped dispatch fail in
 * `prepare` instead of shipping four archives that disagree with the source.
 */
export function repositoryPackageVersions(): ReleaseSourceEvidenceInput["packageVersions"] {
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

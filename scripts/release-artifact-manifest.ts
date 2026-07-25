import { createHash } from "node:crypto";
import { canonicalJson } from "../server/canonical-json.js";
import {
  parseBuildIdentity,
  type PackagedArtifactTarget
} from "../shared/build-identity.js";
import {
  type ReleaseBuildIdentity,
  type ReleaseIdentitySet
} from "./release-identity.js";
import {
  exactRecord,
  sha256Digest
} from "./release-boundary-validation.js";
import {
  RELEASE_LAUNCHER_PACKAGE,
  assertPackageIdentityAgreement,
  tarballFile,
  validateReleasePackageMatrix,
  validateReleaseTarballInspection,
  type ReleaseLauncherManifest,
  type ReleasePackageManifest,
  type ReleasePlatformManifest
} from "./release-package-policy.js";

export interface ReleaseDigestRecord {
  sha256: string;
  bytes: number;
}

export interface ReleasePackageArtifactInput {
  packageJson: {
    manifest: unknown;
    sha256: string;
  };
  tarball: ReleaseDigestRecord;
  tarEntries: unknown;
  buildManifest: ReleaseDigestRecord;
  sbom: ReleaseDigestRecord;
  buildIdentity: unknown | null;
}

interface ReleaseArtifactRecordBase {
  name: string;
  version: string;
  packageJsonSha256: string;
  tarball: ReleaseDigestRecord;
  buildManifest: ReleaseDigestRecord;
  sbom: ReleaseDigestRecord;
}

export interface ReleaseLauncherArtifactRecord extends ReleaseArtifactRecordBase {
  target: "launcher";
  buildIdentity: null;
}

export interface ReleasePlatformArtifactRecord extends ReleaseArtifactRecordBase {
  target: PackagedArtifactTarget;
  buildIdentity: ReleaseBuildIdentity;
}

export type ReleaseArtifactRecord =
  | ReleaseLauncherArtifactRecord
  | ReleasePlatformArtifactRecord;

export interface ReleaseArtifactManifest {
  schemaVersion: 1;
  product: "1667";
  productVersion: string;
  sourceTag: string;
  sourceCommit: string;
  buildTimestamp: string;
  artifacts: readonly ReleaseArtifactRecord[];
}

export interface FormattedReleaseArtifactManifest {
  manifest: ReleaseArtifactManifest;
  text: string;
  sha256: string;
}

const ARTIFACT_KEYS = new Set([
  "packageJson",
  "tarball",
  "tarEntries",
  "buildManifest",
  "sbom",
  "buildIdentity"
]);
const PACKAGE_JSON_KEYS = new Set(["manifest", "sha256"]);
const DIGEST_RECORD_KEYS = new Set(["sha256", "bytes"]);
const MAX_TARBALL_BYTES = 320 * 1024 * 1024;

/**
 * Produces canonical, hash-addressed release evidence from non-extracting
 * tarball inspections. It performs no build, archive extraction, or network
 * operation, making the same validation usable in local and hosted runners.
 */
export function createReleaseArtifactManifest(
  identities: ReleaseIdentitySet,
  values: readonly unknown[]
): FormattedReleaseArtifactManifest {
  const inputs = values.map(parseArtifactInput);
  const packageMatrix = validateReleasePackageMatrix(
    inputs.map((input) => input.packageJson.manifest),
    identities
  );
  const byName = new Map(inputs.map((input) => {
    const name = packageName(input.packageJson.manifest);
    return [name, input] as const;
  }));
  if (byName.size !== inputs.length) throw new Error("Release artifacts repeat a package");

  const launcherInput = requiredArtifact(byName, RELEASE_LAUNCHER_PACKAGE);
  const artifacts: ReleaseArtifactRecord[] = [
    validateArtifact(packageMatrix.launcher, launcherInput, identities)
  ];
  for (const manifest of packageMatrix.platforms) {
    artifacts.push(validateArtifact(
      manifest,
      requiredArtifact(byName, manifest.name),
      identities
    ));
  }
  if (byName.size !== artifacts.length) throw new Error("Release artifacts contain an unknown package");

  const manifest = deepFreeze({
    schemaVersion: 1 as const,
    product: "1667" as const,
    productVersion: identities.evidence.productVersion,
    sourceTag: identities.evidence.tagName,
    sourceCommit: identities.evidence.sourceCommit,
    buildTimestamp: identities.evidence.buildTimestamp,
    artifacts
  });
  const text = canonicalJson(manifest);
  return Object.freeze({
    manifest,
    text,
    sha256: sha256(text)
  });
}

function validateArtifact(
  manifest: ReleaseLauncherManifest,
  input: ParsedArtifactInput,
  identities: ReleaseIdentitySet
): ReleaseLauncherArtifactRecord;
function validateArtifact(
  manifest: ReleasePlatformManifest,
  input: ParsedArtifactInput,
  identities: ReleaseIdentitySet
): ReleasePlatformArtifactRecord;
function validateArtifact(
  manifest: ReleasePackageManifest,
  input: ParsedArtifactInput,
  identities: ReleaseIdentitySet
): ReleaseArtifactRecord {
  const tarball = digestRecord(input.tarball, `${manifest.name} tarball`, MAX_TARBALL_BYTES);
  const buildManifest = digestRecord(
    input.buildManifest,
    `${manifest.name} build manifest`,
    1024 * 1024
  );
  const sbom = digestRecord(input.sbom, `${manifest.name} SBOM`, 8 * 1024 * 1024);
  const inspection = validateReleaseTarballInspection(input.tarEntries, manifest);
  if (inspection.packageJsonSha256 !== input.packageJson.sha256) {
    throw new Error(`${manifest.name} package.json evidence does not match its tarball`);
  }
  assertEmbeddedFile(buildManifest, tarballFile(inspection, "build-manifest.json"));
  assertEmbeddedFile(sbom, tarballFile(inspection, "sbom.spdx.json"));

  if (manifest.kind === "launcher") {
    if (input.buildIdentity !== null) {
      throw new Error("The JavaScript launcher must not claim a native build identity");
    }
    return deepFreeze({
      name: manifest.name,
      target: "launcher" as const,
      version: manifest.version,
      packageJsonSha256: input.packageJson.sha256,
      tarball,
      buildManifest,
      sbom,
      buildIdentity: null
    });
  }

  if (input.buildIdentity === null) {
    throw new Error(`${manifest.name} is missing its embedded build identity`);
  }
  const buildIdentity = parseBuildIdentity(input.buildIdentity);
  if (buildIdentity.buildKind !== "release") {
    throw new Error(`${manifest.name} embeds a non-release identity`);
  }
  assertPackageIdentityAgreement(identities, manifest.target, buildIdentity);

  return deepFreeze({
    name: manifest.name,
    target: manifest.target,
    version: manifest.version,
    packageJsonSha256: input.packageJson.sha256,
    tarball,
    buildManifest,
    sbom,
    buildIdentity
  });
}

interface ParsedArtifactInput {
  packageJson: { manifest: unknown; sha256: string };
  tarball: unknown;
  tarEntries: unknown;
  buildManifest: unknown;
  sbom: unknown;
  buildIdentity: unknown | null;
}

function parseArtifactInput(value: unknown): ParsedArtifactInput {
  const input = exactRecord(value, ARTIFACT_KEYS, "Release artifact");
  const packageJson = exactRecord(input.packageJson, PACKAGE_JSON_KEYS, "Artifact package.json");
  return {
    packageJson: {
      manifest: packageJson.manifest,
      sha256: sha256Digest(packageJson.sha256, "Artifact package.json")
    },
    tarball: input.tarball,
    tarEntries: input.tarEntries,
    buildManifest: input.buildManifest,
    sbom: input.sbom,
    buildIdentity: input.buildIdentity
  };
}

function digestRecord(value: unknown, label: string, maximumBytes: number): ReleaseDigestRecord {
  const input = exactRecord(value, DIGEST_RECORD_KEYS, label);
  const bytes = input.bytes;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0
    || bytes > maximumBytes) {
    throw new Error(`${label} has an invalid size`);
  }
  return Object.freeze({
    sha256: sha256Digest(input.sha256, label),
    bytes
  });
}

function assertEmbeddedFile(
  expected: ReleaseDigestRecord,
  entry: { sha256: string | null; size: number }
): void {
  if (entry.sha256 !== expected.sha256 || entry.size !== expected.bytes) {
    throw new Error("Embedded release metadata does not match its tarball entry");
  }
}

function requiredArtifact(
  byName: ReadonlyMap<string, ParsedArtifactInput>,
  name: string
): ParsedArtifactInput {
  const artifact = byName.get(name);
  if (artifact === undefined) throw new Error(`Release artifacts are missing ${name}`);
  return artifact;
}

function packageName(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || typeof (value as Record<string, unknown>).name !== "string") {
    throw new Error("Release artifact package manifest has no name");
  }
  return (value as Record<string, unknown>).name as string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

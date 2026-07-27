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
  type ReleasePlatformManifest,
  type ReleaseTarballInspection
} from "./release-package-policy.js";

export interface ReleaseDigestRecord {
  sha256: string;
  bytes: number;
}

export interface ReleasePackageArtifactInput {
  packageJson: unknown;
  tarball: ReleaseDigestRecord;
  tarEntries: unknown;
  buildIdentity: unknown | null;
}

interface ReleaseArtifactRecordBase {
  name: string;
  version: string;
  packageJsonSha256: string;
  tarball: ReleaseDigestRecord;
  buildManifest: ReleaseDigestRecord;
  sbom: ReleaseDigestRecord;
  license: ReleaseDigestRecord;
  notice: ReleaseDigestRecord;
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
  "buildIdentity"
]);
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
    inputs.map((input) => input.packageJson),
    identities
  );
  const byName = new Map(inputs.map((input) => {
    return [packageName(input.packageJson), input] as const;
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
  const inspection = validateReleaseTarballInspection(input.tarEntries, manifest);
  const buildManifest = fileDigest(inspection, "build-manifest.json");
  const sbom = fileDigest(inspection, "sbom.spdx.json");
  const license = fileDigest(inspection, "LICENSE");
  const notice = fileDigest(inspection, "NOTICE");

  if (manifest.kind === "launcher") {
    if (input.buildIdentity !== null) {
      throw new Error("The JavaScript launcher must not claim a native build identity");
    }
    return deepFreeze({
      name: manifest.name,
      target: "launcher" as const,
      version: manifest.version,
      packageJsonSha256: inspection.packageJsonSha256,
      tarball,
      buildManifest,
      sbom,
      license,
      notice,
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
    packageJsonSha256: inspection.packageJsonSha256,
    tarball,
    buildManifest,
    sbom,
    license,
    notice,
    buildIdentity
  });
}

interface ParsedArtifactInput {
  packageJson: unknown;
  tarball: unknown;
  tarEntries: unknown;
  buildIdentity: unknown | null;
}

function parseArtifactInput(value: unknown): ParsedArtifactInput {
  const input = exactRecord(value, ARTIFACT_KEYS, "Release artifact");
  return {
    packageJson: input.packageJson,
    tarball: input.tarball,
    tarEntries: input.tarEntries,
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

/**
 * Reports a file the validated inspection already covers. The inspection is the
 * single source for what the tarball holds, so the emitted record cannot drift
 * from the archive it describes, and the entry is bounded and digest-checked by
 * release package policy before it reaches here.
 */
function fileDigest(
  inspection: ReleaseTarballInspection,
  relativePath: string
): ReleaseDigestRecord {
  const entry = tarballFile(inspection, relativePath);
  if (entry.sha256 === null) throw new Error("Tarball file is missing its digest");
  return Object.freeze({
    sha256: entry.sha256,
    bytes: entry.size
  });
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

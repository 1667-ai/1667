import {
  sameBuildIdentity
} from "../shared/build-identity.js";
import {
  PACKAGED_ARTIFACT_TARGETS,
  RELEASE_LAUNCHER_PACKAGE,
  RELEASE_PACKAGE_COUNT,
  releaseTargetForArtifact,
  releaseTargetForPackage,
  type PackagedArtifactTarget
} from "../shared/release-targets.js";
import {
  releaseIdentityForTarget,
  type ReleaseIdentitySet
} from "./release-identity.js";
import {
  createReleaseLauncherManifest,
  createReleasePlatformManifest,
  releasePackageJson,
  RELEASE_LICENSE_FILES,
  RELEASE_LICENSE_FILE_DIGESTS,
  type ReleaseLauncherManifest,
  type ReleasePackageManifest,
  type ReleasePlatformManifest
} from "./release-package-manifests.js";
import {
  exactRecord,
  sha256Digest
} from "./release-boundary-validation.js";

export {
  RELEASE_LAUNCHER_PACKAGE
} from "../shared/release-targets.js";
export type {
  ReleaseLauncherManifest,
  ReleasePackageManifest,
  ReleasePlatformManifest
} from "./release-package-manifests.js";
export const MAX_RELEASE_TARBALL_ENTRIES = 16;
export const MAX_RELEASE_TARBALL_FILE_BYTES = 272 * 1024 * 1024;

export interface ReleasePackageMatrix {
  version: string;
  launcher: ReleaseLauncherManifest;
  platforms: readonly ReleasePlatformManifest[];
}

export type TarballInspectionEntry = Readonly<{
  path: string;
  type: "file" | "directory";
  mode: number;
  size: number;
  sha256: string | null;
}>;

export interface ReleaseTarballInspection {
  packageName: string;
  packageJsonSha256: string;
  entries: readonly TarballInspectionEntry[];
  totalFileBytes: number;
}

const TARBALL_KEYS = new Set(["packageJsonSha256", "entries"]);
const ENTRY_KEYS = new Set(["path", "type", "mode", "size", "sha256"]);

export function validateReleasePackageMatrix(
  values: readonly unknown[],
  identities: ReleaseIdentitySet
): ReleasePackageMatrix {
  if (values.length !== RELEASE_PACKAGE_COUNT) {
    throw new Error("Release package matrix must contain one launcher and every platform");
  }
  const parsed = values.map((value) => parseReleasePackageManifest(
    value,
    identities.evidence.productVersion
  ));
  const byName = new Map<string, ReleasePackageManifest>();
  for (const manifest of parsed) {
    if (byName.has(manifest.name)) throw new Error(`Duplicate release package ${manifest.name}`);
    byName.set(manifest.name, manifest);
  }
  const launcher = byName.get(RELEASE_LAUNCHER_PACKAGE);
  if (launcher?.kind !== "launcher") throw new Error("Release package matrix has no launcher");

  const platforms = PACKAGED_ARTIFACT_TARGETS.map((target) => {
    const descriptor = releaseTargetForArtifact(target);
    const manifest = byName.get(descriptor.packageName);
    if (manifest?.kind !== "platform" || manifest.target !== target) {
      throw new Error(`Release package matrix is missing ${descriptor.packageName}`);
    }
    const identity = releaseIdentityForTarget(identities, target);
    if (identity.productVersion !== manifest.version || identity.artifactTarget !== target) {
      throw new Error(`Release package and build identity disagree for ${target}`);
    }
    return manifest;
  });
  if (byName.size !== RELEASE_PACKAGE_COUNT) {
    throw new Error("Release package matrix contains an unsupported package");
  }
  return Object.freeze({
    version: identities.evidence.productVersion,
    launcher,
    platforms: Object.freeze(platforms)
  });
}

export function parseReleasePackageManifest(
  value: unknown,
  expectedVersion: string
): ReleasePackageManifest {
  const name = recordName(value);
  if (name === RELEASE_LAUNCHER_PACKAGE) {
    return parseLauncherManifest(value, expectedVersion);
  }
  const target = targetForPackageName(name);
  if (target === null) throw new Error(`Unsupported release package ${name}`);
  return parsePlatformManifest(value, expectedVersion, target);
}

export function validateReleaseTarballInspection(
  value: unknown,
  manifest: ReleasePackageManifest
): ReleaseTarballInspection {
  const input = exactRecord(value, TARBALL_KEYS, `${manifest.name} tarball inspection`);
  const packageJsonSha256 = sha256Digest(input.packageJsonSha256, "package.json");
  if (!Array.isArray(input.entries)) throw new Error("Tarball entries must be an array");
  if (input.entries.length === 0 || input.entries.length > MAX_RELEASE_TARBALL_ENTRIES) {
    throw new Error("Tarball entry count is outside the release bound");
  }

  const expectedFiles = new Set([
    "package/package.json",
    ...manifest.files.map((path) => `package/${path}`)
  ]);
  const expectedDirectories = new Set(["package", "package/bin"]);
  const entries = input.entries.map(parseTarballEntry);
  const paths = new Set<string>();
  let totalFileBytes = 0;
  for (const entry of entries) {
    if (paths.has(entry.path)) throw new Error(`Tarball repeats ${entry.path}`);
    paths.add(entry.path);
    if (entry.type === "directory") {
      if (!expectedDirectories.has(entry.path)) {
        throw new Error(`Tarball contains undeclared directory ${entry.path}`);
      }
      continue;
    }
    if (!expectedFiles.has(entry.path)) {
      throw new Error(`Tarball contains undeclared file ${entry.path}`);
    }
    assertEntryPolicy(entry, manifest);
    totalFileBytes += entry.size;
    if (totalFileBytes > MAX_RELEASE_TARBALL_FILE_BYTES) {
      throw new Error("Tarball file bytes exceed the release bound");
    }
  }
  for (const expected of expectedFiles) {
    if (!paths.has(expected)) throw new Error(`Tarball is missing ${expected}`);
  }
  const packageJsonEntry = entries.find((entry) => entry.path === "package/package.json");
  if (packageJsonEntry?.sha256 !== packageJsonSha256) {
    throw new Error("Parsed package manifest is not bound to the tarball package.json");
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return Object.freeze({
    packageName: manifest.name,
    packageJsonSha256,
    entries: Object.freeze(entries),
    totalFileBytes
  });
}

export function tarballFile(
  inspection: ReleaseTarballInspection,
  relativePath: string
): TarballInspectionEntry {
  const entry = inspection.entries.find((candidate) => {
    return candidate.type === "file" && candidate.path === `package/${relativePath}`;
  });
  if (entry === undefined) throw new Error(`${inspection.packageName} is missing ${relativePath}`);
  return entry;
}

function parseLauncherManifest(value: unknown, expectedVersion: string): ReleaseLauncherManifest {
  const expected = createReleaseLauncherManifest(expectedVersion);
  const input = exactRecord(
    value,
    new Set(Object.keys(releasePackageJson(expected))),
    "Release launcher manifest"
  );
  commonManifest(input, expected);
  if (input.type !== expected.type) throw new Error("Release launcher must be an ES module");
  exactStringRecord(input.bin, expected.bin, "Release launcher bin");
  exactStringArray(input.files, expected.files, "Release launcher files");
  exactStringRecord(
    input.optionalDependencies,
    expected.optionalDependencies,
    "Release launcher optional dependencies"
  );
  return expected;
}

function parsePlatformManifest(
  value: unknown,
  expectedVersion: string,
  target: PackagedArtifactTarget
): ReleasePlatformManifest {
  const expected = createReleasePlatformManifest(target, expectedVersion);
  const input = exactRecord(
    value,
    new Set(Object.keys(releasePackageJson(expected))),
    `Release ${target} manifest`
  );
  commonManifest(input, expected);
  exactStringArray(input.os, expected.os, `${target} os`);
  exactStringArray(input.cpu, expected.cpu, `${target} cpu`);
  if (expected.libc !== null) {
    exactStringArray(input.libc, [expected.libc], `${target} libc`);
  }
  exactStringArray(input.files, expected.files, `${target} files`);
  return expected;
}

function commonManifest(
  input: Record<string, unknown>,
  expected: ReleasePackageManifest
): void {
  if (input.name !== expected.name) throw new Error(`Release package must be named ${expected.name}`);
  if (input.version !== expected.version) throw new Error(`${expected.name} has the wrong version`);
  if (input.private !== expected.private) throw new Error(`${expected.name} must be explicitly public`);
  if (input.license !== expected.license) {
    throw new Error(`${expected.name} must declare the ${expected.license} licence`);
  }
  exactStringRecord(
    input.repository,
    expected.repository,
    `${expected.name} repository`
  );
  exactStringRecord(
    input.publishConfig,
    expected.publishConfig,
    `${expected.name} publishConfig`
  );
}

function parseTarballEntry(value: unknown): TarballInspectionEntry {
  const input = exactRecord(value, ENTRY_KEYS, "Tarball entry");
  if (typeof input.path !== "string" || input.path.length === 0 || Buffer.byteLength(input.path) > 256) {
    throw new Error("Tarball entry path is invalid");
  }
  if (input.path.includes("\\") || /(^|\/)\.\.?($|\/)/u.test(input.path)
    || /[\u0000-\u001f\u007f]/u.test(input.path)) {
    throw new Error(`Tarball entry path is unsafe: ${input.path}`);
  }
  if (input.type !== "file" && input.type !== "directory") {
    throw new Error("Tarball entry type must be file or directory");
  }
  if (typeof input.mode !== "number" || !Number.isInteger(input.mode)) {
    throw new Error("Tarball entry mode must be an integer");
  }
  if (typeof input.size !== "number" || !Number.isSafeInteger(input.size) || input.size < 0) {
    throw new Error("Tarball entry size is invalid");
  }
  if (input.type === "directory") {
    if (input.mode !== 0o755 || input.size !== 0 || input.sha256 !== null) {
      throw new Error("Tarball directory metadata is invalid");
    }
  } else if (input.sha256 === null) {
    throw new Error("Tarball file is missing its digest");
  }
  const sha256 = input.sha256 === null ? null : sha256Digest(input.sha256, input.path);
  return Object.freeze({
    path: input.path,
    type: input.type,
    mode: input.mode,
    size: input.size,
    sha256
  });
}

function assertEntryPolicy(
  entry: TarballInspectionEntry,
  manifest: ReleasePackageManifest
): void {
  const target = manifest.kind === "launcher"
    ? null
    : releaseTargetForArtifact(manifest.target);
  const executable = target === null
    ? "package/bin/1667.js"
    : `package/${target.executable}`;
  const expectedMode = entry.path === executable && target?.platform !== "win32"
    ? 0o755
    : 0o644;
  if (entry.mode !== expectedMode) throw new Error(`${entry.path} has an unsafe mode`);
  if (entry.size === 0) throw new Error(`${entry.path} must not be empty`);
  const maximum = entry.path === executable
    ? (manifest.kind === "launcher" ? 128 * 1024 : 256 * 1024 * 1024)
    : entry.path.endsWith("/sbom.spdx.json")
      ? 8 * 1024 * 1024
      : 1024 * 1024;
  if (entry.size > maximum) throw new Error(`${entry.path} exceeds its size bound`);
  assertLicenceFileDigest(entry);
}

/**
 * Binds the staged licence files to the exact bytes the project publishes under.
 * Every package stages the same repository-root LICENSE and NOTICE, so a
 * substituted or truncated copy applied to all five leaves the packages in
 * agreement with each other and with themselves; only a pinned digest rejects
 * it, and shipping an invalid licence to a registry is not reversible.
 */
function assertLicenceFileDigest(entry: TarballInspectionEntry): void {
  for (const name of RELEASE_LICENSE_FILES) {
    if (entry.path !== `package/${name}`) continue;
    const pinned = RELEASE_LICENSE_FILE_DIGESTS[name];
    if (entry.sha256 !== pinned.sha256 || entry.size !== pinned.bytes) {
      throw new Error(`${entry.path} is not the reviewed ${name} file`);
    }
  }
}

function targetForPackageName(name: string): PackagedArtifactTarget | null {
  return releaseTargetForPackage(name)?.artifactTarget ?? null;
}

function recordName(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Release package manifest must be an object");
  }
  const name = (value as Record<string, unknown>).name;
  if (typeof name !== "string") throw new Error("Release package manifest has no name");
  return name;
}

function exactStringArray(value: unknown, expected: readonly string[], label: string): void {
  if (!Array.isArray(value) || value.length !== expected.length
    || value.some((entry, index) => entry !== expected[index])) {
    throw new Error(`${label} does not match the release policy`);
  }
}

function exactStringRecord(
  value: unknown,
  expected: Readonly<Record<string, string>>,
  label: string
): void {
  const expectedKeys = Object.keys(expected);
  const record = exactRecord(value, new Set(expectedKeys), label);
  for (const key of expectedKeys) {
    if (record[key] !== expected[key]) throw new Error(`${label} has an invalid ${key}`);
  }
}

export function assertPackageIdentityAgreement(
  set: ReleaseIdentitySet,
  target: PackagedArtifactTarget,
  observed: ReleaseBuildIdentityLike
): void {
  const expected = releaseIdentityForTarget(set, target);
  if (!sameBuildIdentity(expected, observed)) {
    throw new Error(`Embedded build identity disagrees for ${target}`);
  }
}

type ReleaseBuildIdentityLike = Parameters<typeof sameBuildIdentity>[1];

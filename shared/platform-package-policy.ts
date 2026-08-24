import {
  parsePackageBuildManifest,
  type PackageBuildManifest
} from "./package-build-manifest.js";
import {
  MAX_RELEASE_EXECUTABLE_BYTES,
  MAX_RELEASE_ARTIFACT_ENTRIES,
  MAX_RELEASE_ARTIFACT_TAR_BYTES
} from "./release-artifact-bounds.js";
import {
  MAX_RELEASE_SBOM_BYTES,
  RELEASE_LICENSE,
  RELEASE_LICENSE_FILES,
  RELEASE_PACKAGE_REPOSITORY,
  type TarballEntry
} from "./release-package-layout.js";
import {
  releaseTargetForArtifact,
  releaseTargetForPackage,
  type BuiltArtifactTarget,
  type PublishedPlatformPackage
} from "./release-targets.js";
import { isSemVer } from "./semver.js";

export interface ValidatedPlatformPackage {
  readonly packageName: PublishedPlatformPackage;
  readonly version: string;
  readonly artifactTarget: BuiltArtifactTarget;
  readonly packageExecutablePath: string;
  readonly entries: readonly TarballEntry[];
  readonly packageManifest: Record<string, unknown>;
  readonly buildManifest: PackageBuildManifest<BuiltArtifactTarget>;
  readonly executableSha256: string;
  readonly executableBytes: number;
}

/**
 * Validates a platform package inspection against the same entry policy used by
 * release preflight: exact paths, modes, manifests, and bounds. Reviewed
 * licence-file digests belong to release/build-time validation; an installed
 * updater must accept a later release that changes NOTICE or LICENSE.
 */
export function validatePlatformPackageInspection(input: {
  readonly packageName: PublishedPlatformPackage;
  readonly version: string;
  readonly packageManifest: unknown;
  readonly buildManifest: unknown;
  readonly entries: readonly TarballEntry[];
}): ValidatedPlatformPackage {
  if (!isSemVer(input.version)) throw new Error("Platform package version is not SemVer");
  const descriptor = releaseTargetForPackage(input.packageName);
  if (descriptor === null || descriptor.heldFromPublication !== null) {
    throw new Error("Platform package is not a published release target");
  }
  const artifactTarget = descriptor.artifactTarget;
  const packageExecutablePath = `package/${descriptor.executable}`;
  if (input.entries.length === 0 || input.entries.length > MAX_RELEASE_ARTIFACT_ENTRIES) {
    throw new Error("Tarball entry count is outside the release bound");
  }
  const expectedFiles = new Set([
    "package/package.json",
    `package/${descriptor.executable}`,
    "package/build-manifest.json",
    "package/sbom.spdx.json",
    ...RELEASE_LICENSE_FILES.map((name) => `package/${name}`)
  ]);
  const expectedDirectories = new Set(["package", "package/bin"]);
  const paths = new Set<string>();
  let totalFileBytes = 0;
  for (const entry of input.entries) {
    assertEntryShape(entry);
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
    assertEntryPolicy(entry, packageExecutablePath, descriptor.executable.endsWith(".exe") === false);
    totalFileBytes += entry.size;
    if (totalFileBytes > MAX_RELEASE_ARTIFACT_TAR_BYTES) {
      throw new Error("Tarball file bytes exceed the release bound");
    }
  }
  for (const expected of expectedFiles) {
    if (!paths.has(expected)) throw new Error(`Tarball is missing ${expected}`);
  }
  const packageManifest = validatePlatformPackageJson(
    input.packageManifest,
    input.packageName,
    input.version,
    artifactTarget
  );
  const buildManifest = parsePackageBuildManifest(input.buildManifest, {
    packageName: input.packageName,
    productVersion: input.version,
    artifactTarget
  });
  const executable = input.entries.find((entry) => {
    return entry.type === "file" && entry.path === packageExecutablePath;
  });
  if (executable?.sha256 === null || executable === undefined) {
    throw new Error("Platform package executable is missing");
  }
  return Object.freeze({
    packageName: input.packageName,
    version: input.version,
    artifactTarget,
    packageExecutablePath,
    entries: Object.freeze([...input.entries].sort((a, b) => a.path.localeCompare(b.path, "en"))),
    packageManifest,
    buildManifest,
    executableSha256: executable.sha256,
    executableBytes: executable.size
  });
}

function validatePlatformPackageJson(
  value: unknown,
  packageName: string,
  version: string,
  target: BuiltArtifactTarget
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Package manifest must be an object");
  }
  const input = value as Record<string, unknown>;
  const descriptor = releaseTargetForArtifact(target);
  const expectedKeys = descriptor.libc === null
    ? [
        "name",
        "version",
        "private",
        "os",
        "cpu",
        "files",
        "repository",
        "license",
        "publishConfig"
      ]
    : [
        "name",
        "version",
        "private",
        "os",
        "cpu",
        "libc",
        "files",
        "repository",
        "license",
        "publishConfig"
      ];
  const keys = Object.keys(input);
  if (keys.length !== expectedKeys.length
    || expectedKeys.some((key) => !Object.hasOwn(input, key))
    || keys.some((key) => !expectedKeys.includes(key))) {
    throw new Error("Package manifest has unknown or missing fields");
  }
  if (input.name !== packageName) throw new Error("Package manifest name is invalid");
  if (input.version !== version) throw new Error("Package manifest version is invalid");
  if (input.private !== false) throw new Error("Package manifest must be public");
  if (input.license !== RELEASE_LICENSE) throw new Error("Package manifest licence is invalid");
  exactStringArray(input.os, [descriptor.platform], "os");
  exactStringArray(input.cpu, [descriptor.arch], "cpu");
  if (descriptor.libc === null) {
    // libc key is already rejected by the exact key set above.
  } else {
    exactStringArray(input.libc, [descriptor.libc], "libc");
  }
  exactStringArray(input.files, [
    descriptor.executable,
    "build-manifest.json",
    "sbom.spdx.json",
    ...RELEASE_LICENSE_FILES
  ], "files");
  exactStringRecord(input.repository, RELEASE_PACKAGE_REPOSITORY, "repository");
  exactStringRecord(input.publishConfig, { access: "public" }, "publishConfig");
  return input;
}

function assertEntryShape(entry: TarballEntry): void {
  if (entry.path.length === 0 || Buffer.byteLength(entry.path) > 256) {
    throw new Error("Tarball entry path is invalid");
  }
  if (entry.path.includes("\\") || /(^|\/)\.\.?($|\/)/u.test(entry.path)
    || entry.path.startsWith("/") || /[\u0000-\u001f\u007f]/u.test(entry.path)) {
    throw new Error(`Tarball entry path is unsafe: ${entry.path}`);
  }
  if (entry.type === "directory") {
    if (entry.mode !== 0o755 || entry.size !== 0 || entry.sha256 !== null) {
      throw new Error("Tarball directory metadata is invalid");
    }
  } else if (entry.sha256 === null || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
    throw new Error("Tarball file is missing its digest");
  }
}

function assertEntryPolicy(
  entry: TarballEntry,
  packageExecutablePath: string,
  executableExecutable: boolean
): void {
  const expectedMode = entry.path === packageExecutablePath && executableExecutable
    ? 0o755
    : 0o644;
  if (entry.mode !== expectedMode) throw new Error(`${entry.path} has an unsafe mode`);
  if (entry.size === 0) throw new Error(`${entry.path} must not be empty`);
  const maximum = entry.path === packageExecutablePath
    ? MAX_RELEASE_EXECUTABLE_BYTES
    : entry.path.endsWith("/sbom.spdx.json")
      ? MAX_RELEASE_SBOM_BYTES
      : 1024 * 1024;
  if (entry.size > maximum) throw new Error(`${entry.path} exceeds its size bound`);
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
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const expectedKeys = Object.keys(expected);
  if (keys.length !== expectedKeys.length || keys.some((key) => !Object.hasOwn(expected, key))) {
    throw new Error(`${label} has unknown or missing fields`);
  }
  for (const key of expectedKeys) {
    if (record[key] !== expected[key]) throw new Error(`${label} has an invalid ${key}`);
  }
}

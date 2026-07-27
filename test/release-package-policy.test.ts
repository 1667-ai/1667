import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  PACKAGED_ARTIFACT_TARGETS,
  type PackagedArtifactTarget
} from "../shared/build-identity.js";
import {
  RELEASE_LAUNCHER_PACKAGE,
  releasePlatformDependencyGraph,
  releaseTargetForArtifact
} from "../shared/release-targets.js";
import { createReleaseIdentitySet } from "../scripts/release-identity.js";
import { RELEASE_PACKAGE_REPOSITORY } from "../scripts/release-package-manifests.js";
import {
  parseReleasePackageManifest,
  tarballFile,
  validateReleasePackageMatrix,
  validateReleaseTarballInspection
} from "../scripts/release-package-policy.js";

const VERSION = "2.0.0";
const PLATFORM_PACKAGE = releaseTargetForArtifact("linux-x64").packageName;
const identities = createReleaseIdentitySet({
  schemaVersion: 1,
  productVersion: VERSION,
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
  sourceDirty: false,
  tagName: `v${VERSION}`,
  tagObjectType: "annotated",
  tagSignature: "verified",
  tagTargetCommit: "0123456789abcdef0123456789abcdef01234567",
  buildTimestamp: "2026-07-23T10:20:30.000Z",
  packageVersions: {
    root: VERSION,
    tui: VERSION,
    rootLock: VERSION,
    rootLockPackage: VERSION
  }
});

test("release package matrix pins every platform as an exact optional dependency", () => {
  const values = [launcherManifest(), ...PACKAGED_ARTIFACT_TARGETS.map(platformManifest)];
  const matrix = validateReleasePackageMatrix(values, identities);
  assert.equal(matrix.launcher.name, RELEASE_LAUNCHER_PACKAGE);
  assert.deepEqual(
    matrix.platforms.map((manifest) => manifest.target),
    PACKAGED_ARTIFACT_TARGETS
  );
  assert.deepEqual(
    matrix.launcher.optionalDependencies,
    releasePlatformDependencyGraph(VERSION)
  );
  for (const manifest of matrix.platforms) {
    if (manifest.os[0] === "linux") {
      assert.deepEqual(manifest.libc, ["glibc"]);
    } else {
      assert.equal(Object.hasOwn(manifest, "libc"), false);
    }
  }
});

test("release package policy rejects scripts, undeclared fields, target skew, and matrix holes", () => {
  assert.throws(() => parseReleasePackageManifest({
    ...launcherManifest(),
    scripts: { postinstall: "node install.js" }
  }, VERSION), /unknown or missing/);
  assert.throws(() => parseReleasePackageManifest({
    ...platformManifest("linux-x64"),
    cpu: ["arm64"]
  }, VERSION), /cpu/);
  assert.throws(() => parseReleasePackageManifest({
    ...launcherManifest(),
    optionalDependencies: {
      ...launcherManifest().optionalDependencies,
      [PLATFORM_PACKAGE]: "2.0.1"
    }
  }, VERSION), /optional dependencies/);
  assert.throws(() => validateReleasePackageMatrix([
    launcherManifest(),
    ...PACKAGED_ARTIFACT_TARGETS.slice(1).map(platformManifest)
  ], identities), /one launcher and every platform/);
});

test("release package policy requires the repository and Linux-only glibc metadata", () => {
  const { repository: _repository, ...missingRepository } = launcherManifest();
  assert.throws(
    () => parseReleasePackageManifest(missingRepository, VERSION),
    /unknown or missing/
  );
  assert.throws(() => parseReleasePackageManifest({
    ...launcherManifest(),
    repository: { ...RELEASE_PACKAGE_REPOSITORY, url: "git+https://example.invalid/repo.git" }
  }, VERSION), /repository/);

  const { libc: _libc, ...missingLibc } = platformManifest("linux-x64");
  assert.throws(
    () => parseReleasePackageManifest(missingLibc, VERSION),
    /unknown or missing/
  );
  assert.throws(() => parseReleasePackageManifest({
    ...platformManifest("linux-x64"),
    libc: ["musl"]
  }, VERSION), /libc/);
  assert.throws(() => parseReleasePackageManifest({
    ...platformManifest("darwin-arm64"),
    libc: ["glibc"]
  }, VERSION), /unknown or missing/);
  assert.throws(() => parseReleasePackageManifest({
    ...launcherManifest(),
    libc: ["glibc"]
  }, VERSION), /unknown or missing/);
});

test("bounded tarball inspection accepts only declared regular files", () => {
  const manifest = parseReleasePackageManifest(
    platformManifest("linux-x64"),
    VERSION
  );
  const fixture = tarballFixture(manifest);
  const inspection = validateReleaseTarballInspection(fixture, manifest);
  assert.equal(inspection.entries.length, 6);
  assert.equal(
    tarballFile(inspection, "bin/1667").sha256,
    sha256(`${PLATFORM_PACKAGE} executable`)
  );
  assert.ok(Object.isFrozen(inspection.entries));
});

test("tarball policy rejects links, traversal, extras, unsafe modes, and digest drift", () => {
  const manifest = parseReleasePackageManifest(
    platformManifest("linux-x64"),
    VERSION
  );
  const fixture = tarballFixture(manifest);
  const cases = [
    {
      ...fixture,
      entries: fixture.entries.map((entry) => {
        return entry.path === "package/bin/1667" ? { ...entry, type: "link" } : entry;
      })
    },
    {
      ...fixture,
      entries: [...fixture.entries, file("package/../escape", 0o644, 1, sha256("escape"))]
    },
    {
      ...fixture,
      entries: [...fixture.entries, file("package/install.js", 0o644, 1, sha256("extra"))]
    },
    {
      ...fixture,
      entries: fixture.entries.map((entry) => {
        return entry.path === "package/bin/1667" ? { ...entry, mode: 0o777 } : entry;
      })
    },
    { ...fixture, packageJsonSha256: sha256("different package.json") }
  ];
  for (const value of cases) {
    assert.throws(() => validateReleaseTarballInspection(value, manifest));
  }
});

export function launcherManifest() {
  return {
    name: RELEASE_LAUNCHER_PACKAGE,
    version: VERSION,
    private: false,
    type: "module",
    bin: { "1667": "bin/1667.js" },
    files: ["bin/1667.js", "build-manifest.json", "sbom.spdx.json"],
    optionalDependencies: releasePlatformDependencyGraph(VERSION),
    repository: RELEASE_PACKAGE_REPOSITORY,
    publishConfig: { access: "public" }
  };
}

export function platformManifest(target: PackagedArtifactTarget) {
  const policy = releaseTargetForArtifact(target);
  return {
    name: policy.packageName,
    version: VERSION,
    private: false,
    os: [policy.platform],
    cpu: [policy.arch],
    ...(policy.libc === null ? {} : { libc: [policy.libc] }),
    files: [policy.executable, "build-manifest.json", "sbom.spdx.json"],
    repository: RELEASE_PACKAGE_REPOSITORY,
    publishConfig: { access: "public" }
  };
}

export function tarballFixture(
  manifest: ReturnType<typeof parseReleasePackageManifest>
) {
  const executable = manifest.kind === "launcher"
    ? "bin/1667.js"
    : releaseTargetForArtifact(manifest.target).executable;
  const packageJsonSha256 = sha256(`${manifest.name} package.json`);
  return {
    packageJsonSha256,
    entries: [
      directory("package"),
      directory("package/bin"),
      file("package/package.json", 0o644, 512, packageJsonSha256),
      file(`package/${executable}`, 0o755, 1024, sha256(`${manifest.name} executable`)),
      file(
        "package/build-manifest.json",
        0o644,
        256,
        sha256(`${manifest.name} build manifest`)
      ),
      file("package/sbom.spdx.json", 0o644, 768, sha256(`${manifest.name} sbom`))
    ]
  };
}

function directory(path: string) {
  return { path, type: "directory", mode: 0o755, size: 0, sha256: null };
}

function file(path: string, mode: number, size: number, digest: string) {
  return { path, type: "file", mode, size, sha256: digest };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  BUILT_ARTIFACT_TARGETS,
  type BuiltArtifactTarget
} from "../shared/build-identity.js";
import {
  PUBLISHED_ARTIFACT_TARGETS,
  PUBLISHED_PACKAGE_COUNT,
  PUBLISHED_RELEASE_TARGETS,
  RELEASE_LAUNCHER_PACKAGE,
  RELEASE_TARGETS,
  releasePlatformDependencyGraph,
  releaseTargetForArtifact
} from "../shared/release-targets.js";
import {
  createReleaseIdentitySet,
  releaseIdentityForTarget
} from "../scripts/release-identity.js";
import {
  createReleaseLauncherManifest,
  createReleasePlatformManifest,
  releasePackageJson,
  RELEASE_LICENSE_FILES,
  RELEASE_LICENSE_FILE_DIGESTS,
  RELEASE_PACKAGE_REPOSITORY
} from "../scripts/release-package-manifests.js";
import {
  MAX_RELEASE_TARBALL_ENTRIES,
  parseReleasePackageManifest,
  tarballFile,
  validateReleasePackageMatrix,
  validateReleaseTarballInspection
} from "../scripts/release-package-policy.js";

const VERSION = "2.0.0";
const PLATFORM_PACKAGE = releaseTargetForArtifact("linux-x64").packageName;
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
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

test("a target held from publication is built and verified but never shipped", () => {
  const held = RELEASE_TARGETS.filter((descriptor) => descriptor.heldFromPublication !== null);
  // Publication is derived from that one field and nothing else, so clearing it
  // is the whole of un-holding a target.
  assert.deepEqual(
    PUBLISHED_RELEASE_TARGETS,
    RELEASE_TARGETS.filter((descriptor) => descriptor.heldFromPublication === null)
  );
  assert.equal(PUBLISHED_PACKAGE_COUNT, PUBLISHED_RELEASE_TARGETS.length + 1);
  assert.equal(PUBLISHED_ARTIFACT_TARGETS.length + held.length, BUILT_ARTIFACT_TARGETS.length);

  const optionalDependencies = launcherManifest().optionalDependencies;
  for (const descriptor of held) {
    // npm fails an optional dependency soft. Pinning a package that was never
    // published would install cleanly and throw on first launch, and npm does
    // not allow replacing a published version to undo that. Checked before the
    // count below so the failure names the package rather than a number.
    assert.equal(
      Object.hasOwn(optionalDependencies, descriptor.packageName),
      false,
      `the launcher pins the held ${descriptor.packageName}`
    );
    const published: readonly string[] = PUBLISHED_ARTIFACT_TARGETS;
    assert.equal(published.includes(descriptor.artifactTarget), false);
    // Still built, still identified, still verified: that is the whole point.
    assert.ok(BUILT_ARTIFACT_TARGETS.includes(descriptor.artifactTarget));
    assert.equal(
      releaseIdentityForTarget(identities, descriptor.artifactTarget).artifactTarget,
      descriptor.artifactTarget
    );
    // And its package is still staged and validated one at a time, so the
    // layout it will publish under cannot rot while the hold is in force.
    assert.equal(
      parseReleasePackageManifest(platformManifest(descriptor.artifactTarget), VERSION).name,
      descriptor.packageName
    );
  }
  assert.equal(
    Object.keys(optionalDependencies).length,
    PUBLISHED_RELEASE_TARGETS.length
  );
});

test("release package matrix pins every platform as an exact optional dependency", () => {
  const values = [launcherManifest(), ...PUBLISHED_ARTIFACT_TARGETS.map(platformManifest)];
  const matrix = validateReleasePackageMatrix(values, identities);
  assert.equal(matrix.launcher.name, RELEASE_LAUNCHER_PACKAGE);
  assert.deepEqual(
    matrix.platforms.map((manifest) => manifest.target),
    PUBLISHED_ARTIFACT_TARGETS
  );
  assert.deepEqual(
    matrix.launcher.optionalDependencies,
    releasePlatformDependencyGraph(VERSION)
  );
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
    ...PUBLISHED_ARTIFACT_TARGETS.slice(1).map(platformManifest)
  ], identities), /one launcher and every published platform/);
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

  const linuxManifest = platformManifest("linux-x64");
  assert.ok("libc" in linuxManifest);
  const { libc: _libc, ...missingLibc } = linuxManifest;
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

test("release package policy declares Apache-2.0 and ships both licence files", () => {
  for (const value of [launcherManifest(), ...BUILT_ARTIFACT_TARGETS.map(platformManifest)]) {
    const files: readonly string[] = value.files;
    assert.equal(value.license, "Apache-2.0");
    assert.deepEqual(files.slice(-2), ["LICENSE", "NOTICE"]);
  }
  const { license: _license, ...missingLicense } = launcherManifest();
  assert.throws(
    () => parseReleasePackageManifest(missingLicense, VERSION),
    /unknown or missing/
  );
  assert.throws(() => parseReleasePackageManifest({
    ...launcherManifest(),
    license: "MIT"
  }, VERSION), /licence/);
  assert.throws(() => parseReleasePackageManifest({
    ...platformManifest("linux-x64"),
    license: "MIT"
  }, VERSION), /licence/);
});

test("tarball policy requires a sound LICENSE and NOTICE in every package", () => {
  const manifest = parseReleasePackageManifest(platformManifest("linux-x64"), VERSION);
  const fixture = tarballFixture(manifest);
  const cases: readonly [unknown, RegExp][] = [
    [withoutEntry(fixture, "package/LICENSE"), /missing/],
    [withoutEntry(fixture, "package/NOTICE"), /missing/],
    [patchEntry(fixture, "package/LICENSE", { size: 0 }), /must not be empty/],
    [patchEntry(fixture, "package/LICENSE", { mode: 0o755 }), /unsafe mode/],
    [patchEntry(fixture, "package/NOTICE", { size: 0 }), /must not be empty/],
    [patchEntry(fixture, "package/NOTICE", { mode: 0o755 }), /unsafe mode/],
    // Pinned bytes, so a truncated or substituted copy is rejected even when it
    // is applied to every package at once and they therefore all agree.
    [
      patchEntry(fixture, "package/LICENSE", { size: 128 }),
      /is not the reviewed LICENSE file/
    ],
    [
      patchEntry(fixture, "package/LICENSE", { sha256: sha256("other licence text") }),
      /is not the reviewed LICENSE file/
    ],
    [
      patchEntry(fixture, "package/NOTICE", { sha256: sha256("other notice text") }),
      /is not the reviewed NOTICE file/
    ]
  ];
  for (const [value, expected] of cases) {
    assert.throws(() => validateReleaseTarballInspection(value, manifest), expected);
  }
});

// Editing LICENSE or NOTICE requires updating RELEASE_LICENSE_FILE_DIGESTS in
// the same commit. That coupling is deliberate: changing the licence text a
// published product ships under should be a reviewed event, not a silent
// consequence of a staging script, and npm cannot replace a published version.
test("pinned licence digests match the repository files they authorise", async () => {
  for (const name of RELEASE_LICENSE_FILES) {
    const bytes = await readFile(path.join(REPOSITORY_ROOT, name));
    assert.deepEqual(
      {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength
      },
      { ...RELEASE_LICENSE_FILE_DIGESTS[name] },
      `${name} changed without updating its pinned digest`
    );
  }
});

test("bounded tarball inspection accepts only declared regular files", () => {
  const manifest = parseReleasePackageManifest(
    platformManifest("linux-x64"),
    VERSION
  );
  const fixture = tarballFixture(manifest);
  const inspection = validateReleaseTarballInspection(fixture, manifest);
  assert.equal(inspection.entries.length, 8);
  assert.ok(inspection.entries.length < MAX_RELEASE_TARBALL_ENTRIES);
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
  return releasePackageJson(createReleaseLauncherManifest(VERSION));
}

export function platformManifest(target: BuiltArtifactTarget) {
  return releasePackageJson(createReleasePlatformManifest(target, VERSION));
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
      file("package/sbom.spdx.json", 0o644, 768, sha256(`${manifest.name} sbom`)),
      licenceFile("LICENSE"),
      licenceFile("NOTICE")
    ]
  };
}

/** The pin rejects stand-in bytes, so fixtures present the reviewed digests. */
function licenceFile(name: "LICENSE" | "NOTICE") {
  const pinned = RELEASE_LICENSE_FILE_DIGESTS[name];
  return file(`package/${name}`, 0o644, pinned.bytes, pinned.sha256);
}

function withoutEntry(fixture: ReturnType<typeof tarballFixture>, path: string) {
  return {
    ...fixture,
    entries: fixture.entries.filter((entry) => entry.path !== path)
  };
}

function patchEntry(
  fixture: ReturnType<typeof tarballFixture>,
  path: string,
  patch: { mode?: number; size?: number; sha256?: string }
) {
  return {
    ...fixture,
    entries: fixture.entries.map((entry) => {
      return entry.path === path ? { ...entry, ...patch } : entry;
    })
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

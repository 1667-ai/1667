import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  PACKAGED_ARTIFACT_TARGETS,
  type PackagedArtifactTarget
} from "../shared/build-identity.js";
import {
  RELEASE_LAUNCHER_PACKAGE,
  releaseTargetForArtifact
} from "../shared/release-targets.js";
import {
  createReleaseArtifactManifest,
  type ReleasePackageArtifactInput
} from "../scripts/release-artifact-manifest.js";
import { createReleaseIdentitySet } from "../scripts/release-identity.js";
import {
  createReleaseLauncherManifest,
  createReleasePlatformManifest,
  releasePackageJson,
  RELEASE_LICENSE_FILE_DIGESTS
} from "../scripts/release-package-manifests.js";
import {
  parseReleasePackageManifest
} from "../scripts/release-package-policy.js";

const VERSION = "2.0.0";
const PLATFORM_PACKAGE = releaseTargetForArtifact("linux-x64").packageName;
// Staged verbatim from the repository root and pinned by release package
// policy, so fixtures must present the reviewed bytes rather than stand-ins.
const LICENSE = RELEASE_LICENSE_FILE_DIGESTS.LICENSE;
const NOTICE = RELEASE_LICENSE_FILE_DIGESTS.NOTICE;
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

test("release artifact manifest is canonical, deterministic, and target ordered", () => {
  const artifacts = releaseArtifacts();
  const forward = createReleaseArtifactManifest(identities, artifacts);
  const reverse = createReleaseArtifactManifest(identities, artifacts.toReversed());
  assert.equal(forward.text, reverse.text);
  assert.equal(forward.sha256, sha256(forward.text));
  assert.equal(JSON.stringify(JSON.parse(forward.text)), forward.text);
  assert.deepEqual(
    forward.manifest.artifacts.map((artifact) => artifact.target),
    ["launcher", ...PACKAGED_ARTIFACT_TARGETS]
  );
  for (const artifact of forward.manifest.artifacts) {
    if (artifact.target === "launcher") {
      assert.equal(artifact.buildIdentity, null);
    } else {
      assert.equal(artifact.buildIdentity.buildKind, "release");
      assert.equal(artifact.buildIdentity.artifactTarget, artifact.target);
    }
  }
  assert.ok(Object.isFrozen(forward.manifest.artifacts));
});

test("release artifact manifest reports the metadata its inspected tarball holds", () => {
  const artifacts = releaseArtifacts();
  const forward = createReleaseArtifactManifest(identities, artifacts);
  const records: readonly ["buildManifest" | "sbom" | "license" | "notice", string][] = [
    ["buildManifest", "build-manifest.json"],
    ["sbom", "sbom.spdx.json"],
    ["license", "LICENSE"],
    ["notice", "NOTICE"]
  ];
  for (const record of forward.manifest.artifacts) {
    const inspection = tarEntries(artifacts.find((artifact) => {
      return packageName(artifact) === record.name;
    })!);
    assert.equal(record.packageJsonSha256, inspection.packageJsonSha256);
    for (const [key, relativePath] of records) {
      const entry = inspection.entries.find((candidate) => {
        return candidate.path === `package/${relativePath}`;
      })!;
      assert.deepEqual(record[key], { sha256: entry.sha256, bytes: entry.size });
    }
  }
});

test("release artifact manifest binds native identities", () => {
  const artifacts = releaseArtifacts();
  const linux = artifacts.find((artifact) => {
    return packageName(artifact) === PLATFORM_PACKAGE;
  })!;
  assert.throws(() => createReleaseArtifactManifest(identities, artifacts.map((artifact) => {
    return artifact === linux
      ? {
          ...artifact,
          buildIdentity: {
            ...(artifact.buildIdentity as Record<string, unknown>),
            sourceCommit: "fedcba9876543210fedcba9876543210fedcba98"
          }
        }
      : artifact;
  })), /disagrees/);
  assert.throws(() => createReleaseArtifactManifest(identities, artifacts.map((artifact) => {
    return packageName(artifact) === RELEASE_LAUNCHER_PACKAGE
      ? { ...artifact, buildIdentity: identities.identities[0] }
      : artifact;
  })), /launcher/);
});

test("release artifact manifest rejects licence files that are not the reviewed ones", () => {
  const artifacts = releaseArtifacts();
  const forward = createReleaseArtifactManifest(identities, artifacts);
  for (const record of forward.manifest.artifacts) {
    assert.deepEqual(record.license, LICENSE);
    assert.deepEqual(record.notice, NOTICE);
  }

  // A uniform substitution — every package staged from the wrong place, or the
  // same truncated copy five times — leaves the packages agreeing with each
  // other, so only the pinned digest can reject it.
  for (const relativePath of ["LICENSE", "NOTICE"] as const) {
    assert.throws(() => createReleaseArtifactManifest(identities, artifacts.map((artifact) => {
      return withLicenceFile(artifact, relativePath, digestRecord("substituted", 12));
    })), new RegExp(`is not the reviewed ${relativePath} file`));
  }
  const linux = artifacts.find((artifact) => packageName(artifact) === PLATFORM_PACKAGE)!;
  assert.throws(() => createReleaseArtifactManifest(identities, artifacts.map((artifact) => {
    return artifact === linux
      ? withLicenceFile(artifact, "LICENSE", { sha256: LICENSE.sha256, bytes: 128 })
      : artifact;
  })), /is not the reviewed LICENSE file/);
});

function releaseArtifacts(): ReleasePackageArtifactInput[] {
  return [
    artifact(launcherManifest(), null),
    ...PACKAGED_ARTIFACT_TARGETS.map((target, index) => {
      return artifact(platformManifest(target), identities.identities[index]!);
    })
  ];
}

function artifact(
  manifestValue: unknown,
  buildIdentity: unknown | null
): ReleasePackageArtifactInput {
  const manifest = parseReleasePackageManifest(manifestValue, VERSION);
  const executable = manifest.kind === "launcher"
    ? "bin/1667.js"
    : releaseTargetForArtifact(manifest.target).executable;
  const executableMode = manifest.kind === "launcher"
    || releaseTargetForArtifact(manifest.target).platform !== "win32"
    ? 0o755
    : 0o644;
  const packageJson = digestRecord(`${manifest.name} package.json`, 512);
  const buildManifest = digestRecord(`${manifest.name} build manifest`, 256);
  const sbom = digestRecord(`${manifest.name} sbom`, 768);
  return {
    packageJson: manifestValue,
    tarball: digestRecord(`${manifest.name} tarball`, 2048),
    tarEntries: {
      packageJsonSha256: packageJson.sha256,
      entries: [
        directory("package"),
        directory("package/bin"),
        file("package/package.json", 0o644, packageJson.bytes, packageJson.sha256),
        file(
          `package/${executable}`,
          executableMode,
          1024,
          sha256(`${manifest.name} executable`)
        ),
        file(
          "package/build-manifest.json",
          0o644,
          buildManifest.bytes,
          buildManifest.sha256
        ),
        file("package/sbom.spdx.json", 0o644, sbom.bytes, sbom.sha256),
        file("package/LICENSE", 0o644, LICENSE.bytes, LICENSE.sha256),
        file("package/NOTICE", 0o644, NOTICE.bytes, NOTICE.sha256)
      ]
    },
    buildIdentity
  };
}

/** Restages one package's licence file with bytes the pin does not authorise. */
function withLicenceFile(
  artifact: ReleasePackageArtifactInput,
  relativePath: "LICENSE" | "NOTICE",
  record: { sha256: string; bytes: number }
): ReleasePackageArtifactInput {
  const inspection = tarEntries(artifact);
  return {
    ...artifact,
    tarEntries: {
      ...inspection,
      entries: inspection.entries.map((entry) => {
        return entry.path === `package/${relativePath}`
          ? file(`package/${relativePath}`, 0o644, record.bytes, record.sha256)
          : entry;
      })
    }
  };
}

function tarEntries(artifact: ReleasePackageArtifactInput) {
  return artifact.tarEntries as {
    packageJsonSha256: string;
    entries: { path: string; size: number; sha256: string | null }[];
  };
}

function launcherManifest() {
  return releasePackageJson(createReleaseLauncherManifest(VERSION));
}

function platformManifest(target: PackagedArtifactTarget) {
  return releasePackageJson(createReleasePlatformManifest(target, VERSION));
}

function packageName(artifact: ReleasePackageArtifactInput): string {
  return (artifact.packageJson as { name: string }).name;
}

function digestRecord(seed: string, bytes: number) {
  return { sha256: sha256(seed), bytes };
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

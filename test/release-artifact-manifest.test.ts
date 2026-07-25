import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  PACKAGED_ARTIFACT_TARGETS,
  type PackagedArtifactTarget
} from "../shared/build-identity.js";
import {
  releasePlatformDependencyGraph,
  releaseTargetForArtifact
} from "../shared/release-targets.js";
import {
  createReleaseArtifactManifest,
  type ReleasePackageArtifactInput
} from "../scripts/release-artifact-manifest.js";
import { createReleaseIdentitySet } from "../scripts/release-identity.js";
import {
  parseReleasePackageManifest
} from "../scripts/release-package-policy.js";

const VERSION = "2.0.0";
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

test("release artifact manifest binds SBOM/build metadata and native identities", () => {
  const artifacts = releaseArtifacts();
  const linux = artifacts.find((artifact) => {
    return packageName(artifact) === "1667-linux-x64";
  })!;
  assert.throws(() => createReleaseArtifactManifest(identities, artifacts.map((artifact) => {
    return artifact === linux
      ? { ...artifact, sbom: { ...artifact.sbom, sha256: sha256("tampered") } }
      : artifact;
  })), /does not match/);
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
    return packageName(artifact) === "1667"
      ? { ...artifact, buildIdentity: identities.identities[0] }
      : artifact;
  })), /launcher/);
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
  const packageJson = digestRecord(`${manifest.name} package.json`, 512);
  const buildManifest = digestRecord(`${manifest.name} build manifest`, 256);
  const sbom = digestRecord(`${manifest.name} sbom`, 768);
  return {
    packageJson: {
      manifest: manifestValue,
      sha256: packageJson.sha256
    },
    tarball: digestRecord(`${manifest.name} tarball`, 2048),
    tarEntries: {
      packageJsonSha256: packageJson.sha256,
      entries: [
        directory("package"),
        directory("package/bin"),
        file("package/package.json", 0o644, packageJson.bytes, packageJson.sha256),
        file(
          `package/${executable}`,
          0o755,
          1024,
          sha256(`${manifest.name} executable`)
        ),
        file(
          "package/build-manifest.json",
          0o644,
          buildManifest.bytes,
          buildManifest.sha256
        ),
        file("package/sbom.spdx.json", 0o644, sbom.bytes, sbom.sha256)
      ]
    },
    buildManifest,
    sbom,
    buildIdentity
  };
}

function launcherManifest() {
  return {
    name: "1667",
    version: VERSION,
    private: false,
    type: "module",
    bin: { "1667": "bin/1667.js" },
    files: ["bin/1667.js", "build-manifest.json", "sbom.spdx.json"],
    optionalDependencies: releasePlatformDependencyGraph(VERSION),
    publishConfig: { access: "public" }
  };
}

function platformManifest(target: PackagedArtifactTarget) {
  const policy = releaseTargetForArtifact(target);
  return {
    name: policy.packageName,
    version: VERSION,
    private: false,
    os: [policy.platform],
    cpu: [policy.arch],
    files: [policy.executable, "build-manifest.json", "sbom.spdx.json"],
    publishConfig: { access: "public" }
  };
}

function packageName(artifact: ReleasePackageArtifactInput): string {
  return (artifact.packageJson.manifest as { name: string }).name;
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

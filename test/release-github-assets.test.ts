import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AI_1667_PRODUCT_VERSION } from "../shared/build-identity.js";
import { canonicalJson } from "../server/canonical-json.js";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import {
  releaseTargetForArtifact,
  BUILT_ARTIFACT_TARGETS,
  PUBLISHED_ARTIFACT_TARGETS,
  RELEASE_TARGETS,
  type BuiltArtifactTarget
} from "../shared/release-targets.js";
import { releaseIdentityForTarget } from "../scripts/release-identity.js";
import {
  RELEASE_LICENSE_FILES,
  RELEASE_LICENSE_FILE_DIGESTS
} from "../scripts/release-package-manifests.js";
import { createReleasePackageBuildManifest } from "../scripts/release-package-templates.js";
import {
  assertRunnerBuildsTarget,
  directoryAssetDigests,
  formatReleaseChecksums,
  releaseArchiveFileSet,
  releaseContentFileSet,
  stageReleaseArchive,
  RELEASE_BUILD_MANIFEST_FILE,
  RELEASE_SBOM_FILE
} from "../scripts/release-github-assets.js";
import {
  collectRepositoryReleaseSource,
  releaseArtifactInputs
} from "../scripts/release-source-facts.js";
import {
  MAX_RELEASE_ARCHIVE_STEM_BYTES,
  releaseArchiveFileName,
  releaseArchiveStem,
  RELEASE_CHECKSUMS_FILE
} from "../scripts/release-archive.js";

/** Reads the one publication policy, so no test here carries a target list. */
function heldFromPublication(target: BuiltArtifactTarget): boolean {
  return releaseTargetForArtifact(target).heldFromPublication !== null;
}

const REPOSITORY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The version this release ships under. Release identity refuses a version the
// checkout's manifests disagree with, so both derive from the product version.
const VERSION = AI_1667_PRODUCT_VERSION;
const PRERELEASE_VERSION = "0.1.0-rc.1";
const SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const BUILD_TIMESTAMP = "2026-07-23T10:20:30.000Z";
/**
 * The whole of what one release run carries between jobs. The version has to be
 * this repository's own, because every job rebuilds its identity from these
 * three strings against the checkout it is standing in.
 */
const FACTS = Object.freeze({
  version: VERSION,
  sourceCommit: SOURCE_COMMIT,
  buildTimestamp: BUILD_TIMESTAMP
});

function digestOf(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("a published archive holds the executable, both licence files, and both manifests", () => {
  const entries = releaseArchiveFileSet("linux-x64", VERSION);
  assert.deepEqual(entries.map((entry) => entry.path), [
    "1667",
    RELEASE_BUILD_MANIFEST_FILE,
    RELEASE_SBOM_FILE,
    "LICENSE",
    "NOTICE"
  ]);
  assert.deepEqual(entries.map((entry) => entry.source.kind), [
    "executable",
    "build-manifest",
    "sbom",
    "repository-file",
    "repository-file"
  ]);
  assert.equal(entries[0]?.mode, 0o755);
});

// The obligation this release must not breach. Apache-2.0 section 4(a) gives
// each recipient a copy of the licence and 4(d) propagates NOTICE; a recipient
// receives one archive, so dropping either file from the set here would ship a
// distribution that does neither. This fails on the drop, for every target.
test("every published archive carries LICENSE and NOTICE at their reviewed digests", () => {
  assert.ok(PUBLISHED_ARTIFACT_TARGETS.length > 0);
  for (const target of PUBLISHED_ARTIFACT_TARGETS) {
    const entries = releaseArchiveFileSet(target, VERSION);
    for (const licenceFile of ["LICENSE", "NOTICE"] as const) {
      const entry = entries.find((candidate) => candidate.path === licenceFile);
      assert.ok(entry !== undefined, `${target} archive is missing ${licenceFile}`);
      assert.equal(entry.source.kind, "repository-file");
      if (entry.source.kind !== "repository-file") return;
      const pinned = RELEASE_LICENSE_FILE_DIGESTS[licenceFile];
      assert.equal(entry.source.repositoryPath, licenceFile);
      assert.equal(entry.source.sha256, pinned.sha256);
      assert.equal(entry.source.bytes, pinned.bytes);
      assert.equal(entry.mode, 0o644);
    }
  }
  assert.deepEqual([...RELEASE_LICENSE_FILES], ["LICENSE", "NOTICE"]);
});

test("the pinned licence digests are the digests of the files in this repository", () => {
  for (const licenceFile of RELEASE_LICENSE_FILES) {
    const bytes = readFileSync(path.join(REPOSITORY_ROOT, licenceFile));
    const pinned = RELEASE_LICENSE_FILE_DIGESTS[licenceFile];
    assert.equal(bytes.byteLength, pinned.bytes);
    assert.equal(digestOf(bytes), pinned.sha256);
  }
});

test("Windows x64 has a published native archive", () => {
  assert.deepEqual(
    RELEASE_TARGETS
      .filter((descriptor) => descriptor.heldFromPublication !== null)
      .map((descriptor) => descriptor.artifactTarget),
    []
  );
  assert.ok(BUILT_ARTIFACT_TARGETS.includes("windows-x64"));
  assert.ok((PUBLISHED_ARTIFACT_TARGETS as readonly string[]).includes("windows-x64"));
  assert.ok(!heldFromPublication("windows-x64"));
  assert.deepEqual(releaseArchiveFileSet("windows-x64", VERSION).map((entry) => entry.path), [
    "1667.exe",
    RELEASE_BUILD_MANIFEST_FILE,
    RELEASE_SBOM_FILE,
    "LICENSE",
    "NOTICE"
  ]);
  assert.equal(releaseArchiveStem(VERSION, "windows-x64"), `1667_${VERSION}_windows-x64`);
  for (const target of PUBLISHED_ARTIFACT_TARGETS) {
    assert.ok(!heldFromPublication(target));
  }
  // The hold reason is shown to a user of that platform by the launcher, so it
  // may not promise a verification this repository is not performing. It said
  // the Windows work was "built and verified on every change" while CI had
  // stopped building it, which is the exact shape of claim to keep out: a
  // standing promise no check enforces.
  for (const descriptor of RELEASE_TARGETS) {
    if (descriptor.heldFromPublication === null) continue;
    assert.doesNotMatch(
      descriptor.heldFromPublication,
      /every change|continuous|always (?:built|verified|tested)/u,
      `${descriptor.artifactTarget} promises a verification nothing here enforces`
    );
  }
});

test("the published set is the built set minus the holds, in matrix order", () => {
  assert.deepEqual(
    [...PUBLISHED_ARTIFACT_TARGETS],
    BUILT_ARTIFACT_TARGETS.filter((target) => !heldFromPublication(target))
  );
  assert.deepEqual([...PUBLISHED_ARTIFACT_TARGETS], [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "windows-x64"
  ]);
});

test("an npm layout reuses the file set and only moves the executable", () => {
  const descriptor = releaseTargetForArtifact("linux-x64");
  const staged = releaseContentFileSet("linux-x64", VERSION, {
    executablePath: descriptor.executable
  });
  assert.deepEqual(staged.map((entry) => entry.path), [
    "bin/1667",
    RELEASE_BUILD_MANIFEST_FILE,
    RELEASE_SBOM_FILE,
    "LICENSE",
    "NOTICE"
  ]);
});

test("the archive name and its inner directory are the same stem", () => {
  const stem = releaseArchiveStem(VERSION, "linux-x64");
  assert.equal(stem, `1667_${VERSION}_linux-x64`);
  assert.equal(
    releaseArchiveFileName(VERSION, "linux-x64"),
    `1667_${VERSION}_linux-x64.tar.gz`
  );
  assert.equal(releaseArchiveFileName("1.2.3", "darwin-arm64"), "1667_1.2.3_darwin-arm64.tar.gz");
  assert.throws(() => releaseArchiveStem("0.1", "linux-x64"), /SemVer/);
  assert.throws(() => releaseContentFileSet("linux-x64", "v0.1.0"), /SemVer/);
});

/**
 * Canonical ustar top-level directory entry is stem + "/" in the 100-byte name
 * field. For linux-x64 the fixed prefix/suffix is 15 ASCII bytes, so a SemVer
 * prerelease of length 84 yields a 99-byte stem (accepted) and 85 yields 100
 * (rejected before any workflow names or tars).
 */
test("releaseArchiveStem accepts the maximum ustar directory stem and rejects the next", () => {
  const target = "linux-x64";
  const fixedBytes = Buffer.byteLength(`1667__${target}`, "utf8");
  assert.equal(fixedBytes, 15);
  const maxVersion = `0.0.0-${"a".repeat(MAX_RELEASE_ARCHIVE_STEM_BYTES - fixedBytes - 6)}`;
  // "0.0.0-" is 6 bytes; maxVersion length is the version field only.
  assert.equal(Buffer.byteLength(maxVersion, "utf8"), MAX_RELEASE_ARCHIVE_STEM_BYTES - fixedBytes);
  const maxStem = releaseArchiveStem(maxVersion, target);
  assert.equal(Buffer.byteLength(maxStem, "utf8"), MAX_RELEASE_ARCHIVE_STEM_BYTES);
  assert.equal(maxStem, `1667_${maxVersion}_${target}`);
  assert.equal(
    releaseArchiveFileName(maxVersion, target),
    `${maxStem}.tar.gz`
  );

  const rejectVersion = `0.0.0-${"a".repeat(MAX_RELEASE_ARCHIVE_STEM_BYTES - fixedBytes - 6 + 1)}`;
  assert.equal(
    Buffer.byteLength(`1667_${rejectVersion}_${target}`, "utf8"),
    MAX_RELEASE_ARCHIVE_STEM_BYTES + 1
  );
  assert.throws(
    () => releaseArchiveStem(rejectVersion, target),
    /ustar name bound of 99 bytes/
  );
  assert.throws(
    () => releaseArchiveFileName(rejectVersion, target),
    /ustar name bound of 99 bytes/
  );
});

// Both the version and the target contain hyphens, so hyphens cannot also
// separate them: the underscores keep each field readable and parseable.
test("a prerelease version stays whole in the archive name", () => {
  assert.deepEqual(releaseArchiveStem(PRERELEASE_VERSION, "linux-x64").split("_"), [
    "1667",
    "0.1.0-rc.1",
    "linux-x64"
  ]);
  assert.deepEqual(releaseArchiveStem("1.2.3", "darwin-arm64").split("_"), [
    "1667",
    "1.2.3",
    "darwin-arm64"
  ]);
});

test("checksums cover every asset, sorted, and never the checksum file itself", () => {
  const digests = [
    { name: releaseArchiveFileName(PRERELEASE_VERSION, "linux-x64"), sha256: "b".repeat(64) },
    { name: RELEASE_CHECKSUMS_FILE, sha256: "c".repeat(64) },
    { name: releaseArchiveFileName(PRERELEASE_VERSION, "darwin-arm64"), sha256: "a".repeat(64) }
  ];
  assert.equal(formatReleaseChecksums(digests), [
    `${"a".repeat(64)}  1667_0.1.0-rc.1_darwin-arm64.tar.gz\n`,
    `${"b".repeat(64)}  1667_0.1.0-rc.1_linux-x64.tar.gz\n`
  ].join(""));
  assert.throws(() => formatReleaseChecksums([]), /cover no assets/);
  assert.throws(
    () => formatReleaseChecksums([{ name: RELEASE_CHECKSUMS_FILE, sha256: "c".repeat(64) }]),
    /cover no assets/
  );
  assert.throws(() => formatReleaseChecksums([
    { name: "one.tar.gz", sha256: "a".repeat(64) },
    { name: "one.tar.gz", sha256: "a".repeat(64) }
  ]), /repeat one\.tar\.gz/);
  assert.throws(() => formatReleaseChecksums([
    { name: "../escape.tar.gz", sha256: "a".repeat(64) }
  ]), /is invalid/);
  assert.throws(() => formatReleaseChecksums([
    { name: "one.tar.gz", sha256: "not-a-digest" }
  ]), /invalid SHA-256/);
});

test("the three source facts build an identity the release codec accepts", () => {
  const { identities } = releaseArtifactInputs(collectRepositoryReleaseSource(FACTS));
  assert.equal(identities.source.productVersion, VERSION);
  assert.equal(identities.source.sourceCommit, SOURCE_COMMIT);
  assert.equal(identities.source.buildTimestamp, BUILD_TIMESTAMP);
  assert.equal("evidence" in identities, false);
  for (const target of PUBLISHED_ARTIFACT_TARGETS) {
    const identity = releaseIdentityForTarget(identities, target);
    assert.equal(identity.buildKind, "release");
    assert.equal(identity.sourceDirty, false);
    assert.equal(identity.sourceCommit, SOURCE_COMMIT);
    assert.equal(identity.artifactTarget, target);
  }
  assert.throws(() => collectRepositoryReleaseSource({
    version: "0.1",
    sourceCommit: SOURCE_COMMIT,
    buildTimestamp: BUILD_TIMESTAMP
  }), /version/);
});

test("staging writes the whole file set and nothing else", (t) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "1667-release-archive-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const buildDirectory = path.join(scratch, "dist");
  mkdirSync(buildDirectory, { recursive: true });
  const stubExecutable = "#!/bin/sh\necho stub\n";
  writeFileSync(path.join(buildDirectory, "1667"), stubExecutable, {
    encoding: "utf8",
    mode: 0o644,
    flag: "w"
  });

  let sourceCommitReads = 0;
  const source = collectRepositoryReleaseSource({
    version: FACTS.version,
    get sourceCommit(): string {
      sourceCommitReads += 1;
      return sourceCommitReads === 1 ? SOURCE_COMMIT : "f".repeat(40);
    },
    buildTimestamp: FACTS.buildTimestamp
  });
  const staged = stageReleaseArchive({
    source,
    target: "linux-x64",
    buildDirectory,
    outputDirectory: path.join(scratch, "stage")
  });

  assert.equal(sourceCommitReads, 1);
  assert.equal(staged.stem, `1667_${VERSION}_linux-x64`);
  assert.equal(path.basename(staged.directory), staged.stem);
  assert.deepEqual(staged.files.map((file) => file.path).sort(), [
    "1667",
    "LICENSE",
    "NOTICE",
    RELEASE_BUILD_MANIFEST_FILE,
    RELEASE_SBOM_FILE
  ].sort());
  assert.deepEqual(
    directoryAssetDigests(staged.directory).map((asset) => asset.name).sort(),
    staged.files.map((file) => file.path).sort()
  );

  for (const licenceFile of RELEASE_LICENSE_FILES) {
    const shipped = readFileSync(path.join(staged.directory, licenceFile));
    assert.deepEqual(shipped, readFileSync(path.join(REPOSITORY_ROOT, licenceFile)));
    assert.equal(digestOf(shipped), RELEASE_LICENSE_FILE_DIGESTS[licenceFile].sha256);
  }
  assert.equal(
    readFileSync(path.join(staged.directory, "1667"), "utf8"),
    stubExecutable
  );
  if (process.platform !== "win32") {
    assert.equal(statSync(path.join(staged.directory, "1667")).mode & 0o777, 0o755);
  }
  const buildManifestText = readFileSync(
    path.join(staged.directory, RELEASE_BUILD_MANIFEST_FILE),
    "utf8"
  );
  assert.equal(
    buildManifestText,
    `${canonicalJson(createReleasePackageBuildManifest(
      releaseArtifactInputs(collectRepositoryReleaseSource(FACTS)).identities.source,
      releaseTargetForArtifact("linux-x64").packageName,
      "linux-x64"
    ))}\n`
  );
  const sbomText = readFileSync(path.join(staged.directory, RELEASE_SBOM_FILE), "utf8");
  const sbom = parseJsonRejectingDuplicateKeys(sbomText) as {
    name?: unknown;
    spdxVersion?: unknown;
  };
  assert.equal(sbom.spdxVersion, "SPDX-2.3");
  assert.equal(sbom.name, `@1667-ai/linux-x64@${VERSION}`);

  // Archive staging uses build facts, not tag authorization evidence. No
  // staged file can carry tag authorization fields.
  for (const shipped of [buildManifestText, sbomText]) {
    assert.doesNotMatch(shipped, /tagSignature|tagObjectType|"verified"/u);
  }
  assert.ok(sbomText.includes(`Built from tag v${VERSION} at a clean working tree.`));
});

// One build, described identically by every archive in the run. This is why the
// three facts come from `prepare` as job outputs instead of each runner reading
// its own clock and HEAD.
test("every target in one run stamps the same version, commit and timestamp", (t) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "1667-release-run-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const buildDirectory = path.join(scratch, "dist");
  mkdirSync(buildDirectory, { recursive: true });
  writeFileSync(path.join(buildDirectory, "1667"), "#!/bin/sh\necho stub\n", "utf8");
  writeFileSync(path.join(buildDirectory, "1667.exe"), "windows stub\n", "utf8");

  const stems = new Set<string>();
  for (const target of PUBLISHED_ARTIFACT_TARGETS) {
    const staged = stageReleaseArchive({
      source: collectRepositoryReleaseSource(FACTS),
      target,
      buildDirectory,
      outputDirectory: path.join(scratch, "stage")
    });
    stems.add(staged.stem);
    const manifest = parseJsonRejectingDuplicateKeys(
      readFileSync(path.join(staged.directory, RELEASE_BUILD_MANIFEST_FILE), "utf8")
    ) as Record<string, unknown>;
    assert.equal(manifest.productVersion, VERSION);
    assert.equal(manifest.sourceCommit, SOURCE_COMMIT);
    assert.equal(manifest.buildTimestamp, BUILD_TIMESTAMP);
    assert.equal(manifest.artifactTarget, target);
    assert.equal(manifest.packageName, releaseTargetForArtifact(target).packageName);
  }
  assert.equal(stems.size, PUBLISHED_ARTIFACT_TARGETS.length);
});

test("staging fails on a missing executable rather than writing a partial archive", (t) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "1667-release-archive-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const outputDirectory = path.join(scratch, "stage");
  const stem = releaseArchiveStem(VERSION, "linux-x64");
  // No stub executable: staging must fail on a missing input rather than write
  // a partial archive.
  assert.throws(() => stageReleaseArchive({
    source: collectRepositoryReleaseSource(FACTS),
    target: "linux-x64",
    buildDirectory: path.join(scratch, "dist"),
    outputDirectory
  }), /Release executable|ENOENT/);
  assert.equal(existsSync(path.join(outputDirectory, stem)), false);
  assert.equal(
    readdirSync(outputDirectory).some((name) => name.startsWith(`.${stem}-`)),
    false
  );
});

/**
 * A build can only label itself with the machine it ran on, because that is the
 * machine `bun build --compile` emitted an executable for. The release path
 * supplies the identity instead of deriving it, so nothing downstream — not the
 * manifest, not the smoke that compares the executable against that same
 * supplied identity — can notice a machine that is not the target. This is what
 * notices.
 */
test("a build refuses a machine that is not the target it was asked for", () => {
  for (const target of BUILT_ARTIFACT_TARGETS) {
    const machine = releaseTargetForArtifact(target);
    assert.equal(
      assertRunnerBuildsTarget(target, machine.platform, machine.arch).artifactTarget,
      target
    );
    for (const other of BUILT_ARTIFACT_TARGETS) {
      if (other === target) continue;
      const host = releaseTargetForArtifact(other);
      assert.throws(
        () => assertRunnerBuildsTarget(target, host.platform, host.arch),
        new RegExp(`This machine builds ${other}, but ${target} was asked for`, "u"),
        `${target} accepted a ${other} machine`
      );
    }
  }
  // A machine no release target names is refused rather than guessed at: a
  // relabelled runner is exactly the case this exists for.
  assert.throws(() => assertRunnerBuildsTarget("linux-x64", "linux", "riscv64"), /no release target/u);
  assert.throws(() => assertRunnerBuildsTarget("darwin-arm64", "sunos", "arm64"), /no release target/u);
});

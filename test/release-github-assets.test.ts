import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../server/canonical-json.js";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import {
  PACKAGED_ARTIFACT_TARGETS,
  releaseTargetForArtifact
} from "../shared/release-targets.js";
import {
  createReleaseIdentitySet,
  releaseIdentityForTarget
} from "../scripts/release-identity.js";
import {
  RELEASE_LICENSE_FILES,
  RELEASE_LICENSE_FILE_DIGESTS
} from "../scripts/release-package-manifests.js";
import { createReleasePackageBuildManifest } from "../scripts/release-package-templates.js";
import {
  directoryAssetDigests,
  formatReleaseChecksums,
  githubReleaseSourceEvidence,
  releaseArchiveFileSet,
  releaseContentFileSet,
  stageReleaseArchive,
  RELEASE_BUILD_MANIFEST_FILE,
  RELEASE_SBOM_FILE
} from "../scripts/release-github-assets.js";
import { releaseNotesMarkdown } from "../scripts/release-github-notes.js";
import {
  heldFromPublication,
  PUBLICATION_HOLDS,
  PUBLISHED_RELEASE_TARGETS,
  releaseArchiveFileName,
  releaseArchiveStem,
  RELEASE_CHECKSUMS_FILE
} from "../scripts/release-publication.js";

const REPOSITORY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The version this release ships under. A prerelease identifier is the harder
// case throughout: it is a hyphenated SemVer suffix, and every name, digest,
// and manifest below has to keep it whole.
const VERSION = "0.1.0-rc.1";
const SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const BUILD_TIMESTAMP = "2026-07-23T10:20:30.000Z";

function evidence(version = VERSION): ReturnType<typeof githubReleaseSourceEvidence> {
  return githubReleaseSourceEvidence({
    version,
    sourceCommit: SOURCE_COMMIT,
    buildTimestamp: BUILD_TIMESTAMP,
    packageVersions: {
      root: version,
      tui: version,
      rootLock: version,
      rootLockPackage: version
    }
  });
}

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
  assert.ok(PUBLISHED_RELEASE_TARGETS.length > 0);
  for (const target of PUBLISHED_RELEASE_TARGETS) {
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

test("a target held from publication has no archive at all", () => {
  assert.deepEqual([...PUBLICATION_HOLDS], ["windows-x64"]);
  assert.ok(PACKAGED_ARTIFACT_TARGETS.includes("windows-x64"));
  assert.ok(!PUBLISHED_RELEASE_TARGETS.includes("windows-x64"));
  assert.ok(heldFromPublication("windows-x64"));
  assert.throws(
    () => releaseArchiveFileSet("windows-x64", VERSION),
    /windows-x64 is held from publication/
  );
  assert.throws(
    () => releaseArchiveStem(VERSION, "windows-x64"),
    /windows-x64 is held from publication/
  );
  for (const target of PUBLISHED_RELEASE_TARGETS) {
    assert.ok(!heldFromPublication(target));
  }
});

test("the published set is the built set minus the holds, in matrix order", () => {
  assert.deepEqual(
    [...PUBLISHED_RELEASE_TARGETS],
    PACKAGED_ARTIFACT_TARGETS.filter((target) => !heldFromPublication(target))
  );
  assert.deepEqual([...PUBLISHED_RELEASE_TARGETS], [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64"
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
  assert.equal(stem, "1667_0.1.0-rc.1_linux-x64");
  assert.equal(releaseArchiveFileName(VERSION, "linux-x64"), "1667_0.1.0-rc.1_linux-x64.tar.gz");
  assert.equal(releaseArchiveFileName("1.2.3", "darwin-arm64"), "1667_1.2.3_darwin-arm64.tar.gz");
  assert.throws(() => releaseArchiveStem("0.1", "linux-x64"), /SemVer/);
  assert.throws(() => releaseContentFileSet("linux-x64", "v0.1.0"), /SemVer/);
});

// Both the version and the target contain hyphens, so hyphens cannot also
// separate them: the underscores keep each field readable and parseable.
test("a prerelease version stays whole in the archive name", () => {
  assert.deepEqual(releaseArchiveStem(VERSION, "linux-x64").split("_"), [
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
    { name: releaseArchiveFileName(VERSION, "linux-x64"), sha256: "b".repeat(64) },
    { name: RELEASE_CHECKSUMS_FILE, sha256: "c".repeat(64) },
    { name: releaseArchiveFileName(VERSION, "darwin-arm64"), sha256: "a".repeat(64) }
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

test("the source evidence a dispatch records is evidence the release codec accepts", () => {
  const identities = createReleaseIdentitySet(evidence());
  assert.equal(identities.evidence.productVersion, VERSION);
  assert.equal(identities.evidence.tagName, `v${VERSION}`);
  assert.equal(identities.evidence.tagTargetCommit, SOURCE_COMMIT);
  for (const target of PUBLISHED_RELEASE_TARGETS) {
    const identity = releaseIdentityForTarget(identities, target);
    assert.equal(identity.buildKind, "release");
    assert.equal(identity.sourceDirty, false);
    assert.equal(identity.sourceCommit, SOURCE_COMMIT);
    assert.equal(identity.artifactTarget, target);
  }
  assert.throws(() => githubReleaseSourceEvidence({
    version: "0.1",
    sourceCommit: SOURCE_COMMIT,
    buildTimestamp: BUILD_TIMESTAMP,
    packageVersions: { root: "0.1", tui: "0.1", rootLock: "0.1", rootLockPackage: "0.1" }
  }), /SemVer/);
});

test("staging writes the whole file set and nothing else", (t) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "1667-release-archive-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const evidencePath = path.join(scratch, "release-source-evidence.json");
  writeFileSync(evidencePath, `${canonicalJson(evidence())}\n`, "utf8");
  const buildDirectory = path.join(scratch, "dist");
  mkdirSync(buildDirectory, { recursive: true });
  const stubExecutable = "#!/bin/sh\necho stub\n";
  writeFileSync(path.join(buildDirectory, "1667"), stubExecutable, {
    encoding: "utf8",
    mode: 0o644,
    flag: "w"
  });

  const staged = stageReleaseArchive({
    evidencePath,
    target: "linux-x64",
    buildDirectory,
    outputDirectory: path.join(scratch, "stage")
  });

  assert.equal(staged.stem, "1667_0.1.0-rc.1_linux-x64");
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
  assert.equal(statSync(path.join(staged.directory, "1667")).mode & 0o777, 0o755);
  assert.equal(
    readFileSync(path.join(staged.directory, RELEASE_BUILD_MANIFEST_FILE), "utf8"),
    `${canonicalJson(createReleasePackageBuildManifest(
      createReleaseIdentitySet(evidence()).evidence,
      releaseTargetForArtifact("linux-x64").packageName,
      "linux-x64"
    ))}\n`
  );
  const sbom = parseJsonRejectingDuplicateKeys(
    readFileSync(path.join(staged.directory, RELEASE_SBOM_FILE), "utf8")
  ) as { name?: unknown; spdxVersion?: unknown };
  assert.equal(sbom.spdxVersion, "SPDX-2.3");
  assert.equal(sbom.name, `@1667-ai/linux-x64@${VERSION}`);
});

test("staging fails on a missing executable rather than writing a partial archive", (t) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "1667-release-archive-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const evidencePath = path.join(scratch, "release-source-evidence.json");
  writeFileSync(evidencePath, `${canonicalJson(evidence())}\n`, "utf8");
  // No stub executable: staging must fail on a missing input rather than write
  // a partial archive.
  assert.throws(() => stageReleaseArchive({
    evidencePath,
    target: "linux-x64",
    buildDirectory: path.join(scratch, "dist"),
    outputDirectory: path.join(scratch, "stage")
  }), /Release executable|ENOENT/);
});

test("the release notes claim the attestation and nothing it does not have", () => {
  const notes = releaseNotesMarkdown(VERSION);
  assert.match(notes, /^# 1667 v0\.1\.0-rc\.1$/mu);
  assert.match(notes, /pre-release/u);
  for (const target of PUBLISHED_RELEASE_TARGETS) {
    assert.ok(
      notes.includes(releaseArchiveFileName(VERSION, target)),
      `notes omit the ${target} archive`
    );
  }
  assert.match(notes, /gh attestation verify [^\n]+ --repo 1667-ai\/1667/u);
  assert.match(notes, /checksums\.txt/u);
  // Held, named, and explained: a reader must not be left guessing why their
  // platform is absent.
  assert.match(notes, /windows-x64/u);
  assert.match(notes, /build:standalone/u);
  assert.ok(!notes.includes(`1667_${VERSION}_windows-x64.tar.gz`));
  // npm publication is not available, and is not promised on a date. The
  // prerelease identifier is explained rather than left to look like a slip.
  assert.match(notes, /does not publish an npm package yet/u);
  assert.match(notes, /`0\.1\.0-rc\.1`\. `0\.1\.0` is held for the first npm publication/u);
  assert.doesNotMatch(releaseNotesMarkdown("1.2.3"), /is held for the first npm publication/u);
  // No install script, in any form: not a script, not a one-liner, not a
  // pipeline into a shell.
  assert.doesNotMatch(notes, /\|\s*(?:sh|bash|zsh)\b/u);
  assert.doesNotMatch(notes, /install\.sh|get\.1667|curl\s+-|wget\s/u);
  // Attestations, not a verified signed tag.
  assert.doesNotMatch(notes, /verified tag|tag signature|signed tag is|signature-verified/iu);
  assert.match(notes, /There is no signed tag/u);
  assert.throws(() => releaseNotesMarkdown("0.1"), /SemVer/);
});

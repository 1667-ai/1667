import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  githubReleaseSourceEvidence,
  releaseIdentitiesForSource
} from "../scripts/release-source-facts.js";
import { releaseNotesMarkdown } from "../scripts/release-github-notes.js";
import {
  releaseArchiveFileName,
  releaseArchiveStem,
  RELEASE_CHECKSUMS_FILE
} from "../scripts/release-archive.js";

/** Reads the one publication policy, so no test here carries a target list. */
function heldFromPublication(target: BuiltArtifactTarget): boolean {
  return releaseTargetForArtifact(target).heldFromPublication !== null;
}

const REPOSITORY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The version this release ships under. Tests that specifically exercise a
// prerelease identifier use the separate hyphenated value.
const VERSION = "0.1.0";
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
const WORKFLOW = readFileSync(
  path.join(REPOSITORY_ROOT, ".github", "workflows", "release-github.yml"),
  "utf8"
);
const RELEASE_ASSETS_CLI = path.join(
  REPOSITORY_ROOT,
  "scripts",
  "release-github-assets.ts"
);

function digestOf(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The workflow's jobs, each as the block of text between its own header and the
 * next one. Enough to ask which job holds which permission and which commands
 * run inside it, without a YAML parser this repository does not depend on.
 */
function workflowJobs(): ReadonlyMap<string, string> {
  const body = WORKFLOW.slice(WORKFLOW.indexOf("\njobs:\n"));
  const headers = [...body.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gmu)];
  const jobs = new Map<string, string>();
  headers.forEach((header, index) => {
    const start = header.index;
    const end = index + 1 < headers.length ? headers[index + 1]!.index : body.length;
    jobs.set(header[1]!, body.slice(start, end));
  });
  return jobs;
}

test("the archive release CLI refuses the stable version reserved for npm", () => {
  const run = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      RELEASE_ASSETS_CLI,
      "check",
      VERSION,
      SOURCE_COMMIT,
      BUILD_TIMESTAMP
    ],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8"
    }
  );
  assert.notEqual(run.status, 0);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /GitHub archive release 0\.1\.0 must be a prerelease/u);
});

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

test("a target held from publication has no archive at all", () => {
  assert.deepEqual(
    RELEASE_TARGETS
      .filter((descriptor) => descriptor.heldFromPublication !== null)
      .map((descriptor) => descriptor.artifactTarget),
    ["windows-x64"]
  );
  assert.ok(BUILT_ARTIFACT_TARGETS.includes("windows-x64"));
  assert.ok(!(PUBLISHED_ARTIFACT_TARGETS as readonly string[]).includes("windows-x64"));
  assert.ok(heldFromPublication("windows-x64"));
  assert.throws(
    () => releaseArchiveFileSet("windows-x64", VERSION),
    /windows-x64 is held from publication/
  );
  assert.throws(
    () => releaseArchiveStem(VERSION, "windows-x64"),
    /windows-x64 is held from publication/
  );
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
  assert.equal(stem, "1667_0.1.0_linux-x64");
  assert.equal(releaseArchiveFileName(VERSION, "linux-x64"), "1667_0.1.0_linux-x64.tar.gz");
  assert.equal(releaseArchiveFileName("1.2.3", "darwin-arm64"), "1667_1.2.3_darwin-arm64.tar.gz");
  assert.throws(() => releaseArchiveStem("0.1", "linux-x64"), /SemVer/);
  assert.throws(() => releaseContentFileSet("linux-x64", "v0.1.0"), /SemVer/);
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
  const identities = releaseIdentitiesForSource(FACTS);
  assert.equal(identities.evidence.productVersion, VERSION);
  assert.equal(identities.evidence.tagName, `v${VERSION}`);
  assert.equal(identities.evidence.tagTargetCommit, SOURCE_COMMIT);
  for (const target of PUBLISHED_ARTIFACT_TARGETS) {
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
  const buildDirectory = path.join(scratch, "dist");
  mkdirSync(buildDirectory, { recursive: true });
  const stubExecutable = "#!/bin/sh\necho stub\n";
  writeFileSync(path.join(buildDirectory, "1667"), stubExecutable, {
    encoding: "utf8",
    mode: 0o644,
    flag: "w"
  });

  let sourceCommitReads = 0;
  const staged = stageReleaseArchive({
    version: FACTS.version,
    get sourceCommit(): string {
      sourceCommitReads += 1;
      return sourceCommitReads === 1 ? SOURCE_COMMIT : "f".repeat(40);
    },
    buildTimestamp: FACTS.buildTimestamp,
    target: "linux-x64",
    buildDirectory,
    outputDirectory: path.join(scratch, "stage")
  });

  assert.equal(sourceCommitReads, 1);
  assert.equal(staged.stem, "1667_0.1.0_linux-x64");
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
  const buildManifestText = readFileSync(
    path.join(staged.directory, RELEASE_BUILD_MANIFEST_FILE),
    "utf8"
  );
  assert.equal(
    buildManifestText,
    `${canonicalJson(createReleasePackageBuildManifest(
      releaseIdentitiesForSource(FACTS).evidence,
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

  // The accepted wart, held to memory. The evidence codec types
  // `tagSignature: "verified"` as a literal, so the identity every job builds
  // asserts a signature nothing verified. That is tolerable only while the
  // claim never reaches a file, so no staged file may carry either tag field.
  // `tagName` is a different thing and may ship: it names the tag the release
  // job creates at this commit and claims nothing about a signature.
  for (const shipped of [buildManifestText, sbomText]) {
    assert.doesNotMatch(shipped, /tagSignature|tagObjectType|"verified"/u);
  }
  assert.match(sbomText, /Built from tag v0\.1\.0 at a clean working tree/u);
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

  const stems = new Set<string>();
  for (const target of PUBLISHED_ARTIFACT_TARGETS) {
    const staged = stageReleaseArchive({
      ...FACTS,
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
    ...FACTS,
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

// The forgeable-credential guard. A `ReleaseSourceEvidence` document asserts a
// verified signed tag by construction, and scripts/release-preflight.ts accepts
// exactly that document as the signed-tag evidence gating npm publication. One
// written to disk and uploaded from a pre-release run would be downloadable and
// sufficient, so reintroducing the upload must fail here rather than pass
// review.
test("the release workflow passes three strings between jobs and uploads no evidence", () => {
  assert.ok(!WORKFLOW.includes("release-source-evidence"));

  const lines = WORKFLOW.split("\n");
  // Every artifact path in the file, uploaded or downloaded. Archives out,
  // archives back in, and nothing else.
  const artifactPaths = lines
    .filter((line) => /^\s+path:\s/u.test(line))
    .map((line) => line.replace(/^\s+path:\s*/u, "").trim());
  assert.deepEqual(artifactPaths, ["dist/archives/*.tar.gz", "dist/assets"]);
  // No key that names a file or an artifact may mention evidence, whatever the
  // file is called. Prose in the comments above may, and must.
  for (const line of lines) {
    assert.doesNotMatch(line, /^\s*-?\s*(?:name|path|pattern):.*evidence/iu);
  }

  // The three facts, and only the three facts plus the target list, are the
  // prepare job's outputs.
  const outputs = /\n    outputs:\n((?:      [^\n]*\n)+)/u.exec(WORKFLOW)?.[1];
  assert.equal(outputs, [
    "      targets: ${{ steps.policy.outputs.targets }}",
    "      version: ${{ steps.source.outputs.version }}",
    "      commit: ${{ steps.source.outputs.commit }}",
    "      timestamp: ${{ steps.source.outputs.timestamp }}",
    ""
  ].join("\n"));
  for (const fact of ["version", "commit", "timestamp"] as const) {
    assert.ok(
      WORKFLOW.includes(`\${{ needs.prepare.outputs.${fact} }}`),
      `the build matrix never reads ${fact}`
    );
  }
  // The commands the build job runs take the three values, not a file.
  assert.match(
    WORKFLOW,
    /release-github-assets\.ts identity \\\n\s+"\$VERSION" "\$COMMIT" "\$TIMESTAMP" "\$TARGET"/u
  );
  assert.match(
    WORKFLOW,
    /release-github-assets\.ts stage \\\n\s+"\$VERSION" "\$COMMIT" "\$TIMESTAMP" "\$TARGET" /u
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

test("the build job proves the machine is the matrix target before it compiles", () => {
  const build = workflowJobs().get("build");
  assert.ok(build !== undefined);
  const proof = build.indexOf('release-github-assets.ts runner "$TARGET"');
  const compile = build.indexOf("bun run build:standalone");
  assert.ok(proof > 0, "the build job never checks the machine against matrix.target");
  assert.ok(compile > proof, "the machine check must run before anything is compiled");
  assert.match(build, /TARGET: \$\{\{ matrix\.target \}\}/u);
});

/**
 * The attestation is the only evidence this release path offers, and the notes
 * tell readers to verify with it. A postinstall script in the job that can mint
 * an OIDC token could attest bytes this workflow never built, under this
 * repository's name, so the elevated job installs without running any.
 */
test("no job holding a write permission runs a dependency install script", () => {
  const jobs = workflowJobs();
  assert.deepEqual([...jobs.keys()], ["prepare", "build", "release"]);
  for (const [name, body] of jobs) {
    const elevated = /^ {6}(?:id-token|attestations|contents|packages|actions):\s*write$/mu.test(body);
    if (!elevated) continue;
    const installs = [...body.matchAll(/^\s+run: (npm ci[^\n]*)$/gmu)].map((match) => match[1]!);
    assert.ok(installs.length > 0, `${name} holds a write permission and installs nothing`);
    for (const install of installs) {
      assert.ok(
        install.includes("--ignore-scripts"),
        `${name} holds a write permission and runs \`${install}\``
      );
    }
  }
  const release = jobs.get("release");
  assert.ok(release !== undefined);
  assert.match(release, /^ {6}id-token: write$/mu);
  assert.match(release, /^ {6}attestations: write$/mu);
  assert.match(release, /attest-build-provenance/u);
});

test("the release notes claim the attestation and nothing it does not have", () => {
  const notes = releaseNotesMarkdown(PRERELEASE_VERSION);
  assert.match(notes, /^# 1667 v0\.1\.0-rc\.1$/mu);
  assert.match(notes, /pre-release/u);
  for (const target of PUBLISHED_ARTIFACT_TARGETS) {
    assert.ok(
      notes.includes(releaseArchiveFileName(PRERELEASE_VERSION, target)),
      `notes omit the ${target} archive`
    );
  }
  assert.match(notes, /gh attestation verify [^\n]+ --repo 1667-ai\/1667/u);
  assert.match(notes, /checksums\.txt/u);
  // Held, named, and explained: a reader must not be left guessing why their
  // platform is absent.
  assert.match(notes, /windows-x64/u);
  assert.match(notes, /build:standalone/u);
  assert.ok(!notes.includes(`1667_${PRERELEASE_VERSION}_windows-x64.tar.gz`));
  // This workflow cannot determine registry availability. Its notes make no
  // npm availability claim. The prerelease identifier is explained rather
  // than left to look like a slip, and the explanation is the standing rule
  // rather than this release's place in any sequence.
  assert.doesNotMatch(notes, /^## npm$/mu);
  assert.match(notes, /`0\.1\.0-rc\.1`, a preview of `0\.1\.0`/u);
  assert.match(notes, /npm cannot replace a version once it is published/u);
  assert.doesNotMatch(releaseNotesMarkdown("1.2.3"), /a preview of/u);
  // No install script, in any form: not a script, not a one-liner, not a
  // pipeline into a shell.
  assert.doesNotMatch(notes, /\|\s*(?:sh|bash|zsh)\b/u);
  assert.doesNotMatch(notes, /install\.sh|get\.1667|curl\s+-|wget\s/u);
  // Attestations, not a verified signed tag.
  assert.doesNotMatch(notes, /verified tag|tag signature|signed tag is|signature-verified/iu);
  assert.match(notes, /There is no signed tag/u);
  assert.throws(() => releaseNotesMarkdown("0.1"), /SemVer/);
});

/**
 * The notes are generated from the version alone, and the workflow can be
 * dispatched again at any version. A sentence true only of the first release —
 * "the first published builds", "held for the first npm publication" — would go
 * false at the next dispatch with nothing failing, because a test that asserts
 * the sentence is present passes just as happily when the sentence is wrong.
 * So assert the property instead: at versions this repository has not reached,
 * the notes still claim nothing but what the version and the target policy say.
 */
test("the release notes stay true at every version the workflow can be dispatched at", () => {
  const cases = [
    { version: "0.1.0-rc.1", stable: "0.1.0" },
    { version: "0.2.0-rc.1", stable: "0.2.0" },
    { version: "7.3.1-beta.2", stable: "7.3.1" },
    { version: "1.0.0", stable: null }
  ] as const;
  for (const { version, stable } of cases) {
    const notes = releaseNotesMarkdown(version);
    assert.ok(notes.startsWith(`# 1667 v${version}\n`), `notes misname v${version}`);
    // No claim about this release's place in any sequence. Every one of these
    // words dates the notes to a release that has already happened, and the
    // next dispatch would ship them unchanged.
    assert.doesNotMatch(
      notes,
      /\bfirst\b|\binitial\b|\bdebut\b|\bearliest\b|\bso far\b/iu,
      `notes for v${version} claim a place in the release history`
    );
    // Everything a reader is told to download or verify is derived from the
    // version and the target policy, at any version.
    for (const target of PUBLISHED_ARTIFACT_TARGETS) {
      assert.ok(
        notes.includes(releaseArchiveFileName(version, target)),
        `notes for v${version} omit the ${target} archive`
      );
    }
    assert.ok(
      notes.includes(`gh attestation verify ${releaseArchiveFileName(
        version,
        PUBLISHED_ARTIFACT_TARGETS[0]!
      )} --repo 1667-ai/1667`),
      `notes for v${version} verify some other file`
    );
    // Held targets are named from policy, and what a reader may assume about
    // them claims nothing continuous. "built and tested on every change to
    // `main`" was such a claim, and it went false the day CI stopped building
    // the target it described — in notes that had already shipped.
    assert.doesNotMatch(
      notes,
      /every change|continuously|always (?:built|verified|tested)/u,
      `notes for v${version} promise a verification nothing here enforces`
    );
    if (RELEASE_TARGETS.some((descriptor) => descriptor.heldFromPublication !== null)) {
      assert.match(notes, /untested/u, `notes for v${version} leave a held target's status open`);
    }
    if (stable === null) {
      assert.doesNotMatch(notes, /a preview of/u, `v${version} is no preview`);
      continue;
    }
    // The prerelease explanation names the two version strings it was built
    // from and states a rule about npm that does not depend on the date.
    assert.ok(
      notes.includes(`This build is \`${version}\`, a preview of \`${stable}\`.`),
      `notes for v${version} explain the prerelease identifier with the wrong versions`
    );
  }
  // "Every release on this path is a pre-release" is a claim about the
  // workflow, not about this version, so bind it to the workflow: `gh release
  // create` marks every release this path publishes as one.
  assert.match(WORKFLOW, /^\s+--prerelease\s*\\?$/mu);
});

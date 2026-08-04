import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PUBLISHED_ARTIFACT_TARGETS } from "../shared/release-targets.js";
import {
  directoryAssetDigests,
  formatReleaseChecksums
} from "../scripts/release-github-assets.js";
import {
  expectedGitHubReleaseAssetNames,
  expectedInstallerNames
} from "../scripts/release-publication-assets.js";
import {
  releaseRunTimestamp,
  verifyReleaseAttestations
} from "../scripts/release-npm-ci.js";
import {
  assertGitHubReleaseCompatibleForPublication,
  publishOrVerifyGitHubRelease,
  verifyNpmReleaseAssetDirectory
} from "../scripts/release-npm-github.js";
import {
  fakeReleaseGh,
  writeArchiveOnlyReleaseAssetFixture,
  writeReleaseAssetFixture
} from "./release-npm-github-fixture.js";

const VERSION = "1.2.3";
const PRE_VERSION = "1.2.3-rc.1";
const REPOSITORY = "1667-ai/1667";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TIMESTAMP = "2026-07-28T10:20:30.000Z";
const SOURCE_REF = `refs/tags/v${VERSION}`;
const execFileAsync = promisify(execFile);
const GITHUB_RELEASE_CLI = fileURLToPath(
  new URL("../scripts/release-npm-github.ts", import.meta.url)
);

test("CI attestation verification checks the exact retained file set", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-ci-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputs = path.join(root, "inputs");
  const nested = path.join(inputs, "nested");
  const log = path.join(root, "gh.log");
  const gh = path.join(root, "gh");
  await mkdir(nested, { recursive: true });
  await Promise.all([
    writeFile(path.join(inputs, "a"), "a"),
    writeFile(path.join(nested, "b"), "b"),
    writeFile(gh, [
      `#!${process.execPath}`,
      `require("node:fs").appendFileSync(${JSON.stringify(log)},`
        + " `${JSON.stringify(process.argv.slice(2))}\\n`);",
      "if (process.argv[2] === \"api\") process.stdout.write(\"2026-07-28T10:20:30Z\\n\");",
      ""
    ].join("\n"))
  ]);
  await chmod(gh, 0o755);
  const environment = {
    GITHUB_REPOSITORY: "1667-ai/1667",
    GITHUB_RUN_ID: "12345",
    GITHUB_REF: SOURCE_REF,
    GITHUB_SHA: COMMIT,
    SIGNER_WORKFLOW: "1667-ai/1667/.github/workflows/release-npm.yml",
    GH_TOKEN: "test-token",
    HOME: root
  };
  await assert.rejects(releaseRunTimestamp(environment), /RELEASE_GH_PATH/u);
  assert.equal(await releaseRunTimestamp(environment, gh), TIMESTAMP);
  const verified = await verifyReleaseAttestations(inputs, 2, environment, gh);
  const inputRoot = await realpath(inputs);
  assert.deepEqual(verified.map((file) => path.relative(inputRoot, file)), ["a", "nested/b"]);
  await assert.rejects(
    verifyReleaseAttestations(inputs, 3, environment, gh),
    /2 files, expected 3/u
  );
  await symlink(path.join(inputs, "a"), path.join(inputs, "link"));
  await assert.rejects(
    verifyReleaseAttestations(inputs, 3, environment, gh),
    /symbolic link/u
  );
  const calls = (await readFile(log, "utf8")).trimEnd().split("\n").map((line) => {
    return JSON.parse(line) as string[];
  });
  assert.equal(calls[0]?.[0], "api");
  assert.deepEqual(calls.slice(1).map((args) => args[2]), verified);
  for (const args of calls.slice(1)) {
    assert.ok(args.includes("--deny-self-hosted-runners"));
    assert.ok(args.includes(COMMIT));
  }
});

test("GitHub release publication verifies exact assets before and after upload", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-github-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  const remote = path.join(root, "remote");
  const state = path.join(root, "state.json");
  const log = path.join(root, "gh.log");
  const notes = path.join(root, "notes.md");
  const gh = path.join(root, "gh");
  await mkdir(assets);
  await writeReleaseAssetFixture(assets, VERSION, REPOSITORY);
  await execFileAsync(process.execPath, [
    "--import",
    "tsx",
    GITHUB_RELEASE_CLI,
    "verify-assets",
    VERSION,
    REPOSITORY,
    assets
  ]);
  const observation = path.join(assets, `${PUBLISHED_ARTIFACT_TARGETS[0]}.json`);
  const observationBytes = await readFile(observation);
  await rm(observation);
  assert.throws(
    () => verifyNpmReleaseAssetDirectory(assets, VERSION, REPOSITORY),
    /unexpected asset set|missing/u
  );
  await writeFile(observation, observationBytes);
  await writeFile(notes, "# Release\n");
  await writeFile(gh, fakeReleaseGh({ remote, state, log }));
  await chmod(gh, 0o755);
  const options = {
    version: VERSION,
    assetsDirectory: assets,
    notesFile: notes,
    environment: {
      GITHUB_REPOSITORY: REPOSITORY,
      GH_TOKEN: "test-token",
      HOME: root
    },
    ghExecutable: gh
  };
  await publishOrVerifyGitHubRelease(options);
  await publishOrVerifyGitHubRelease(options);
  const remoteTarball = (await readdirNames(remote)).find((name) => name.endsWith(".tgz"));
  assert.ok(remoteTarball !== undefined);
  await writeFile(path.join(remote, remoteTarball), "different remote bytes");
  await writeFile(
    path.join(remote, "checksums.txt"),
    formatReleaseChecksums(directoryAssetDigests(remote))
  );
  await assert.rejects(
    publishOrVerifyGitHubRelease(options),
    /differs from the local assets/u
  );
  const calls = (await readFile(log, "utf8")).trimEnd().split("\n").map((line) => {
    return JSON.parse(line) as string[];
  });
  assert.equal(calls.filter((args) => args[1] === "create").length, 1);
  assert.equal(calls.filter((args) => args[1] === "edit").length, 1);
  assert.equal(calls.filter((args) => args[1] === "download").length, 3);
  const localTarball = (await readdirNames(assets)).find((name) => name.endsWith(".tgz"));
  assert.ok(localTarball !== undefined);
  const localBytes = await readFile(path.join(assets, localTarball));
  await writeFile(path.join(assets, localTarball), "changed");
  assert.throws(
    () => verifyNpmReleaseAssetDirectory(assets, VERSION, REPOSITORY),
    /checksums do not match/u
  );
  await writeFile(path.join(assets, localTarball), localBytes);
  // Beta installer copied over stable, even with regenerated checksums, is rejected.
  const betaBody = await readFile(path.join(assets, "install-beta.sh"));
  await writeFile(path.join(assets, "install-stable.sh"), betaBody);
  await writeFile(
    path.join(assets, "checksums.txt"),
    formatReleaseChecksums(directoryAssetDigests(assets))
  );
  assert.throws(
    () => verifyNpmReleaseAssetDirectory(assets, VERSION, REPOSITORY),
    /install-stable\.sh does not match deterministic channel contents/u
  );
  await writeReleaseAssetFixture(assets, VERSION, REPOSITORY);
  await writeFile(path.join(assets, "unexpected.txt"), "unexpected");
  assert.throws(
    () => verifyNpmReleaseAssetDirectory(assets, VERSION, REPOSITORY),
    /unexpected asset set/u
  );
});

test("GitHub release verification binds installers to channel digests and rejects prerelease stable", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-github-installers-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const releaseAssets = path.join(root, "release");
  await mkdir(releaseAssets);
  await writeReleaseAssetFixture(releaseAssets, VERSION, REPOSITORY);
  const verified = verifyNpmReleaseAssetDirectory(releaseAssets, VERSION, REPOSITORY);
  assert.ok(verified.some((file) => path.basename(file) === "install-stable.sh"));
  assert.ok(verified.some((file) => path.basename(file) === "install-beta.sh"));
  assert.ok(verified.some((file) => path.basename(file) === "install-stable.ps1"));
  assert.ok(verified.some((file) => path.basename(file) === "install-beta.ps1"));

  const wrongRepo = path.join(root, "wrong-repo");
  await mkdir(wrongRepo);
  await writeReleaseAssetFixture(wrongRepo, VERSION, REPOSITORY);
  assert.throws(
    () => verifyNpmReleaseAssetDirectory(wrongRepo, VERSION, "other-org/other-repo"),
    /does not match deterministic channel contents/u
  );

  const preAssets = path.join(root, "prerelease");
  await mkdir(preAssets);
  await writeReleaseAssetFixture(preAssets, PRE_VERSION, REPOSITORY);
  assert.deepEqual(
    expectedInstallerNames(PRE_VERSION),
    ["install-beta.sh", "install-beta.ps1"]
  );
  assert.ok(!expectedGitHubReleaseAssetNames(PRE_VERSION).includes("install-stable.sh"));
  assert.ok(!expectedGitHubReleaseAssetNames(PRE_VERSION).includes("install-stable.ps1"));
  verifyNpmReleaseAssetDirectory(preAssets, PRE_VERSION, REPOSITORY);
  await writeFile(path.join(preAssets, "install-stable.sh"), "not a real installer\n");
  await writeFile(
    path.join(preAssets, "checksums.txt"),
    formatReleaseChecksums(directoryAssetDigests(preAssets))
  );
  assert.throws(
    () => verifyNpmReleaseAssetDirectory(preAssets, PRE_VERSION, REPOSITORY),
    /must not contain install-stable\.sh|unexpected asset set/u
  );
});

// Issue #5 review: release-github.yml can now create a GitHub release for a
// stable version too, in a concurrency group release-npm.yml never shares.
// assertGitHubReleaseCompatibleForPublication is what preflight calls to
// discover an incompatible existing release before publish, rather than
// after it, the way publishOrVerifyGitHubRelease alone would.
test("assertGitHubReleaseCompatibleForPublication permits no release and permits a draft", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-existing-none-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote");
  const state = path.join(root, "state.json");
  const log = path.join(root, "gh.log");
  const gh = path.join(root, "gh");
  await writeFile(gh, fakeReleaseGh({ remote, state, log }));
  await chmod(gh, 0o755);
  const environment = { GITHUB_REPOSITORY: REPOSITORY, GH_TOKEN: "test-token", HOME: root };

  // Nothing to conflict with.
  await assertGitHubReleaseCompatibleForPublication({ version: VERSION, environment, ghExecutable: gh });

  // publishOrVerifyGitHubRelease deletes and recreates a draft, so a draft
  // cannot conflict with what it will do either, whatever it contains.
  await mkdir(remote, { recursive: true });
  await writeFile(state, JSON.stringify({ isDraft: true, isImmutable: false, isPrerelease: false }));
  await assertGitHubReleaseCompatibleForPublication({ version: VERSION, environment, ghExecutable: gh });
});

test("assertGitHubReleaseCompatibleForPublication permits a matching completed release and refuses a channel mismatch", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-existing-match-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote");
  const state = path.join(root, "state.json");
  const log = path.join(root, "gh.log");
  const gh = path.join(root, "gh");
  await mkdir(remote, { recursive: true });
  await writeReleaseAssetFixture(remote, VERSION, REPOSITORY);
  await writeFile(gh, fakeReleaseGh({ remote, state, log }));
  await chmod(gh, 0o755);
  const environment = { GITHUB_REPOSITORY: REPOSITORY, GH_TOKEN: "test-token", HOME: root };

  // A completed release carrying the full npm-publication asset set on the
  // right channel — what a resumed or rerun workflow leaves behind. publish
  // must be free to proceed.
  await writeFile(state, JSON.stringify({ isDraft: false, isImmutable: true, isPrerelease: false }));
  await assertGitHubReleaseCompatibleForPublication({ version: VERSION, environment, ghExecutable: gh });

  // The same asset set, but the wrong channel for VERSION.
  await writeFile(state, JSON.stringify({ isDraft: false, isImmutable: true, isPrerelease: true }));
  await assert.rejects(
    assertGitHubReleaseCompatibleForPublication({ version: VERSION, environment, ghExecutable: gh }),
    /is not an immutable release npm publication can publish alongside/u
  );
});

test("assertGitHubReleaseCompatibleForPublication refuses an archive-only release release-github.yml could have created", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-existing-archive-only-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote");
  const state = path.join(root, "state.json");
  const log = path.join(root, "gh.log");
  const gh = path.join(root, "gh");
  await mkdir(remote, { recursive: true });
  await writeArchiveOnlyReleaseAssetFixture(remote, VERSION, REPOSITORY);
  await writeFile(state, JSON.stringify({ isDraft: false, isImmutable: true, isPrerelease: false }));
  await writeFile(gh, fakeReleaseGh({ remote, state, log }));
  await chmod(gh, 0o755);

  await assert.rejects(
    assertGitHubReleaseCompatibleForPublication({
      version: VERSION,
      environment: { GITHUB_REPOSITORY: REPOSITORY, GH_TOKEN: "test-token", HOME: root },
      ghExecutable: gh
    }),
    /does not carry the asset set npm publication expects/u
  );
});

/**
 * Confirms, rather than assumes, what publishOrVerifyGitHubRelease does when
 * it meets an archive-only release release-github.yml could have created: it
 * does refuse — this is not a silent acceptance — but only after it has
 * already downloaded the existing release, which in the real workflow is a
 * step inside the `release` job that runs after `publish` has already
 * written to npm. That npm write cannot be withdrawn once it lands, which is
 * exactly why assertGitHubReleaseCompatibleForPublication has to run earlier,
 * in `preflight`, before `publish` ever starts — this test is the evidence
 * that the earlier check is doing real work and not guarding against
 * something publishOrVerifyGitHubRelease already handled safely.
 */
test("publishOrVerifyGitHubRelease refuses an archive-only existing release too, but only after downloading it", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-github-late-refusal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  await mkdir(assets);
  await writeReleaseAssetFixture(assets, VERSION, REPOSITORY);
  const remote = path.join(root, "remote");
  const state = path.join(root, "state.json");
  const log = path.join(root, "gh.log");
  const notes = path.join(root, "notes.md");
  const gh = path.join(root, "gh");
  await mkdir(remote, { recursive: true });
  await writeArchiveOnlyReleaseAssetFixture(remote, VERSION, REPOSITORY);
  await writeFile(state, JSON.stringify({ isDraft: false, isImmutable: true, isPrerelease: false }));
  await writeFile(notes, "# Release\n");
  await writeFile(gh, fakeReleaseGh({ remote, state, log }));
  await chmod(gh, 0o755);

  await assert.rejects(
    publishOrVerifyGitHubRelease({
      version: VERSION,
      assetsDirectory: assets,
      notesFile: notes,
      environment: { GITHUB_REPOSITORY: REPOSITORY, GH_TOKEN: "test-token", HOME: root },
      ghExecutable: gh
    }),
    /unexpected asset set/u
  );
  const calls = (await readFile(log, "utf8")).trimEnd().split("\n").map((line) => {
    return JSON.parse(line) as string[];
  });
  // It reached "download" before refusing: the existing release passed the
  // channel check (isPrerelease already matches VERSION's channel here), and
  // was only caught by re-verifying the downloaded asset set, the step that
  // happens after the workflow's npm publish job has already run.
  assert.ok(calls.some((args) => args[1] === "download"));
  assert.ok(!calls.some((args) => args[1] === "create"));
});

async function readdirNames(directory: string): Promise<string[]> {
  return await readdir(directory);
}

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
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
  publishOrVerifyGitHubRelease,
  verifyNpmReleaseAssetDirectory
} from "../scripts/release-npm-github.js";
import {
  fakeReleaseGh,
  writeReleaseAssetFixture
} from "./release-npm-github-fixture.js";

const VERSION = "1.2.3";
const PRE_VERSION = "1.2.3-rc.1";
const REPOSITORY = "1667-ai/1667";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const execFileAsync = promisify(execFile);
const GITHUB_RELEASE_CLI = fileURLToPath(
  new URL("../scripts/release-npm-github.ts", import.meta.url)
);

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
  await writeFile(
    gh,
    fakeReleaseGh({ remote, state, log }, {
      tagObjectSha: "a".repeat(40),
      omitBypassActors: true
    })
  );
  await chmod(gh, 0o755);
  const options = {
    version: VERSION,
    sourceCommit: COMMIT,
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
  const publishedState = await readFile(state, "utf8");
  const invalidState = JSON.parse(publishedState) as Record<string, unknown>;
  invalidState.isDraft = true;
  invalidState.isImmutable = true;
  await writeFile(state, JSON.stringify(invalidState));
  await assert.rejects(
    publishOrVerifyGitHubRelease(options),
    /invalid lifecycle state/u
  );
  await writeFile(state, publishedState);
  const tamperedState = JSON.parse(publishedState) as Record<string, unknown>;
  tamperedState.body = "tampered notes\n";
  await writeFile(state, JSON.stringify(tamperedState));
  await assert.rejects(
    publishOrVerifyGitHubRelease(options),
    /title or notes do not match/u
  );
  await writeFile(state, publishedState);
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
  assert.equal(calls.filter((args) => args[1] === "delete").length, 0);
  assert.equal(calls.filter((args) => args[1] === "edit").length, 1);
  assert.equal(calls.filter((args) => args[1] === "download").length, 6);
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

test("GitHub release publication refuses a tag that moves during asset verification", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-github-moving-tag-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  const remote = path.join(root, "remote");
  const state = path.join(root, "state.json");
  const log = path.join(root, "gh.log");
  const notes = path.join(root, "notes.md");
  const gh = path.join(root, "gh");
  await mkdir(assets);
  await writeReleaseAssetFixture(assets, VERSION, REPOSITORY);
  await writeFile(notes, "# Release\n");
  await writeFile(gh, fakeReleaseGh(
    { remote, state, log },
    { tagCommit: COMMIT, moveTagAfterDownloadTo: "f".repeat(40) }
  ));
  await chmod(gh, 0o755);

  await assert.rejects(
    publishOrVerifyGitHubRelease({
      version: VERSION,
      sourceCommit: COMMIT,
      assetsDirectory: assets,
      notesFile: notes,
      environment: {
        GITHUB_REPOSITORY: REPOSITORY,
        GH_TOKEN: "test-token",
        HOME: root
      },
      ghExecutable: gh
    }),
    /does not target the dispatch commit/u
  );
  const calls = (await readFile(log, "utf8")).trimEnd().split("\n").map((line) => {
    return JSON.parse(line) as string[];
  });
  assert.equal(calls.some((args) => args[1] === "edit"), false);
});

test("GitHub release publication repairs a partial matching draft", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-github-partial-draft-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  const remote = path.join(root, "remote");
  const state = path.join(root, "state.json");
  const log = path.join(root, "gh.log");
  const notes = path.join(root, "notes.md");
  const gh = path.join(root, "gh");
  await mkdir(assets);
  await mkdir(remote);
  await writeReleaseAssetFixture(assets, VERSION, REPOSITORY);
  await writeFile(notes, "# Release\n");
  const firstAsset = (await readdirNames(assets))[0]!;
  await copyFile(path.join(assets, firstAsset), path.join(remote, firstAsset));
  await writeFile(state, JSON.stringify({
    body: "# Release\n",
    isDraft: true,
    isImmutable: false,
    isPrerelease: false,
    name: `1667 v${VERSION}`
  }));
  await writeFile(gh, fakeReleaseGh({ remote, state, log }));
  await chmod(gh, 0o755);

  await publishOrVerifyGitHubRelease({
    version: VERSION,
    sourceCommit: COMMIT,
    assetsDirectory: assets,
    notesFile: notes,
    environment: {
      GITHUB_REPOSITORY: REPOSITORY,
      GH_TOKEN: "test-token",
      HOME: root
    },
    ghExecutable: gh
  });

  assert.deepEqual((await readdirNames(remote)).sort(), (await readdirNames(assets)).sort());
  const calls = (await readFile(log, "utf8")).trimEnd().split("\n").map((line) => {
    return JSON.parse(line) as string[];
  });
  assert.equal(calls.filter((args) => args[1] === "upload").length, 1);
  assert.equal(calls.filter((args) => args[1] === "edit").length, 1);
});

test("GitHub release publication refuses a wrong-channel draft before publish", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-github-draft-channel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  const log = path.join(root, "gh.log");
  const notes = path.join(root, "notes.md");
  const gh = path.join(root, "gh");
  await mkdir(assets);
  await writeReleaseAssetFixture(assets, VERSION, REPOSITORY);
  await writeFile(notes, "# Release\n");
  await writeFile(gh, fakeReleaseGh({
    remote: path.join(root, "remote"),
    state: path.join(root, "state.json"),
    log
  }, { createdPrerelease: true }));
  await chmod(gh, 0o755);

  await assert.rejects(
    publishOrVerifyGitHubRelease({
      version: VERSION,
      sourceCommit: COMMIT,
      assetsDirectory: assets,
      notesFile: notes,
      environment: {
        GITHUB_REPOSITORY: REPOSITORY,
        GH_TOKEN: "test-token",
        HOME: root
      },
      ghExecutable: gh
    }),
    /not a draft release/u
  );
  const calls = (await readFile(log, "utf8")).trimEnd().split("\n").map((line) => {
    return JSON.parse(line) as string[];
  });
  assert.equal(calls.some((args) => args[1] === "edit"), false);
});

test("GitHub release publication resolves an ambiguous immutable transition", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-github-edit-replay-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  const notes = path.join(root, "notes.md");
  const gh = path.join(root, "gh");
  await mkdir(assets);
  await writeReleaseAssetFixture(assets, VERSION, REPOSITORY);
  await writeFile(notes, "# Release\n");
  await writeFile(gh, fakeReleaseGh({
    remote: path.join(root, "remote"),
    state: path.join(root, "state.json"),
    log: path.join(root, "gh.log")
  }, { failEditAfterWrite: true }));
  await chmod(gh, 0o755);
  const options = {
    version: VERSION,
    sourceCommit: COMMIT,
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
});

test("GitHub release publication verifies contents after the immutable transition", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-github-final-content-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  const notes = path.join(root, "notes.md");
  const gh = path.join(root, "gh");
  await mkdir(assets);
  await writeReleaseAssetFixture(assets, VERSION, REPOSITORY);
  await writeFile(notes, "# Release\n");
  await writeFile(gh, fakeReleaseGh({
    remote: path.join(root, "remote"),
    state: path.join(root, "state.json"),
    log: path.join(root, "gh.log")
  }, { tamperBodyOnEdit: true }));
  await chmod(gh, 0o755);
  const options = {
    version: VERSION,
    sourceCommit: COMMIT,
    assetsDirectory: assets,
    notesFile: notes,
    environment: {
      GITHUB_REPOSITORY: REPOSITORY,
      GH_TOKEN: "test-token",
      HOME: root
    },
    ghExecutable: gh
  };

  await assert.rejects(
    publishOrVerifyGitHubRelease(options),
    /title or notes do not match/u
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

async function readdirNames(directory: string): Promise<string[]> {
  return await readdir(directory);
}

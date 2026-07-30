import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { releaseArchiveFileName } from "../scripts/release-archive.js";
import {
  directoryAssetDigests,
  formatReleaseChecksums
} from "../scripts/release-github-assets.js";
import { renderInstallScriptsForVersion } from "../scripts/release-install-script.js";
import {
  expectedGitHubReleaseAssetNames,
  expectedInstallerNames
} from "../scripts/release-publication-assets.js";
import {
  releaseRunTimestamp,
  verifyReleaseAttestations
} from "../scripts/release-npm-ci.js";
import {
  publishOrVerifyGitHubRelease,
  verifyNpmReleaseAssetDirectory
} from "../scripts/release-npm-github.js";

const VERSION = "1.2.3";
const PRE_VERSION = "1.2.3-rc.1";
const REPOSITORY = "1667-ai/1667";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TIMESTAMP = "2026-07-28T10:20:30.000Z";
const SOURCE_REF = "refs/heads/main";
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
  await writeReleaseAssetFixture(assets);
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
    ["install-beta.sh"]
  );
  assert.ok(!expectedGitHubReleaseAssetNames(PRE_VERSION).includes("install-stable.sh"));
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

async function writeReleaseAssetFixture(
  directory: string,
  version: string = VERSION,
  repository: string = REPOSITORY
): Promise<void> {
  const installerNames = new Set(expectedInstallerNames(version));
  const names = expectedGitHubReleaseAssetNames(version).filter((name) => {
    return name !== "checksums.txt" && !installerNames.has(name);
  });
  await Promise.all(names.map((name) => writeFile(path.join(directory, name), `${name}\n`)));
  const digests: Record<string, string> = {};
  for (const target of PUBLISHED_ARTIFACT_TARGETS) {
    const archive = releaseArchiveFileName(version, target);
    const bytes = await readFile(path.join(directory, archive));
    digests[archive] = createHash("sha256").update(bytes).digest("hex");
  }
  const scripts = renderInstallScriptsForVersion({ version, repository, digests });
  await Promise.all(
    Object.entries(scripts).map(([name, body]) => writeFile(path.join(directory, name), body))
  );
  await writeFile(
    path.join(directory, "checksums.txt"),
    formatReleaseChecksums(directoryAssetDigests(directory))
  );
}

function fakeReleaseGh(paths: {
  readonly remote: string;
  readonly state: string;
  readonly log: string;
}): string {
  return [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    "const args = process.argv.slice(2);",
    `const remote = ${JSON.stringify(paths.remote)};`,
    `const state = ${JSON.stringify(paths.state)};`,
    `fs.appendFileSync(${JSON.stringify(paths.log)}, \`\${JSON.stringify(args)}\\n\`);`,
    "const command = args[1];",
    "if (command === \"view\") {",
    "  if (!fs.existsSync(state)) { process.stderr.write(\"release not found\\n\"); process.exit(1); }",
    "  process.stdout.write(fs.readFileSync(state));",
    "} else if (command === \"create\") {",
    "  fs.mkdirSync(remote, { recursive: true });",
    "  for (const file of args.slice(3)) {",
    "    if (file.startsWith(\"--\")) break;",
    "    fs.copyFileSync(file, path.join(remote, path.basename(file)));",
    "  }",
    "  fs.writeFileSync(state, JSON.stringify({isDraft:true,isImmutable:false,isPrerelease:true}));",
    "} else if (command === \"download\") {",
    "  const destination = args[args.indexOf(\"--dir\") + 1];",
    "  for (const name of fs.readdirSync(remote)) {",
    "    fs.copyFileSync(path.join(remote, name), path.join(destination, name));",
    "  }",
    "} else if (command === \"edit\") {",
    "  fs.writeFileSync(state, JSON.stringify({isDraft:false,isImmutable:true,isPrerelease:true}));",
    "} else if (command === \"delete\") {",
    "  fs.rmSync(remote, { recursive: true, force: true });",
    "  fs.rmSync(state, { force: true });",
    "} else {",
    "  process.stderr.write(`unsupported ${args.join(\" \")}\\n`);",
    "  process.exit(2);",
    "}",
    ""
  ].join("\n");
}

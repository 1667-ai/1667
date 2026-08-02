import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AI_1667_PRODUCT_VERSION } from "../shared/build-identity.js";
import { isSemVer } from "../shared/semver.js";

const REPOSITORY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE_VERSION = AI_1667_PRODUCT_VERSION;
const NIGHTLY_CLI = path.join(REPOSITORY_ROOT, "scripts", "release-nightly.ts");
const ASSETS_CLI = path.join(REPOSITORY_ROOT, "scripts", "release-github-assets.ts");

const LEADING_ZERO_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ORDINARY_COMMIT = "a123456789abcdef0123456789abcdef01234567";
const DIFFERENT_COMMIT = "b123456789abcdef0123456789abcdef01234567";
const TIMESTAMP = "2026-08-02T10:20:30.000Z";

test("the nightly version is the committed version, the UTC date, and the short commit", () => {
  const run = spawnSync(
    process.execPath,
    ["--import", "tsx", NIGHTLY_CLI, "version", ORDINARY_COMMIT, TIMESTAMP],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" }
  );
  assert.equal(run.status, 0);
  const version = run.stdout.trim();
  assert.equal(version, `${BASE_VERSION}-nightly.20260802.a123456`);
  assert.ok(isSemVer(version));
});

test("a short commit that SemVer refuses grows until SemVer accepts it", () => {
  const run = spawnSync(
    process.execPath,
    ["--import", "tsx", NIGHTLY_CLI, "version", LEADING_ZERO_COMMIT, TIMESTAMP],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" }
  );
  assert.equal(run.status, 0);
  const version = run.stdout.trim();
  assert.equal(version, `${BASE_VERSION}-nightly.20260802.0123456789a`);
  assert.ok(isSemVer(version));
});

test("the release source check accepts the nightly version this checkout produces", () => {
  const runVersion = spawnSync(
    process.execPath,
    ["--import", "tsx", NIGHTLY_CLI, "version", LEADING_ZERO_COMMIT, TIMESTAMP],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" }
  );
  assert.equal(runVersion.status, 0);
  const version = runVersion.stdout.trim();

  const runCheck = spawnSync(
    process.execPath,
    ["--import", "tsx", ASSETS_CLI, "check", version, LEADING_ZERO_COMMIT, TIMESTAMP],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" }
  );
  assert.equal(runCheck.status, 0);
  assert.match(runCheck.stdout, /^release source accepted:/u);
});

test("the release source check refuses a version that only looks like a nightly version", () => {
  const wrongBaseVersion = "99.99.99-nightly.20260802.a123456";
  const runWrongBase = spawnSync(
    process.execPath,
    ["--import", "tsx", ASSETS_CLI, "check", wrongBaseVersion, ORDINARY_COMMIT, TIMESTAMP],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" }
  );
  assert.notEqual(runWrongBase.status, 0);

  const hyphensInDate = `${BASE_VERSION}-nightly.2026-08-02.abc1234`;
  const runHyphenDate = spawnSync(
    process.execPath,
    ["--import", "tsx", ASSETS_CLI, "check", hyphensInDate, ORDINARY_COMMIT, TIMESTAMP],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" }
  );
  assert.notEqual(runHyphenDate.status, 0);

  const missingCommit = `${BASE_VERSION}-nightly.20260802`;
  const runMissingCommit = spawnSync(
    process.execPath,
    ["--import", "tsx", ASSETS_CLI, "check", missingCommit, ORDINARY_COMMIT, TIMESTAMP],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" }
  );
  assert.notEqual(runMissingCommit.status, 0);
});

test("a nightly run stops when no commit landed after the last Nightly Release", () => {
  const runAbsent = spawnSync(
    process.execPath,
    ["--import", "tsx", NIGHTLY_CLI, "decide", ORDINARY_COMMIT],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" }
  );
  assert.equal(runAbsent.status, 0);
  assert.equal(runAbsent.stdout, "build\n");

  const runDifferent = spawnSync(
    process.execPath,
    ["--import", "tsx", NIGHTLY_CLI, "decide", ORDINARY_COMMIT, DIFFERENT_COMMIT],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" }
  );
  assert.equal(runDifferent.status, 0);
  assert.equal(runDifferent.stdout, "build\n");

  const runSame = spawnSync(
    process.execPath,
    ["--import", "tsx", NIGHTLY_CLI, "decide", ORDINARY_COMMIT, ORDINARY_COMMIT],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" }
  );
  assert.equal(runSame.status, 0);
  assert.match(runSame.stdout, /^skip /u);
});

test("the nightly run decision refuses a value that is not a commit id", () => {
  const runInvalid = spawnSync(
    process.execPath,
    ["--import", "tsx", NIGHTLY_CLI, "decide", "not-a-forty-hex-commit"],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" }
  );
  assert.notEqual(runInvalid.status, 0);
});

test("the is-nightly command reports whether a version is a nightly version", () => {
  const runNightly = spawnSync(
    process.execPath,
    ["--import", "tsx", NIGHTLY_CLI, "is-nightly", `${BASE_VERSION}-nightly.20260802.a123456`],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" }
  );
  assert.equal(runNightly.status, 0);
  assert.equal(runNightly.stdout, "true\n");

  const runOrdinary = spawnSync(
    process.execPath,
    ["--import", "tsx", NIGHTLY_CLI, "is-nightly", `${BASE_VERSION}-rc.1`],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" }
  );
  assert.equal(runOrdinary.status, 0);
  assert.equal(runOrdinary.stdout, "false\n");
});

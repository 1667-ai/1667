import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { releaseUploadAssetPaths } from "../scripts/release-github-assets.js";
import {
  PRERELEASE_VERSION,
  RELEASE_ASSETS_CLI,
  REPOSITORY_ROOT,
  WORKFLOW,
  workflowJobs
} from "./release-workflow-fixture.js";

test("the nightly path builds every target and replaces one rolling release", () => {
  const jobs = workflowJobs();
  const buildJob = jobs.get("build");
  const releaseJob = jobs.get("release");
  assert.ok(buildJob !== undefined);
  assert.ok(releaseJob !== undefined);

  assert.match(WORKFLOW, /schedule:[\s\S]*?-\s*cron:/u);
  assert.match(WORKFLOW, /workflow_dispatch:/u);
  assert.match(WORKFLOW, /version:\s*\n(?:[^\n]*\n)*?\s+required:\s*false/u);
  assert.match(buildJob, /target:\s*\$\{\{\s*fromJSON\(needs\.prepare\.outputs\.targets\)\s*\}\}/u);

  assert.match(buildJob, /if:\s*needs\.prepare\.outputs\.proceed\s*==\s*'true'/u);
  assert.match(releaseJob, /if:\s*needs\.prepare\.outputs\.proceed\s*==\s*'true'/u);

  const nightlyStepMatch = releaseJob.match(/- name:\s*Publish the Nightly Release\n([\s\S]*?)(?=\n {6}- name:|\n {4}[a-z]|$)/u);
  assert.ok(nightlyStepMatch !== null);
  const nightlyStep = nightlyStepMatch[1]!;

  assert.match(
    nightlyStep,
    /readarray -t ASSETS < <\(node --import tsx scripts\/release-github-assets\.ts upload-list "\$VERSION" dist\/assets\)/u
  );
  const nightlyVersion = "0.1.0-nightly.20260802.a123456";
  assert.deepEqual(
    releaseUploadAssetPaths(nightlyVersion, "dist/assets"),
    [
      `dist/assets/1667_${nightlyVersion}_darwin-arm64.tar.gz`,
      `dist/assets/1667_${nightlyVersion}_darwin-x64.tar.gz`,
      `dist/assets/1667_${nightlyVersion}_linux-arm64.tar.gz`,
      `dist/assets/1667_${nightlyVersion}_linux-x64.tar.gz`,
      `dist/assets/1667_${nightlyVersion}_windows-x64.tar.gz`,
      "dist/assets/install-nightly.sh",
      "dist/assets/install-nightly.ps1",
      "dist/assets/checksums.txt"
    ]
  );
  const deleteIndex = nightlyStep.indexOf("gh release delete-asset");
  const uploadIndex = nightlyStep.indexOf("gh release upload nightly");
  assert.ok(deleteIndex !== -1, "nightly step must call gh release delete-asset");
  assert.ok(uploadIndex !== -1, "nightly step must call gh release upload nightly");
  assert.ok(deleteIndex < uploadIndex, "delete must appear before upload in the nightly release step");

  assert.match(releaseJob, /if:\s*needs\.prepare\.outputs\.nightly\s*!=\s*'true'/u);
  assert.match(releaseJob, /if:\s*needs\.prepare\.outputs\.nightly\s*==\s*'true'/u);
});

test("the upload-list command outputs expected asset paths for nightly and prerelease versions", () => {
  const nightlyVersion = "0.1.0-nightly.20260802.a123456";
  const prereleaseVersion = PRERELEASE_VERSION;

  const nightlyRun = spawnSync(
    process.execPath,
    ["--import", "tsx", RELEASE_ASSETS_CLI, "upload-list", nightlyVersion, "dist/assets"],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" }
  );
  assert.equal(nightlyRun.status, 0);
  assert.equal(
    nightlyRun.stdout,
    releaseUploadAssetPaths(nightlyVersion, "dist/assets").join("\n") + "\n"
  );
  assert.deepEqual(
    nightlyRun.stdout.trim().split("\n"),
    [
      `dist/assets/1667_${nightlyVersion}_darwin-arm64.tar.gz`,
      `dist/assets/1667_${nightlyVersion}_darwin-x64.tar.gz`,
      `dist/assets/1667_${nightlyVersion}_linux-arm64.tar.gz`,
      `dist/assets/1667_${nightlyVersion}_linux-x64.tar.gz`,
      `dist/assets/1667_${nightlyVersion}_windows-x64.tar.gz`,
      "dist/assets/install-nightly.sh",
      "dist/assets/install-nightly.ps1",
      "dist/assets/checksums.txt"
    ]
  );

  const prereleaseRun = spawnSync(
    process.execPath,
    ["--import", "tsx", RELEASE_ASSETS_CLI, "upload-list", prereleaseVersion, "dist/assets"],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" }
  );
  assert.equal(prereleaseRun.status, 0);
  assert.equal(
    prereleaseRun.stdout,
    releaseUploadAssetPaths(prereleaseVersion, "dist/assets").join("\n") + "\n"
  );
  assert.deepEqual(
    prereleaseRun.stdout.trim().split("\n"),
    [
      `dist/assets/1667_${prereleaseVersion}_darwin-arm64.tar.gz`,
      `dist/assets/1667_${prereleaseVersion}_darwin-x64.tar.gz`,
      `dist/assets/1667_${prereleaseVersion}_linux-arm64.tar.gz`,
      `dist/assets/1667_${prereleaseVersion}_linux-x64.tar.gz`,
      `dist/assets/1667_${prereleaseVersion}_windows-x64.tar.gz`,
      "dist/assets/install-beta.sh",
      "dist/assets/install-beta.ps1",
      "dist/assets/checksums.txt"
    ]
  );
});

test("the nightly tag moves only after the assets are replaced", () => {
  const releaseJob = workflowJobs().get("release");
  assert.ok(releaseJob !== undefined);
  const stepMatch = releaseJob.match(
    /- name:\s*Publish the Nightly Release\n([\s\S]*?)(?=\n {6}- name:|\n {4}[a-z]|$)/u
  );
  assert.ok(stepMatch !== null);
  const step = stepMatch[1]!;

  // The tag is the completion marker the scheduled run reads. A tag that moves
  // first would mark a partial release complete and the next run would skip.
  const uploadIndex = step.indexOf("gh release upload nightly");
  const tagIndex = step.indexOf("git/refs/tags/nightly");
  assert.ok(uploadIndex !== -1);
  assert.ok(tagIndex !== -1);
  assert.ok(uploadIndex < tagIndex, "the tag ref must move after the asset upload");
});

test("the workflow refuses a dispatched version that uses the nightly form", () => {
  assert.match(
    WORKFLOW,
    /if \[ -n "\$INPUT_VERSION" \] && \[ "\$nightly" = "true" \]; then/u
  );
  assert.match(WORKFLOW, /must not use the nightly form/u);
});

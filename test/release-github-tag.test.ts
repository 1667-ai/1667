import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyRemoteReleaseTag } from "../scripts/release-github-tag.js";
import { fakeReleaseGh } from "./release-npm-github-fixture.js";

const VERSION = "1.2.3";
const REPOSITORY = "1667-ai/1667";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

test("remote tag verification ignores a colliding branch", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-github-tag-ref-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gh = path.join(root, "gh");
  const log = path.join(root, "gh.log");
  await writeFile(gh, fakeReleaseGh({
    remote: path.join(root, "remote"),
    state: path.join(root, "state.json"),
    log
  }, {
    branchCommit: COMMIT,
    tagCommit: "f".repeat(40)
  }));
  await chmod(gh, 0o755);

  await assert.rejects(
    verifyRemoteReleaseTag({
      version: VERSION,
      sourceCommit: COMMIT,
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
  assert.equal(
    calls.some((args) => args[1] === `repos/${REPOSITORY}/git/ref/tags/v${VERSION}`),
    true
  );
  assert.equal(calls.some((args) => args[1]?.includes("/commits/")), false);
});

test("remote tag verification refuses a nested annotated tag", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-github-tag-chain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gh = path.join(root, "gh");
  await writeFile(gh, fakeReleaseGh({
    remote: path.join(root, "remote"),
    state: path.join(root, "state.json"),
    log: path.join(root, "gh.log")
  }, {
    tagObjectSha: "e".repeat(40),
    tagObjectTargetType: "tag"
  }));
  await chmod(gh, 0o755);

  await assert.rejects(
    verifyRemoteReleaseTag({
      version: VERSION,
      sourceCommit: COMMIT,
      environment: {
        GITHUB_REPOSITORY: REPOSITORY,
        GH_TOKEN: "test-token",
        HOME: root
      },
      ghExecutable: gh
    }),
    /did not resolve to a commit/u
  );
});

test("remote tag verification requires the approved immutable tag rule", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-github-tag-rule-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gh = path.join(root, "gh");
  await writeFile(gh, fakeReleaseGh({
    remote: path.join(root, "remote"),
    state: path.join(root, "state.json"),
    log: path.join(root, "gh.log")
  }, { immutableTagRuleset: false }));
  await chmod(gh, 0o755);

  await assert.rejects(
    verifyRemoteReleaseTag({
      version: VERSION,
      sourceCommit: COMMIT,
      environment: {
        GITHUB_REPOSITORY: REPOSITORY,
        GH_TOKEN: "test-token",
        HOME: root
      },
      ghExecutable: gh
    }),
    /tag: v\* immutable is not the approved revision/u
  );
  await writeFile(gh, fakeReleaseGh({
    remote: path.join(root, "remote"),
    state: path.join(root, "state.json"),
    log: path.join(root, "gh.log")
  }, { rulesetUpdatedAt: "2026-08-05T10:12:37.420Z" }));
  await assert.rejects(
    verifyRemoteReleaseTag({
      version: VERSION,
      sourceCommit: COMMIT,
      environment: {
        GITHUB_REPOSITORY: REPOSITORY,
        GH_TOKEN: "test-token",
        HOME: root
      },
      ghExecutable: gh
    }),
    /tag: v\* immutable is not the approved revision/u
  );
});

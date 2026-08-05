import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { canonicalJson } from "../server/canonical-json.js";
import {
  collectReleaseEvidence,
  collectReleaseTagAuthorization,
  type ReleaseEvidenceRequest
} from "../scripts/release-evidence.js";
import { createReleaseIdentitySet } from "../scripts/release-identity.js";

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COLLECTOR_SOURCE = path.join(REPOSITORY_ROOT, "scripts", "release-evidence.ts");
const VERSION = "9.8.7";
const TAG = `v${VERSION}`;
const TIMESTAMP = "2026-07-27T08:09:10.011Z";

/**
 * The environment for the commands that *build* a fixture, which are ordinary
 * child processes of this test and would otherwise inherit a developer's
 * commit hooks and Git configuration. `collectReleaseEvidence` needs no
 * counterpart: it constructs its own hermetic environment, so nothing here is
 * neutralising a variable on production's behalf.
 */
const FIXTURE_GIT_ENVIRONMENT: NodeJS.ProcessEnv = Object.freeze({
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Release Bot",
  GIT_AUTHOR_EMAIL: "release@1667.test",
  GIT_AUTHOR_DATE: "2026-07-27T00:00:00+0000",
  GIT_COMMITTER_NAME: "Release Bot",
  GIT_COMMITTER_EMAIL: "release@1667.test",
  GIT_COMMITTER_DATE: "2026-07-27T00:00:00+0000"
});

interface FixtureOptions {
  readonly rootVersion?: string;
  readonly tuiVersion?: string;
  readonly lockVersion?: string;
  readonly lockPackageVersion?: string;
  /** No release tag needs a signature — there is no user of this product yet,
   *  and that protection returns before there is one. `"lightweight"` and
   *  `"annotated"` are both accepted release sources; this fixture never signs
   *  either. */
  readonly tag?: "annotated" | "lightweight";
  readonly commitAfterTag?: boolean;
  readonly protectedRefBehind?: boolean;
  readonly dirty?: boolean;
}

interface Fixture {
  readonly repository: string;
}

/** Builds a real repository with a real tag, because a mock cannot show that
 *  Git's own answers about tag shape and reachability are read correctly. */
async function createFixture(t: TestContext, options: FixtureOptions = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "1667-release-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repository");
  const git = async (args: readonly string[]): Promise<string> => {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd: repository,
      encoding: "utf8",
      env: FIXTURE_GIT_ENVIRONMENT
    });
    return stdout.trim();
  };

  await mkdir(path.join(repository, "tui"), { recursive: true });
  await git(["init", "-q", "-b", "main", "."]);
  await writeFile(path.join(repository, "README.md"), "fixture\n");
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "base"]);
  const baseCommit = await git(["rev-parse", "HEAD"]);

  await writeFile(
    path.join(repository, "package.json"),
    `${JSON.stringify({ name: "1667-workspace", version: options.rootVersion ?? VERSION }, null, 2)}\n`
  );
  await writeFile(
    path.join(repository, "tui", "package.json"),
    `${JSON.stringify({ name: "1667-tui", version: options.tuiVersion ?? VERSION }, null, 2)}\n`
  );
  await writeFile(
    path.join(repository, "package-lock.json"),
    `${JSON.stringify({
      name: "1667-workspace",
      version: options.lockVersion ?? VERSION,
      lockfileVersion: 3,
      packages: { "": { name: "1667-workspace", version: options.lockPackageVersion ?? VERSION } }
    }, null, 2)}\n`
  );
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "release candidate"]);
  const releaseCommit = await git(["rev-parse", "HEAD"]);

  if (options.tag === "lightweight") {
    await git(["tag", TAG]);
  } else {
    await git(["tag", "-a", "-m", TAG, TAG]);
  }

  if (options.commitAfterTag === true) {
    await appendFile(path.join(repository, "README.md"), "after the tag\n");
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "after the tag"]);
  }
  await git([
    "update-ref",
    "refs/remotes/origin/main",
    options.protectedRefBehind === true ? baseCommit : await git(["rev-parse", "HEAD"])
  ]);
  assert.notEqual(releaseCommit, baseCommit);

  if (options.dirty === true) {
    await appendFile(path.join(repository, "README.md"), "uncommitted\n");
  }
  return Object.freeze({ repository });
}

function collect(
  fixture: Fixture,
  overrides: Partial<ReleaseEvidenceRequest> = {}
): ReturnType<typeof collectReleaseEvidence> {
  return collectReleaseEvidence({
    repositoryRoot: fixture.repository,
    tagName: TAG,
    buildTimestamp: TIMESTAMP,
    ...overrides
  });
}

function collectAuthorization(fixture: Fixture) {
  return collectReleaseTagAuthorization({
    repositoryRoot: fixture.repository,
    tagName: TAG
  });
}

test("evidence from an annotated tag on a protected branch satisfies the release validator", async (t) => {
  const fixture = await createFixture(t);
  const evidence = await collect(fixture);
  assert.equal(evidence.tagName, TAG);
  assert.equal(evidence.productVersion, VERSION);
  assert.equal(evidence.sourceDirty, false);
  assert.equal(evidence.tagObjectType, "annotated");
  assert.equal(evidence.tagSignature, "unsigned");
  assert.equal(evidence.buildTimestamp, TIMESTAMP);
  assert.equal(evidence.tagTargetCommit, evidence.sourceCommit);
  assert.match(evidence.sourceCommit, /^[0-9a-f]{40}$/);
  assert.deepEqual({ ...evidence.packageVersions }, {
    root: VERSION,
    tui: VERSION,
    rootLock: VERSION,
    rootLockPackage: VERSION
  });

  // Producer and validator cannot drift: the emitted document is exactly what a
  // release build consumes.
  const identities = createReleaseIdentitySet(JSON.parse(canonicalJson(evidence)) as unknown);
  assert.deepEqual(identities.evidence, evidence);
});

test("evidence from a lightweight tag on a protected branch satisfies the release validator", async (t) => {
  const fixture = await createFixture(t, { tag: "lightweight" });
  const evidence = await collect(fixture);
  assert.equal(evidence.tagObjectType, "lightweight");
  assert.equal(evidence.tagSignature, "unsigned");
  assert.equal(evidence.tagTargetCommit, evidence.sourceCommit);

  const identities = createReleaseIdentitySet(JSON.parse(canonicalJson(evidence)) as unknown);
  assert.deepEqual(identities.evidence, evidence);
});

test("tag authorization reports the tag's real shape without build facts", async (t) => {
  const fixture = await createFixture(t);
  const document = await collectAuthorization(fixture);
  assert.equal(document.tagName, TAG);
  assert.equal(document.tagObjectType, "annotated");
  assert.equal(document.tagSignature, "unsigned");
  assert.equal(document.tagTargetCommit, document.sourceCommit);
  assert.equal("buildTimestamp" in document, false);

  const lightweight = await createFixture(t, { tag: "lightweight" });
  const lightweightDocument = await collectAuthorization(lightweight);
  assert.equal(lightweightDocument.tagObjectType, "lightweight");
  assert.equal(lightweightDocument.tagSignature, "unsigned");
});

test("evidence refuses a dirty working tree", async (t) => {
  const fixture = await createFixture(t, { dirty: true });
  await assert.rejects(collect(fixture), /Release source tree is dirty/);
});

test("evidence refuses a tag that does not point at the release commit", async (t) => {
  const fixture = await createFixture(t, { commitAfterTag: true });
  await assert.rejects(collect(fixture), /does not point at the release commit/);
});

test("evidence refuses a release commit unreachable from the protected ref", async (t) => {
  const fixture = await createFixture(t, { protectedRefBehind: true });
  await assert.rejects(
    collect(fixture),
    /is not reachable from protected ref refs\/remotes\/origin\/main/
  );
});

test("evidence refuses disagreeing versions across manifests and the lockfile", async (t) => {
  for (const skew of [
    { rootVersion: "9.8.6" },
    { tuiVersion: "9.8.6" },
    { lockVersion: "9.8.6" },
    { lockPackageVersion: "9.8.6" }
  ]) {
    const fixture = await createFixture(t, skew);
    await assert.rejects(collect(fixture), /Release package versions disagree/);
  }
});

test("the evidence CLI emits canonical JSON the release validator accepts", async (t) => {
  // No environment is handed to the child on purpose: the collector builds its
  // own, so a developer's Git configuration must not be able to reach it.
  const fixture = await createFixture(t);
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import", "tsx",
    COLLECTOR_SOURCE,
    "--repository", fixture.repository,
    "--tag", TAG,
    "--build-timestamp", TIMESTAMP
  ], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
  const evidence: unknown = JSON.parse(stdout);
  assert.equal(canonicalJson(evidence), stdout.trim());
  assert.equal(createReleaseIdentitySet(evidence).evidence.tagName, TAG);
  assert.match(stderr, new RegExp(`release-tag ${TAG} annotated unsigned`));
});

test("the evidence collector reads no file", () => {
  // The fixtures above are the stronger guard — each asks Git rather than
  // reading a file directly. This is the cheap one that names the mistake
  // directly, since nothing in this repository lints for it.
  const source = readFileSync(COLLECTOR_SOURCE, "utf8");
  for (const reader of ["readFile", "readFileSync", "createReadStream"]) {
    assert.equal(
      source.includes(reader),
      false,
      `scripts/release-evidence.ts must learn nothing from ${reader}; ask Git instead`
    );
  }
});

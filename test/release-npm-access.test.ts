import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from
  "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PUBLISHED_PLATFORM_PACKAGES,
  RELEASE_LAUNCHER_PACKAGE
} from "../shared/release-targets.js";
import { NpmWriteAccessVerifier } from "../scripts/release-npm-access.js";

const PACKAGES = [...PUBLISHED_PLATFORM_PACKAGES, RELEASE_LAUNCHER_PACKAGE];

test("authenticated access verification covers all effective npm writers",
  async (t) => {
  const fixture = await accessFixture(t, {
    "1667.ai": "read-write",
    reader: "read-only"
  });
  await fixture.verifier.verify(PACKAGES);

  const calls = (await readFile(fixture.log, "utf8")).trimEnd()
    .split("\n").map((line) => JSON.parse(line) as string[]);
  assert.equal(calls.length, PACKAGES.length);
  for (const [index, call] of calls.entries()) {
    assert.deepEqual(call.slice(-2), ["--", PACKAGES[index]]);
    assert.ok(call.includes("--json"));
    assert.ok(call.includes("--registry=https://registry.npmjs.org/"));
  }
});

test("authenticated access verification rejects another npm writer",
  async (t) => {
  const fixture = await accessFixture(t, {
    "1667.ai": "read-write",
    intruder: "read-write"
  });
  await assert.rejects(
    fixture.verifier.verify(PACKAGES),
    /write access must belong only to 1667\.ai/u
  );
  const calls = (await readFile(fixture.log, "utf8")).trimEnd().split("\n");
  assert.equal(calls.length, 1);
});

test("authenticated access verification cannot omit a release package",
  async (t) => {
  const fixture = await accessFixture(t, {
    "1667.ai": "read-write"
  });
  await assert.rejects(
    fixture.verifier.verify(PACKAGES.slice(0, -1)),
    /package list is invalid/u
  );
  await assert.rejects(readFile(fixture.log, "utf8"), { code: "ENOENT" });
});

test("authenticated access verification uses only the pinned npm CLI",
  async (t) => {
  const fixture = await accessFixture(t, {
    "1667.ai": "read-write"
  });
  const decoy = path.join(fixture.root, "npm");
  await writeFile(decoy, "#!/bin/sh\nexit 99\n");
  await chmod(decoy, 0o755);

  await fixture.verifier.verify(PACKAGES);
  assert.match(await readFile(fixture.log, "utf8"), /1667/u);
});

test("authenticated access verification rejects a changed pinned tool",
  async (t) => {
  const fixture = await accessFixture(t, {
    "1667.ai": "read-write"
  });
  await writeFile(fixture.npmCli, "process.stdout.write('{}\\n');\n");
  await assert.rejects(
    fixture.verifier.verify(PACKAGES),
    /Release npm CLI changed after verification/u
  );
});

async function accessFixture(
  t: test.TestContext,
  collaborators: Readonly<Record<string, "read-only" | "read-write">>
): Promise<{
  readonly log: string;
  readonly npmCli: string;
  readonly root: string;
  readonly verifier: NpmWriteAccessVerifier;
}> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "1667-access-")));
  t.after(() => rm(root, { force: true, recursive: true }));
  const npmCli = path.join(root, "npm.cjs");
  const log = path.join(root, "calls.jsonl");
  await writeFile(npmCli, [
    'const { appendFileSync } = require("node:fs");',
    "if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN",
    "  || process.env.NPM_OPERATION_CLAIM_SECRET",
    "  || process.env.NPM_OPERATION_WRITER_SECRET) process.exit(2);",
    'appendFileSync(process.env.ACCESS_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");',
    'process.stdout.write(process.env.ACCESS_RESPONSE + "\\n");',
    ""
  ].join("\n"));
  const environment = {
    ...process.env,
    ACCESS_LOG: log,
    ACCESS_RESPONSE: JSON.stringify(collaborators),
    PATH: root,
    GH_TOKEN: "must-not-reach-npm",
    GITHUB_TOKEN: "must-not-reach-npm",
    NPM_OPERATION_CLAIM_SECRET: "must-not-reach-npm",
    NPM_OPERATION_WRITER_SECRET: "must-not-reach-npm"
  };
  const verifier = new NpmWriteAccessVerifier({
    environment,
    nodeExecutable: process.execPath,
    npmCli
  });
  return { log, npmCli, root, verifier };
}

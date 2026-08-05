import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  releaseRunTimestamp,
  verifyReleaseAttestations
} from "../scripts/release-npm-ci.js";

const VERSION = "1.2.3";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TIMESTAMP = "2026-07-28T10:20:30.000Z";
const SOURCE_REF = `refs/tags/v${VERSION}`;

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

import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_GH_ASSET_TIMEOUT_MS,
  runReleaseGh
} from "../scripts/release-github-client.js";

// These tests operate the release client together with a stand-in GitHub CLI
// on disk, because the behaviour under test is what the client does with a
// real child process: the deadline it gives an asset transfer, and what it
// reports when that process fails.

async function fakeGh(body: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "1667-release-gh-"));
  const file = path.join(directory, "gh");
  await writeFile(file, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(file, 0o755);
  return file;
}

test("the release client accepts the asset deadline a release upload needs", async () => {
  const gh = await fakeGh('echo "uploaded"');
  const result = await runReleaseGh(gh, ["release", "upload"], {}, {
    timeoutMs: MAX_GH_ASSET_TIMEOUT_MS
  });
  assert.equal(result.stdout.trim(), "uploaded");
  // A gigabyte of assets took more than five minutes on one runner, so the
  // ceiling must stay well above that default.
  assert.ok(MAX_GH_ASSET_TIMEOUT_MS >= 20 * 60_000);
  await assert.rejects(
    runReleaseGh(gh, ["release", "upload"], {}, { timeoutMs: MAX_GH_ASSET_TIMEOUT_MS + 1 }),
    /GitHub CLI timeout is invalid/u
  );
});

test("a failed release command reports what the GitHub CLI wrote", async () => {
  const gh = await fakeGh('echo "HTTP 422: release already exists" 1>&2\nexit 1');
  await assert.rejects(
    runReleaseGh(gh, ["release", "create"], {}),
    /release already exists/u
  );
});

test("a release command that outlives its deadline says it timed out", async () => {
  const gh = await fakeGh("sleep 5");
  await assert.rejects(
    runReleaseGh(gh, ["release", "upload"], {}, { timeoutMs: 100 }),
    /timed out/u
  );
});

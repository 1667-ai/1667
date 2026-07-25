import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { HttpOperationClient } from "../shared/http-operation-client.js";
import { startLegacyServe } from "../tui/src/http-commands.js";
import { validateLegacyServeDataDirectory } from "../server/legacy-data-directory.js";

test("legacy directory validation refuses absent, empty, and ownership-marked paths", async (t) => {
  const parent = await privateTemporaryDirectory(t, "1667-legacy-");
  await assert.rejects(
    validateLegacyServeDataDirectory(path.join(parent, "absent")),
    /existing nonempty/
  );
  const empty = path.join(parent, "empty");
  await mkdir(empty, { mode: 0o700 });
  await assert.rejects(validateLegacyServeDataDirectory(empty), /empty/);
  await writeFile(path.join(empty, ".1667.owner-v1"), "");
  await assert.rejects(validateLegacyServeDataDirectory(empty), /reserved ownership/);
  const unrelated = path.join(parent, "unrelated");
  await mkdir(unrelated, { mode: 0o700 });
  await writeFile(path.join(unrelated, "notes.txt"), "not 1667 data");
  await assert.rejects(
    validateLegacyServeDataDirectory(unrelated),
    /recognized v1 data directory/
  );
});

test("legacy serve binds fixed canonical port and opens unmarked v1 data", async (t) => {
  const dataDir = await legacyDataDirectory(t);
  const listener = await startLegacyServe(dataDir);
  t.after(() => listener.close());
  assert.equal(listener.origin, "http://127.0.0.1:7373");
  const operations = new HttpOperationClient({
    root: listener.origin,
    authRecord: listener.authRecord,
    fetch
  });
  const reservation = await operations.reserve(
    "GET",
    "/api/stories",
    listener.authRecord.instanceId,
    undefined
  );
  const response = await fetch(`${listener.origin}/api/stories`, {
    headers: reservation.headers
  });
  await reservation.settle();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
  const entries = await readdir(dataDir);
  assert.equal(entries.some((entry) => entry.startsWith(".1667")), false);
});

test("legacy serve proves listener ownership before inspecting data", async (t) => {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(7373, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  const parent = await privateTemporaryDirectory(t, "1667-legacy-");
  const absent = path.join(parent, "must-stay-absent");
  await assert.rejects(startLegacyServe(absent), /EADDRINUSE/);
  await assert.rejects(readdir(absent), /ENOENT/);
  await assert.rejects(startLegacyServe(absent, { port: 7374 }), /fixed/);
});

async function legacyDataDirectory(t: TestContext): Promise<string> {
  const directory = await privateTemporaryDirectory(t, "1667-legacy-data-");
  await mkdir(path.join(directory, "stories"), { mode: 0o700 });
  return directory;
}

async function privateTemporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  const canonicalDirectory = await realpath(directory);
  await chmod(canonicalDirectory, 0o700);
  t.after(() => rm(canonicalDirectory, { recursive: true, force: true }));
  return canonicalDirectory;
}

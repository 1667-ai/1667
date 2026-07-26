import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { PROJECT_RUN_RECORD_FILE } from "../server/data-directory-layout.js";
import {
  publishProjectRunRecord,
  readProjectRunRecord,
  removeProjectRunRecord
} from "../server/project-run-record.js";
import { RuntimeDataDirectoryLock } from "../server/runtime-data-directory.js";

const RECORD = {
  pid: 31_337,
  port: 49_152,
  url: "http://127.0.0.1:49152",
  startedAt: "2026-07-25T12:00:00.000Z"
} as const;

test("a run record round-trips and is removable", async (t) => {
  const projectDir = await temporaryDirectory(t, "1667-run-record-");

  assert.equal(await readProjectRunRecord(projectDir), null);
  await publishProjectRunRecord(projectDir, RECORD);
  assert.deepEqual(await readProjectRunRecord(projectDir), RECORD);
  await removeProjectRunRecord(projectDir);
  assert.equal(await readProjectRunRecord(projectDir), null);
  // Removing a record that is not there is not a failure.
  await removeProjectRunRecord(projectDir);
});

test("a malformed or unreadable record reads as absent, never as an error", async (t) => {
  const projectDir = await temporaryDirectory(t, "1667-run-record-bad-");
  const file = path.join(projectDir, PROJECT_RUN_RECORD_FILE);

  for (const content of [
    "not json",
    "[]",
    '{"pid":"nine","port":1,"url":null,"startedAt":"x"}',
    '{"pid":0,"port":null,"url":null,"startedAt":"x"}',
    '{"port":1,"url":null,"startedAt":"x"}',
    '{"pid":1,"port":1.5,"url":null,"startedAt":"x"}',
    '{"pid":1,"port":null,"url":7,"startedAt":"x"}',
    '{"pid":1,"port":null,"url":null}'
  ]) {
    await writeFile(file, content);
    assert.equal(await readProjectRunRecord(projectDir), null, content);
  }
});

test("announcing a server keeps the start time and adds the port", async (t) => {
  const projectDir = await temporaryDirectory(t, "1667-run-record-announce-");
  const lock = new RuntimeDataDirectoryLock(projectDir);
  await lock.acquire();
  const held = await readProjectRunRecord(projectDir);

  await lock.announceProjectServer({
    port: 51_000,
    url: "http://127.0.0.1:51000"
  });

  assert.deepEqual(await readProjectRunRecord(projectDir), {
    pid: process.pid,
    port: 51_000,
    url: "http://127.0.0.1:51000",
    startedAt: held?.startedAt
  });
  await lock.release();
});

test("a released owner cannot replace or remove its successor record", async (t) => {
  const projectDir = await temporaryDirectory(t, "1667-run-record-successor-");
  const previous = new RuntimeDataDirectoryLock(projectDir);
  await previous.acquire();
  await previous.release();

  const successor = new RuntimeDataDirectoryLock(projectDir);
  await successor.acquire();
  const successorRecord = await readProjectRunRecord(projectDir);

  await previous.announceProjectServer({
    port: 51_001,
    url: "http://127.0.0.1:51001"
  });

  assert.deepEqual(await readProjectRunRecord(projectDir), successorRecord);
  await successor.release();
});

test("an unwritable record never keeps a project from opening", async (t) => {
  if (process.platform === "win32" || process.geteuid?.() === 0) return;
  const projectDir = await temporaryDirectory(t, "1667-run-record-readonly-");
  const lock = new RuntimeDataDirectoryLock(projectDir);
  await lock.acquire();
  await lock.release();
  // A project 1667 cannot write the hint into still opens: the record is
  // advisory, and ADR007 never refuses startup on it.
  await chmod(projectDir, 0o500);
  try {
    const reopened = new RuntimeDataDirectoryLock(projectDir);
    await reopened.acquire();
    await reopened.release();
  } finally {
    await chmod(projectDir, 0o700);
  }
});

test("the lock owner publishes and clears its own record", async (t) => {
  const projectDir = await temporaryDirectory(t, "1667-run-record-lock-");
  const lock = new RuntimeDataDirectoryLock(projectDir);

  const canonical = await lock.acquire();
  const held = await readProjectRunRecord(canonical);
  assert.equal(held?.pid, process.pid);
  assert.equal(held?.port, null);
  assert.equal(held?.url, null);
  assert.match(String(held?.startedAt), /^\d{4}-\d{2}-\d{2}T/);

  await lock.release();
  assert.equal(await readProjectRunRecord(canonical), null);
});

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  return directory;
}

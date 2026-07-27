import assert from "node:assert/strict";
import { open, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DataDirectoryLock } from "../server/data-directory-lock.js";
import { SETTINGS_STATE_V2_FILE } from "../server/data-directory-format.js";
import { ServiceError } from "../server/errors.js";
import {
  INITIAL_SETTINGS_STATE_V2,
  INITIAL_SETTINGS_STATE_V2_TEXT
} from "../server/settings-v2-default.js";
import {
  publishStagedSettingsState,
  readSettingsState,
  stageSettingsState
} from "../server/settings-state-file.js";
import {
  MUTATION_A,
  changedState,
  initializedFormat2Directory,
  writingDocument
} from "./settings-store-fixtures.js";

test("current settings read remains valid across atomic replacement", {
  timeout: 5_000,
  skip: process.platform === "win32"
}, async (t) => {
  const dataDir = await initializedFormat2Directory(
    t,
    "1667-settings-atomic-read-"
  );
  const replacement = changedState(
    MUTATION_A,
    writingDocument("Published while the old authority is open.")
  );
  await stageSettingsState(dataDir, replacement);
  const pause = await pauseNextRead(
    t,
    Buffer.byteLength(INITIAL_SETTINGS_STATE_V2_TEXT, "utf8") + 1
  );

  const reading = readSettingsState(dataDir);
  await pause.entered;
  try {
    await publishStagedSettingsState(dataDir);
  } finally {
    pause.release();
  }

  assert.deepEqual(await reading, INITIAL_SETTINGS_STATE_V2);
  assert.deepEqual(await readSettingsState(dataDir), replacement);
});

test("a contender reports contention, never invalid state", {
  timeout: 5_000
}, async (t) => {
  // ADR007 takes the lock before reading anything, so a contender cannot see a
  // settings state mid-publication and mistake it for corruption. The owner's
  // publication still completes underneath the refusal.
  const dataDir = await initializedFormat2Directory(
    t,
    "1667-settings-preflight-replace-"
  );
  const replacement = changedState(
    MUTATION_A,
    writingDocument("Published while a contender is refused.")
  );
  await stageSettingsState(dataDir, replacement);

  // The handler is attached with the call so the refusal can settle whenever it
  // likes without becoming an unhandled rejection.
  const contention = new DataDirectoryLock(dataDir).acquire().then(
    () => null,
    (error: unknown) => error
  );
  await publishStagedSettingsState(dataDir);

  const refusal = await contention;
  assert.ok(refusal instanceof ServiceError, `expected a refusal, got ${refusal}`);
  assert.equal(refusal.status, 409);
  assert.match(refusal.message, /already open/);
  assert.doesNotMatch(refusal.message, /invalid/);
  assert.deepEqual(await readSettingsState(dataDir), replacement);
});

test("current settings read rejects deletion without atomic replacement", {
  timeout: 5_000
}, async (t) => {
  const dataDir = await initializedFormat2Directory(
    t,
    "1667-settings-delete-read-"
  );
  const pause = await pauseNextRead(
    t,
    Buffer.byteLength(INITIAL_SETTINGS_STATE_V2_TEXT, "utf8") + 1
  );

  const reading = readSettingsState(dataDir);
  await pause.entered;
  try {
    await unlink(path.join(dataDir, SETTINGS_STATE_V2_FILE));
  } finally {
    pause.release();
  }

  await assert.rejects(reading, /Format-2 settings state is missing/);
});

interface ReadPause {
  readonly entered: Promise<void>;
  release(): void;
}

interface ReadableFileHandlePrototype {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ): Promise<{ readonly bytesRead: number; readonly buffer: Buffer }>;
}

async function pauseNextRead(
  t: TestContext,
  bufferByteLength: number
): Promise<ReadPause> {
  const probe = await open(import.meta.filename, "r");
  const prototype = Object.getPrototypeOf(probe) as ReadableFileHandlePrototype;
  await probe.close();
  const originalRead = prototype.read;
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  let paused = false;

  t.mock.method(prototype, "read", async function (
    this: FileHandle,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ) {
    if (!paused && offset === 0 && buffer.byteLength === bufferByteLength) {
      paused = true;
      enteredResolve();
      await released;
    }
    return await originalRead.call(this, buffer, offset, length, position);
  });

  return {
    entered,
    release(): void {
      releaseResolve();
    }
  };
}

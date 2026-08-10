import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DataDirectoryLock } from "../server/data-directory-lock.js";
import {
  dataDirectoryOwnerMarkerText,
  readDataDirectoryFormat
} from "../server/data-directory-format.js";
import {
  DATA_DIRECTORY_OWNER_MARKER,
  SETTINGS_STATE_V1_FILE,
  SETTINGS_STATE_V2_FILE
} from "../server/data-directory-layout.js";
import { ServiceError } from "../server/errors.js";
import { formatGenerationSettingsV1 } from "../server/settings-v1-codec.js";

test("a pre-A reader refuses format 2 before opening its settings state", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "1667-format-compat-"));
  t.after(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });
  const markerPath = path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER);
  const marker = dataDirectoryOwnerMarkerText(2);
  await writeFile(markerPath, marker, { mode: 0o600 });

  await assert.rejects(
    readDataDirectoryFormat(dataDir, { supportedFormats: [1] }),
    (error: unknown) => error instanceof ServiceError
      && error.code === "data_directory_version_unsupported"
  );
  assert.equal(await readFile(markerPath, "utf8"), marker);
  await assert.rejects(readDataDirectoryFormat(dataDir), /settings state is missing or invalid/);
});

test("an incompatible downgrade leaves migrated v1 and v2 evidence unchanged", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "1667-format-downgrade-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const initializer = new DataDirectoryLock(dataDir, { initializeDataFormat: 1 });
  await initializer.acquire();
  await initializer.release();
  const v1Path = path.join(dataDir, SETTINGS_STATE_V1_FILE);
  await writeFile(v1Path, formatGenerationSettingsV1({
    provider: "openai-compatible",
    baseUrl: "https://example.test/v1",
    model: "rollback-model",
    apiKeyEnv: null,
    temperature: 0.5,
    maxTokens: 1024,
    systemPrompt: "Retain both migration representations.",
    contextWindow: 16384
  }), { mode: 0o600 });
  const lock = new DataDirectoryLock(dataDir);
  await lock.acquire();
  await lock.migrateSettingsFormat();
  await lock.release();
  const markerPath = path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER);
  const v2Path = path.join(dataDir, SETTINGS_STATE_V2_FILE);
  const before = await Promise.all([readFile(markerPath), readFile(v1Path), readFile(v2Path)]);

  await assert.rejects(
    readDataDirectoryFormat(dataDir, { supportedFormats: [1] }),
    (error: unknown) => error instanceof ServiceError
      && error.code === "data_directory_version_unsupported"
  );
  assert.deepEqual(
    await Promise.all([readFile(markerPath), readFile(v1Path), readFile(v2Path)]),
    before
  );
});

test("a format-2 reader refuses a format-3 directory before opening its state", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "1667-format-3-compat-"));
  t.after(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });
  const markerPath = path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER);
  const marker = dataDirectoryOwnerMarkerText(3);
  await writeFile(markerPath, marker, { mode: 0o600 });

  // Format 3 holds shapes format 2 never allowed: a name for chapter one, and
  // the plaintext opt-in on a loopback connection. An executable that predates
  // them has to stop here, at the marker, rather than reach a story or a
  // settings state it would refuse for reasons it could not explain.
  await assert.rejects(
    readDataDirectoryFormat(dataDir, { supportedFormats: [1, 2] }),
    (error: unknown) => error instanceof ServiceError
      && error.code === "data_directory_version_unsupported"
  );
  assert.equal(await readFile(markerPath, "utf8"), marker);
});

test("a format-3 reader refuses a format-4 directory before opening its state", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "1667-format-4-compat-"));
  t.after(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });
  const markerPath = path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER);
  const marker = dataDirectoryOwnerMarkerText(4);
  await writeFile(markerPath, marker, { mode: 0o600 });

  await assert.rejects(
    readDataDirectoryFormat(dataDir, { supportedFormats: [1, 2, 3] }),
    (error: unknown) => error instanceof ServiceError
      && error.code === "data_directory_version_unsupported"
  );
  assert.equal(await readFile(markerPath, "utf8"), marker);
});

test("a format-4 reader refuses a sealed format-5 directory at the marker", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "1667-format-5-compat-"));
  t.after(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });
  const markerPath = path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER);
  const marker = dataDirectoryOwnerMarkerText(5);
  await writeFile(markerPath, marker, { mode: 0o600 });

  await assert.rejects(
    readDataDirectoryFormat(dataDir, { supportedFormats: [1, 2, 3, 4] }),
    (error: unknown) => error instanceof ServiceError
      && error.code === "data_directory_version_unsupported"
  );
  assert.equal(await readFile(markerPath, "utf8"), marker);
});

test("opening a format-2 project upgrades it to the fence its writes need", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "1667-format-3-upgrade-"));
  t.after(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });
  const existing = new DataDirectoryLock(dataDir, { initializeDataFormat: 2 });
  await existing.acquire();
  assert.equal(existing.dataFormat, 2);
  await existing.release();

  // The upgrade happens at acquisition, before any store is opened, so no
  // write of a format-3 shape can land in a directory still marked 2.
  const opened = new DataDirectoryLock(dataDir);
  await opened.acquire();
  try {
    assert.equal(await opened.migrateSettingsFormat(), 4);
    assert.equal(await readDataDirectoryFormat(dataDir), 4);
  } finally {
    await opened.release();
  }
});

test("opening a format-3 project performs the no-op format-4 fence", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "1667-format-4-upgrade-"));
  t.after(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });
  const existing = new DataDirectoryLock(dataDir, { initializeDataFormat: 3 });
  await existing.acquire();
  await existing.release();

  const opened = new DataDirectoryLock(dataDir);
  await opened.acquire();
  try {
    assert.equal(opened.dataFormat, 3);
    assert.equal(await opened.migrateSettingsFormat(), 4);
    assert.equal(await opened.migrateSettingsFormat(), 4);
    assert.equal(await readDataDirectoryFormat(dataDir), 4);
  } finally {
    await opened.release();
  }
});

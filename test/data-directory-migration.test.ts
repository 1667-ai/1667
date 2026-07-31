import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DataDirectoryLock } from "../server/data-directory-lock.js";
import { migrateDataDirectory } from "../server/data-directory-migration.js";
import {
  DATA_DIRECTORY_OWNER_MARKER,
  DATA_DIRECTORY_OWNER_MARKER_NEXT_SCRATCH,
  LEGACY_PREVIEW_DATA_MARKER,
  LEGACY_PREVIEW_DATA_MARKER_TEXT,
  SETTINGS_STATE_V2_FILE,
  SETTINGS_STATE_V2_NEXT_SCRATCH,
  dataDirectoryOwnerMarkerText,
  readDataDirectoryFormat
} from "../server/data-directory-format.js";
import {
  ABSENT_SETTINGS_V1,
  formatGenerationSettingsV1
} from "../server/settings-v1-codec.js";

const LEGACY_SETTINGS = formatGenerationSettingsV1(ABSENT_SETTINGS_V1);
const CHANGED_LEGACY_SETTINGS = formatGenerationSettingsV1({
  ...ABSENT_SETTINGS_V1,
  temperature: 0.5
});

test("offline migration copies data, upgrades the destination, and leaves legacy untouched", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "1667-data-migration-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const source = path.join(parent, "legacy");
  const destination = path.join(parent, "data-v1");
  await mkdir(path.join(source, "stories"), { recursive: true });
  await writeFile(path.join(source, "settings.json"), LEGACY_SETTINGS);
  await writeFile(path.join(source, "stories", "one.json"), "{\"id\":\"one\"}\n");
  await writeFile(path.join(source, DATA_DIRECTORY_OWNER_MARKER_NEXT_SCRATCH), "scratch\n");
  await writeFile(path.join(source, SETTINGS_STATE_V2_NEXT_SCRATCH), "scratch\n");

  assert.equal(await migrateDataDirectory(source, destination), await realpath(destination));
  assert.equal(await readFile(path.join(destination, "stories", "one.json"), "utf8"), "{\"id\":\"one\"}\n");
  if (process.platform !== "win32") {
    assert.equal((await stat(path.join(destination, "settings.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(destination, "stories", "one.json"))).mode & 0o777, 0o600);
  }
  assert.equal(await readFile(path.join(source, "settings.json"), "utf8"), LEGACY_SETTINGS);
  await assert.rejects(access(path.join(source, LEGACY_PREVIEW_DATA_MARKER)));
  await assert.rejects(access(path.join(source, DATA_DIRECTORY_OWNER_MARKER)));
  await assert.rejects(access(path.join(source, ".1667.lock")));
  await assert.rejects(access(path.join(destination, DATA_DIRECTORY_OWNER_MARKER_NEXT_SCRATCH)));
  await assert.rejects(access(path.join(destination, SETTINGS_STATE_V2_NEXT_SCRATCH)));
  assert.equal(
    await readFile(path.join(source, DATA_DIRECTORY_OWNER_MARKER_NEXT_SCRATCH), "utf8"),
    "scratch\n"
  );
  assert.equal(
    await readFile(path.join(source, SETTINGS_STATE_V2_NEXT_SCRATCH), "utf8"),
    "scratch\n"
  );
  assert.equal(
    await readFile(path.join(destination, DATA_DIRECTORY_OWNER_MARKER), "utf8"),
    dataDirectoryOwnerMarkerText(3)
  );
  await access(path.join(destination, SETTINGS_STATE_V2_FILE));
  const lock = new DataDirectoryLock(destination);
  await lock.acquire();
  assert.equal(lock.dataFormat, 3);
  await lock.release();
});

test("offline migration upgrades a settings-only legacy directory to the latest format", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "1667-data-migration-settings-only-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const source = path.join(parent, "legacy");
  const destination = path.join(parent, "current");
  await mkdir(source);
  await writeFile(path.join(source, "settings.json"), LEGACY_SETTINGS);

  await migrateDataDirectory(source, destination);

  assert.equal(await readDataDirectoryFormat(destination), 3);
  assert.equal(await readFile(path.join(destination, "settings.json"), "utf8"), LEGACY_SETTINGS);
  await access(path.join(destination, SETTINGS_STATE_V2_FILE));
  assert.deepEqual(await readdir(source), ["settings.json"]);
});

test("offline migration rejects source movement and removes its private staging copy", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "1667-data-migration-race-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const source = path.join(parent, "legacy");
  const destination = path.join(parent, "data-v1");
  await mkdir(source);
  await writeFile(path.join(source, "settings.json"), LEGACY_SETTINGS);

  await assert.rejects(migrateDataDirectory(source, destination, {
    afterCopy: () => writeFile(path.join(source, "settings.json"), CHANGED_LEGACY_SETTINGS)
  }), /changed during migration/);
  await assert.rejects(access(destination));
});

test("offline migration never replaces a destination that appears during copy", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "1667-data-migration-publish-race-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const source = path.join(parent, "legacy");
  const destination = path.join(parent, "data-v1");
  await mkdir(source);
  await writeFile(path.join(source, "settings.json"), LEGACY_SETTINGS);

  await assert.rejects(migrateDataDirectory(source, destination, {
    afterCopy: () => mkdir(destination)
  }), /destination appeared during publication/);

  assert.deepEqual(await readdir(destination), []);
  assert.equal(
    await readFile(path.join(source, "settings.json"), "utf8"),
    LEGACY_SETTINGS
  );
});

test("offline migration refuses a legacy lock before copying", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "1667-data-migration-lock-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const source = path.join(parent, "legacy");
  const destination = path.join(parent, "data-v1");
  await mkdir(path.join(source, ".1667.lock"), { recursive: true });
  await writeFile(path.join(source, "settings.json"), "legacy\n");

  await assert.rejects(migrateDataDirectory(source, destination), /Legacy data lock is present/);
  await assert.rejects(access(destination));
});

test("offline migration refreshes its legacy lease during a long copy", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "1667-data-migration-heartbeat-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const source = path.join(parent, "legacy");
  const destination = path.join(parent, "data-v1");
  const lockPath = path.join(source, ".1667.lock");
  await mkdir(source);
  await writeFile(path.join(source, "settings.json"), LEGACY_SETTINGS);

  await migrateDataDirectory(source, destination, {
    afterCopy: async () => {
      const before = (await stat(lockPath)).mtimeMs;
      await new Promise((resolve) => setTimeout(resolve, 2_200));
      assert.ok((await stat(lockPath)).mtimeMs > before);
    }
  });
});

test("offline migration never removes a replacement legacy lock", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "1667-data-migration-owner-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const source = path.join(parent, "legacy");
  const destination = path.join(parent, "data-v1");
  const lockPath = path.join(source, ".1667.lock");
  await mkdir(source);
  await writeFile(path.join(source, "settings.json"), LEGACY_SETTINGS);

  await assert.rejects(migrateDataDirectory(source, destination, {
    afterCopy: async () => {
      await rmdir(lockPath);
      await mkdir(lockPath);
    }
  }), /lock ownership was lost/);
  assert.ok((await stat(lockPath)).isDirectory());
  await assert.rejects(access(destination));
});

test("offline migration rejects a destination nested under the legacy source", async (t) => {
  const source = await mkdtemp(path.join(tmpdir(), "1667-data-migration-nested-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  await writeFile(path.join(source, "settings.json"), LEGACY_SETTINGS);

  await assert.rejects(migrateDataDirectory(source, path.join(source, "data-v1")), /must be outside/);
  assert.deepEqual(await readFile(path.join(source, "settings.json"), "utf8"), LEGACY_SETTINGS);
});

test("offline migration identifies a current marker before its retained lock file", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "1667-data-migration-current-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const source = path.join(parent, "current");
  const lock = new DataDirectoryLock(source);
  await lock.acquire();
  await lock.release();

  await assert.rejects(migrateDataDirectory(source, path.join(parent, "copy")), /already lock-aware/);
});

test("offline migration also identifies a legacy preview marker without converting it", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "1667-data-migration-preview-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const source = path.join(parent, "preview");
  await mkdir(source);
  await writeFile(path.join(source, LEGACY_PREVIEW_DATA_MARKER), LEGACY_PREVIEW_DATA_MARKER_TEXT);

  await assert.rejects(migrateDataDirectory(source, path.join(parent, "copy")), /already lock-aware/);
  await assert.rejects(access(path.join(source, DATA_DIRECTORY_OWNER_MARKER)));
});

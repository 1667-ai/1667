import assert from "node:assert/strict";
import {
  access,
  link,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DATA_DIRECTORY_OWNER_MARKER,
  DATA_DIRECTORY_OWNER_MARKER_NEXT,
  DATA_DIRECTORY_OWNER_MARKER_NEXT_SCRATCH,
  LEGACY_PREVIEW_DATA_MARKER,
  LEGACY_PREVIEW_DATA_MARKER_TEXT,
  SETTINGS_STATE_V2_FILE,
  dataDirectoryOwnerMarkerText
} from "../server/data-directory-format.js";
import { DataDirectoryLock } from "../server/data-directory-lock.js";
import { INITIAL_SETTINGS_STATE_V2_TEXT } from "../server/settings-v2-default.js";

test("locked marker adoption exposes canonical and legacy-preview sources", async (t) => {
  await t.test("canonical owner marker", async (t) => {
    const dataDir = await makeDataDirectory(t, "1667-marker-source-");
    const lock = new DataDirectoryLock(dataDir, { initializeDataFormat: 1 });

    assert.throws(() => lock.dataFormatSource, /before lock acquisition/);
    await lock.acquire();
    assert.equal(lock.dataFormat, 1);
    assert.equal(lock.dataFormatSource, "owner-marker");
    await lock.release();
    assert.throws(() => lock.dataFormatSource, /before lock acquisition/);
  });

  await t.test("legacy preview marker", async (t) => {
    const dataDir = await makeDataDirectory(t, "1667-preview-source-");
    await writeFile(
      path.join(dataDir, LEGACY_PREVIEW_DATA_MARKER),
      LEGACY_PREVIEW_DATA_MARKER_TEXT
    );
    const lock = new DataDirectoryLock(dataDir);

    await lock.acquire();
    assert.equal(lock.dataFormat, 1);
    assert.equal(lock.dataFormatSource, "legacy-preview");
    await lock.release();
  });
});

test("a pre-rename next marker never activates and is cleared after adoption", async (t) => {
  const dataDir = await makeDataDirectory(t, "1667-marker-next-");
  await initializeFormatOne(dataDir);
  const markerPath = path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER);
  const nextPath = path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER_NEXT);
  await writeFile(nextPath, dataDirectoryOwnerMarkerText(2), { mode: 0o600 });

  const lock = new DataDirectoryLock(dataDir);
  await lock.acquire();
  assert.equal(lock.dataFormat, 1);
  assert.equal(lock.dataFormatSource, "owner-marker");
  assert.equal(await readFile(markerPath, "utf8"), dataDirectoryOwnerMarkerText(1));
  await assertMissing(nextPath);
  await lock.release();
});

test("canonical staged marker residues are cleared after adoption", async (t) => {
  const formatTwo = Buffer.from(dataDirectoryOwnerMarkerText(2), "utf8");
  for (const residue of ["scratch-prefix", "linked-pair"] as const) {
    await t.test(residue, async (t) => {
      const dataDir = await makeDataDirectory(t, "1667-marker-staged-");
      await initializeFormatOne(dataDir);
      const nextPath = path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER_NEXT);
      const scratchPath = path.join(
        dataDir,
        DATA_DIRECTORY_OWNER_MARKER_NEXT_SCRATCH
      );
      if (residue === "scratch-prefix") {
        await writeFile(scratchPath, formatTwo.subarray(0, 19), { mode: 0o600 });
      } else {
        await writeFile(scratchPath, formatTwo, { mode: 0o600 });
        await link(scratchPath, nextPath);
      }

      const lock = new DataDirectoryLock(dataDir);
      await lock.acquire();
      assert.equal(lock.dataFormat, 1);
      await assertMissing(nextPath);
      await assertMissing(scratchPath);
      await lock.release();
    });
  }
});

test("a replaced data directory fails the retained-handle fence", {
  skip: process.platform === "win32"
}, async (t) => {
  // ADR007 keeps the retained descriptor that roots every later open. Nothing
  // may swap the directory out from under an acquired lock and be believed.
  const parent = await makeDataDirectory(t, "1667-directory-swap-");
  const dataDir = path.join(parent, "data");
  const displaced = path.join(parent, "displaced");
  const replacement = path.join(parent, "replacement");
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(replacement, { mode: 0o700 });
  await initializeFormatOne(dataDir);

  const lock = new DataDirectoryLock(dataDir);
  await lock.acquire();
  try {
    await rename(dataDir, displaced);
    await rename(replacement, dataDir);
    await assert.rejects(
      lock.migrateSettingsFormat(),
      /file identity changed/
    );
  } finally {
    await lock.release();
  }

  assert.equal((await stat(displaced)).isDirectory(), true);
  assert.equal((await stat(dataDir)).isDirectory(), true);
});

test("a symlinked next marker fails closed without touching its target", {
  skip: process.platform === "win32"
}, async (t) => {
  const parent = await makeDataDirectory(t, "1667-marker-symlink-");
  const dataDir = path.join(parent, "data");
  const target = path.join(parent, "outside");
  await mkdir(dataDir, { mode: 0o700 });
  await initializeFormatOne(dataDir);
  await writeFile(target, "outside-bytes");
  const nextPath = path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER_NEXT);
  await symlink(target, nextPath);

  await assert.rejects(
    new DataDirectoryLock(dataDir).acquire(),
    /is not safe private publication residue/
  );
  assert.equal(await readFile(target, "utf8"), "outside-bytes");
  assert.equal(await readFile(nextPath, "utf8"), "outside-bytes");
  assert.equal(
    await readFile(path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER), "utf8"),
    dataDirectoryOwnerMarkerText(1)
  );
});

test("conflicting owner-marker publication pairs fail closed without cleanup", async (t) => {
  const formatTwo = Buffer.from(dataDirectoryOwnerMarkerText(2), "utf8");
  for (const [name, scratch, expectedFailure] of [
    [
      "different complete value",
      Buffer.from(dataDirectoryOwnerMarkerText(1), "utf8"),
      /scratch is not an exact prefix/
    ],
    [
      "distinct partial value",
      formatTwo.subarray(0, 19),
      /distinct publication residue is not an exact complete pair/
    ]
  ] as const) {
    await t.test(name, async (t) => {
      const dataDir = await makeDataDirectory(t, "1667-marker-pair-");
      await initializeFormatOne(dataDir);
      const nextPath = path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER_NEXT);
      const scratchPath = path.join(
        dataDir,
        DATA_DIRECTORY_OWNER_MARKER_NEXT_SCRATCH
      );
      await writeFile(nextPath, formatTwo, { mode: 0o600 });
      await writeFile(scratchPath, scratch, { mode: 0o600 });

      await assert.rejects(
        new DataDirectoryLock(dataDir).acquire(),
        expectedFailure
      );

      assert.deepEqual(await readFile(nextPath), formatTwo);
      assert.deepEqual(await readFile(scratchPath), scratch);
      assert.equal(
        await readFile(path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER), "utf8"),
        dataDirectoryOwnerMarkerText(1)
      );
    });
  }
});

test("malformed typed marker residue is preserved for diagnosis", async (t) => {
  await t.test("next", async (t) => {
    const dataDir = await makeDataDirectory(t, "1667-marker-invalid-next-");
    await initializeFormatOne(dataDir);
    const nextPath = path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER_NEXT);
    const malformed = dataDirectoryOwnerMarkerText(2).replace(
      '"dataFormat":2',
      '"dataFormat":6'
    );
    await writeFile(nextPath, malformed, { mode: 0o600 });

    await assert.rejects(
      new DataDirectoryLock(dataDir).acquire(),
      /next is not the exact expected canonical bytes/
    );
    assert.equal(await readFile(nextPath, "utf8"), malformed);
  });

  await t.test("publication scratch", async (t) => {
    const dataDir = await makeDataDirectory(t, "1667-marker-invalid-scratch-");
    await initializeFormatOne(dataDir);
    const scratchPath = path.join(
      dataDir,
      DATA_DIRECTORY_OWNER_MARKER_NEXT_SCRATCH
    );
    await writeFile(scratchPath, "not-a-marker-prefix", { mode: 0o600 });

    await assert.rejects(
      new DataDirectoryLock(dataDir).acquire(),
      /scratch is not an exact prefix/
    );
    assert.equal(await readFile(scratchPath, "utf8"), "not-a-marker-prefix");
  });
});

test("a post-rename crash state durably adopts the complete current marker", async (t) => {
  const dataDir = await makeDataDirectory(t, "1667-marker-post-rename-");
  await initializeFormatOne(dataDir);
  await writeFile(
    path.join(dataDir, SETTINGS_STATE_V2_FILE),
    INITIAL_SETTINGS_STATE_V2_TEXT,
    { mode: 0o600 }
  );
  const markerPath = path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER);
  const nextPath = path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER_NEXT);
  await writeFile(nextPath, dataDirectoryOwnerMarkerText(2), { mode: 0o600 });
  await rename(nextPath, markerPath);

  const lock = new DataDirectoryLock(dataDir);
  await lock.acquire();
  assert.equal(lock.dataFormat, 2);
  assert.equal(lock.dataFormatSource, "owner-marker");
  await assertMissing(nextPath);
  await lock.release();
});

async function makeDataDirectory(
  t: { after(fn: () => Promise<void>): void },
  prefix: string
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function initializeFormatOne(dataDir: string): Promise<void> {
  const lock = new DataDirectoryLock(dataDir, { initializeDataFormat: 1 });
  await lock.acquire();
  await lock.release();
}

async function assertMissing(file: string): Promise<void> {
  await assert.rejects(access(file));
}

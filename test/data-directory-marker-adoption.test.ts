import assert from "node:assert/strict";
import {
  access,
  link,
  mkdtemp,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle
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

const FENCE = ".1667.lock";
const FENCE_TEXT = "1667-lock-aware-legacy-exclusion-v1\n";

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
    await writeFile(path.join(dataDir, FENCE), FENCE_TEXT);
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

test("a failed adoption barrier preserves next for a later retry", async (t) => {
  const dataDir = await makeDataDirectory(t, "1667-marker-barrier-");
  await initializeFormatOne(dataDir);
  const nextPath = path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER_NEXT);
  await writeFile(nextPath, dataDirectoryOwnerMarkerText(2), { mode: 0o600 });
  const lock = new DataDirectoryLock(dataDir);

  await withRetainedDirectorySyncHook(
    dataDir,
    () => {
      throw new Error("injected marker-adoption directory sync failure");
    },
    async () => {
      await assert.rejects(
        lock.acquire(),
        /injected marker-adoption directory sync failure/
      );
    }
  );

  assert.throws(() => lock.dataFormat, /before lock acquisition/);
  assert.equal(await readFile(nextPath, "utf8"), dataDirectoryOwnerMarkerText(2));

  const successor = new DataDirectoryLock(dataDir);
  await successor.acquire();
  assert.equal(successor.dataFormat, 1);
  await assertMissing(nextPath);
  await successor.release();
});

test("marker replacement during the adoption barrier fails closed", {
  skip: process.platform === "win32"
}, async (t) => {
  const parent = await makeDataDirectory(t, "1667-marker-swap-");
  const dataDir = path.join(parent, "data");
  await mkdir(dataDir, { mode: 0o700 });
  await initializeFormatOne(dataDir);
  const markerPath = path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER);
  const replacementPath = path.join(parent, "replacement-marker");
  await writeFile(replacementPath, dataDirectoryOwnerMarkerText(1), { mode: 0o600 });
  const originalIdentity = await stat(markerPath);

  await withRetainedDirectorySyncHook(
    dataDir,
    async () => {
      await rename(replacementPath, markerPath);
    },
    async () => {
      await assert.rejects(
        new DataDirectoryLock(dataDir).acquire(),
        /visible marker changed across the locked directory durability barrier/
      );
    }
  );

  assert.notEqual((await stat(markerPath)).ino, originalIdentity.ino);
  const successor = new DataDirectoryLock(dataDir);
  await successor.acquire();
  assert.equal(successor.dataFormat, 1);
  await successor.release();
});

test("data-directory replacement after locking fails the retained-handle fence", {
  skip: process.platform === "win32"
}, async (t) => {
  const parent = await makeDataDirectory(t, "1667-directory-swap-");
  const dataDir = path.join(parent, "data");
  const displaced = path.join(parent, "displaced");
  const replacement = path.join(parent, "replacement");
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(replacement, { mode: 0o700 });
  await initializeFormatOne(dataDir);

  await withRetainedDirectorySyncHook(
    dataDir,
    async () => {
      await rename(dataDir, displaced);
      await rename(replacement, dataDir);
    },
    async () => {
      await assert.rejects(
        new DataDirectoryLock(dataDir).acquire(),
        /file identity changed/
      );
    }
  );

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
      '"dataFormat":3'
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

interface FileHandlePrototype {
  sync(this: FileHandle): Promise<void>;
}

async function withRetainedDirectorySyncHook(
  dataDir: string,
  onSync: () => void | Promise<void>,
  run: () => Promise<void>
): Promise<void> {
  const expected = await stat(dataDir);
  const probe = await open(dataDir, process.platform === "win32" ? "a+" : "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandlePrototype;
  const originalSync = prototype.sync;
  let intercepted = false;
  await probe.close();

  prototype.sync = async function(this: FileHandle): Promise<void> {
    const current = await this.stat();
    if (
      !intercepted
      && current.isDirectory()
      && current.dev === expected.dev
      && current.ino === expected.ino
    ) {
      intercepted = true;
      await onSync();
    }
    await originalSync.call(this);
  };
  try {
    await run();
    assert.equal(intercepted, true, "retained data-directory fsync was not reached");
  } finally {
    prototype.sync = originalSync;
  }
}

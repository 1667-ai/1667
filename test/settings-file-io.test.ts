import assert from "node:assert/strict";
import {
  link,
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { SETTINGS_STATE_V2_NEXT_FILE } from "../server/data-directory-format.js";
import { privatePublicationScratchPath } from "../server/private-file-publication.js";
import {
  readOptionalSettingsFile,
  writePrivateSettingsFile
} from "../server/settings-file-io.js";
import { MAX_SETTINGS_STATE_BYTES } from "../server/settings-v2-scalars.js";

const COMPLETE_BYTES = Buffer.from('{"schemaVersion":2}', "utf8");

test("reserved settings recovery removes partial and complete unpublished scratch", async (t) => {
  const dataDir = await temporaryDirectory(t, "1667-settings-scratch-drop-");
  const nextFile = path.join(dataDir, SETTINGS_STATE_V2_NEXT_FILE);
  const scratch = privatePublicationScratchPath(nextFile);

  await writeFile(scratch, "{\"schemaVersion\":", { mode: 0o600 });
  assert.equal(await readOptionalSettingsFile(nextFile, MAX_SETTINGS_STATE_BYTES), null);
  await assert.rejects(lstat(scratch), hasFsCode("ENOENT"));

  await writeFile(scratch, COMPLETE_BYTES, { mode: 0o600 });
  assert.equal(await readOptionalSettingsFile(nextFile, MAX_SETTINGS_STATE_BYTES), null);
  await assert.rejects(lstat(scratch), hasFsCode("ENOENT"));
});

test("reserved settings recovery finalizes an already-published scratch link", async (t) => {
  if (process.platform === "win32") {
    t.skip("hard-link crash residue fixture is POSIX-specific");
    return;
  }
  const dataDir = await temporaryDirectory(t, "1667-settings-scratch-finish-");
  const nextFile = path.join(dataDir, SETTINGS_STATE_V2_NEXT_FILE);
  const scratch = privatePublicationScratchPath(nextFile);
  await writeFile(scratch, COMPLETE_BYTES, { mode: 0o600 });
  await link(scratch, nextFile);

  assert.deepEqual(
    await readOptionalSettingsFile(nextFile, MAX_SETTINGS_STATE_BYTES),
    COMPLETE_BYTES
  );
  await assert.rejects(lstat(scratch), hasFsCode("ENOENT"));
  assert.equal((await lstat(nextFile)).nlink, 1);
});

test("reserved settings recovery preserves a distinct valid final over scratch", async (t) => {
  const dataDir = await temporaryDirectory(t, "1667-settings-scratch-final-wins-");
  const nextFile = path.join(dataDir, SETTINGS_STATE_V2_NEXT_FILE);
  const scratch = privatePublicationScratchPath(nextFile);
  const abandoned = Buffer.from('{"schemaVersion":1}', "utf8");
  await writeFile(nextFile, COMPLETE_BYTES, { mode: 0o600 });
  await writeFile(scratch, abandoned, { mode: 0o600 });

  assert.deepEqual(
    await readOptionalSettingsFile(nextFile, MAX_SETTINGS_STATE_BYTES),
    COMPLETE_BYTES
  );
  assert.deepEqual(await readFile(nextFile), COMPLETE_BYTES);
  await assert.rejects(lstat(scratch), hasFsCode("ENOENT"));
});

test("reserved settings publication is complete, private, and no-replace", async (t) => {
  const dataDir = await temporaryDirectory(t, "1667-settings-publish-");
  const nextFile = path.join(dataDir, SETTINGS_STATE_V2_NEXT_FILE);
  const scratch = privatePublicationScratchPath(nextFile);

  await writePrivateSettingsFile(nextFile, COMPLETE_BYTES);

  assert.deepEqual(await readFile(nextFile), COMPLETE_BYTES);
  await assert.rejects(lstat(scratch), hasFsCode("ENOENT"));
  if (process.platform !== "win32") {
    const info = await lstat(nextFile);
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal(info.nlink, 1);
  }
  await assert.rejects(
    writePrivateSettingsFile(nextFile, Buffer.from('{"schemaVersion":3}', "utf8")),
    hasFsCode("EEXIST")
  );
  assert.deepEqual(await readFile(nextFile), COMPLETE_BYTES);
  await assert.rejects(lstat(scratch), hasFsCode("ENOENT"));
});

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function hasFsCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && "code" in error && error.code === code;
}

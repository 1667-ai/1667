import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { readDataDirectoryFormat } from "../server/data-directory-format.js";
import { DataDirectoryLock } from "../server/data-directory-lock.js";
import {
  decryptVault,
  encryptVault,
  VAULT_KEYSLOT_FILE
} from "../server/vault-lifecycle.js";
import { VAULT_UNSEAL_PROGRESS_DIRECTORY } from "../server/vault-unseal-progress.js";

test("encrypt rejects a payload hard link outside the data directory", async (t) => {
  const dataDirectory = await newVault(t, "1667-vault-external-hard-link-");
  const externalDirectory = await mkdtemp(path.join(tmpdir(), "1667-vault-external-alias-"));
  t.after(async () => await rm(externalDirectory, { recursive: true, force: true }));
  const external = path.join(externalDirectory, "external.json");
  const payload = path.join(dataDirectory, "story.json");
  const plaintext = "external hard-link sentinel";
  await writeFile(external, plaintext);
  await link(external, payload);

  await assert.rejects(
    encryptVault({ dataDirectory, password: "correct horse battery staple" }),
    /Vault hard-link group has aliases outside the data directory/
  );

  assert.equal(await readDataDirectoryFormat(dataDirectory), 4);
  assert.equal(await readFile(external, "utf8"), plaintext);
  await assert.rejects(readFile(path.join(dataDirectory, VAULT_KEYSLOT_FILE)), { code: "ENOENT" });
});

test("decrypt reports a progress-record failure without delete advice", async (t) => {
  const dataDirectory = await newVault(t, "1667-vault-progress-record-error-");
  const story = path.join(dataDirectory, "story.json");
  const progressDirectory = path.join(dataDirectory, VAULT_UNSEAL_PROGRESS_DIRECTORY);
  await writeFile(story, "progress record error sentinel");
  await encryptVault({ dataDirectory, password: "correct horse battery staple" });
  await mkdir(progressDirectory, { mode: 0o700 });
  const recordName = `${createHash("sha256").update("story.json", "utf8").digest("hex")}.json`;
  await writeFile(
    path.join(progressDirectory, recordName),
    `${JSON.stringify({ format: 1, path: "story.json", plaintextTag: "0".repeat(64) })}\n`,
    { mode: 0o600 }
  );

  await assert.rejects(
    decryptVault({ dataDirectory, password: "correct horse battery staple" }),
    (error: unknown) => {
      if (!(error instanceof Error)) return false;
      assert.match(error.message, /Vault unseal progress disagrees with/);
      assert.equal(error.message.includes("Delete this file"), false);
      return true;
    }
  );
});

test("decrypt records a POSIX backslash and dot-dot filename", async (t) => {
  if (process.platform === "win32") return;
  const dataDirectory = await newVault(t, "1667-vault-backslash-dot-dot-");
  const file = path.join(dataDirectory, "payload\\..");
  const plaintext = "backslash dot-dot filename sentinel";
  await writeFile(file, plaintext);

  await encryptVault({ dataDirectory, password: "correct horse battery staple" });
  await decryptVault({ dataDirectory, password: "correct horse battery staple" });

  assert.equal(await readFile(file, "utf8"), plaintext);
});

async function newVault(t: TestContext, prefix: string): Promise<string> {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(async () => await rm(dataDirectory, { recursive: true, force: true }));
  const initializer = new DataDirectoryLock(dataDirectory);
  await initializer.acquire();
  await initializer.release();
  return dataDirectory;
}

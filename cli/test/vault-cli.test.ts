import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DataDirectoryLock } from "../../server/data-directory-lock.js";
import { isSealed } from "../../shared/vault-cipher.js";
import { parseVaultCommand, runVaultDecrypt, runVaultEncrypt } from "../src/vault-cli.js";

test("vault command parser accepts only project and password options", () => {
  assert.deepEqual(parseVaultCommand([
    "--data", "book", "--passphrase-file=secret"
  ]), { data: "book", global: false, passphraseFile: "secret" });
  assert.throws(() => parseVaultCommand(["--global", "--data", "book"]), /select different projects/);
  assert.throws(() => parseVaultCommand(["--unknown"]), /unknown vault option/);
});

test("vault commands name their unavailable operation", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-vault-cli-absent-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const missing = path.join(root, "missing-project");

  await assert.rejects(runVaultEncrypt(["--data", missing]), /nothing to encrypt/);
  await assert.rejects(runVaultDecrypt(["--data", missing]), /nothing to decrypt/);
});

test("vault commands use a passphrase file for a non-interactive round trip", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-vault-cli-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const dataDirectory = path.join(root, ".1667");
  const initializer = new DataDirectoryLock(dataDirectory);
  await initializer.acquire();
  await initializer.release();
  const story = path.join(dataDirectory, "story.json");
  const passphraseFile = path.join(root, "vault-password");
  await writeFile(story, "command vault sentinel");
  await writeFile(passphraseFile, "correct horse battery staple\n");

  await runVaultEncrypt(["--data", root, "--passphrase-file", passphraseFile], {
    write: () => true
  });
  assert.equal(isSealed(await readFile(story)), true);
  await runVaultDecrypt(["--data", root, "--passphrase-file", passphraseFile]);
  assert.equal(await readFile(story, "utf8"), "command vault sentinel");
});

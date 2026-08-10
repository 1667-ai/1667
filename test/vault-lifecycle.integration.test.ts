import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  createKeyslot,
  encodeKeyslot,
  isSealed,
  keyslotWithState,
  parseKeyslot
} from "../shared/vault-cipher.js";
import { publishDataDirectoryOwnerMarker } from "../server/data-directory-format.js";
import { DataDirectoryLock } from "../server/data-directory-lock.js";
import {
  decryptVault,
  encryptVault,
  VAULT_KEYSLOT_FILE
} from "../server/vault-lifecycle.js";
import { readDataDirectoryFormat } from "../server/data-directory-format.js";
import { VAULT_UNSEAL_PROGRESS_DIRECTORY } from "../server/vault-unseal-progress.js";

interface VaultCipherCorpus {
  readonly sealedFile: {
    readonly magicHex: string;
    readonly overheadBytes: number;
    readonly nonceBytes: number;
    readonly tagBytes: number;
  };
  readonly keyslot: {
    readonly format: number;
    readonly kdf: { readonly name: string; readonly n: number; readonly r: number; readonly p: number; readonly saltBytes: number };
    readonly sealedKey: { readonly nonceBytes: number; readonly dataBytes: number };
  };
}

test("vault lifecycle seals a project, preserves hard links, and restores plaintext", async (t) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "1667-vault-lifecycle-"));
  t.after(async () => await rm(dataDirectory, { recursive: true, force: true }));
  const initializer = new DataDirectoryLock(dataDirectory);
  await initializer.acquire();
  await initializer.release();

  await mkdir(path.join(dataDirectory, "stories"));
  await writeFile(path.join(dataDirectory, ".gitignore"), "run.json\n");
  const first = path.join(dataDirectory, "stories", "first.json");
  const second = path.join(dataDirectory, "stories", "second.json");
  const plaintext = "vault integration sentinel: small green comet";
  await writeFile(first, plaintext);
  await link(first, second);

  await encryptVault({ dataDirectory, password: "correct horse battery staple" });

  const sealed = await readFile(first);
  const corpus = JSON.parse(await readFile(new URL("../schema/vault-cipher.corpus.json", import.meta.url), "utf8")) as VaultCipherCorpus;
  const keyslot = JSON.parse(await readFile(path.join(dataDirectory, VAULT_KEYSLOT_FILE), "utf8")) as {
    format: number;
    kdf: { name: string; n: number; r: number; p: number; salt: string };
    sealedKey: { nonce: string; data: string };
    state: string;
  };
  assert.equal(isSealed(sealed), true);
  assert.equal(sealed.subarray(0, 8).toString("hex"), corpus.sealedFile.magicHex);
  assert.equal(sealed.byteLength - Buffer.byteLength(plaintext), corpus.sealedFile.overheadBytes);
  assert.equal(await readFile(path.join(dataDirectory, ".gitignore"), "utf8"), "run.json\n");
  assert.equal(keyslot.state, "sealed");
  assert.equal(keyslot.format, corpus.keyslot.format);
  assert.deepEqual(
    { name: keyslot.kdf.name, n: keyslot.kdf.n, r: keyslot.kdf.r, p: keyslot.kdf.p },
    { name: corpus.keyslot.kdf.name, n: corpus.keyslot.kdf.n, r: corpus.keyslot.kdf.r, p: corpus.keyslot.kdf.p }
  );
  assert.equal(Buffer.from(keyslot.kdf.salt, "base64").byteLength, corpus.keyslot.kdf.saltBytes);
  assert.equal(Buffer.from(keyslot.sealedKey.nonce, "base64").byteLength, corpus.keyslot.sealedKey.nonceBytes);
  assert.equal(Buffer.from(keyslot.sealedKey.data, "base64").byteLength, corpus.keyslot.sealedKey.dataBytes);
  assert.equal((await stat(first)).ino, (await stat(second)).ino);
  await assert.rejects(
    decryptVault({ dataDirectory, password: "wrong password" }),
    /authentication failed/
  );

  await decryptVault({ dataDirectory, password: "correct horse battery staple" });

  assert.equal(await readFile(first, "utf8"), plaintext);
  assert.equal((await stat(first)).ino, (await stat(second)).ino);
  await assert.rejects(readFile(path.join(dataDirectory, VAULT_KEYSLOT_FILE)), { code: "ENOENT" });
});

test("encrypt resumes from a durable sealing Keyslot", async (t) => {
  const dataDirectory = await newVault(t, "1667-vault-sealing-resume-");
  const story = path.join(dataDirectory, "story.json");
  const password = "correct horse battery staple";
  await writeFile(story, "sealing resume sentinel");
  const keyslot = await createKeyslot(password, randomBytes(32));
  await writeFile(
    path.join(dataDirectory, VAULT_KEYSLOT_FILE),
    encodeKeyslot(keyslotWithState(keyslot, "sealing")),
    { mode: 0o600 }
  );
  await publishDataDirectoryOwnerMarker(dataDirectory, 5);

  await encryptVault({ dataDirectory, password });

  assert.equal(isSealed(await readFile(story)), true);
  assert.equal(JSON.parse(await readFile(path.join(dataDirectory, VAULT_KEYSLOT_FILE), "utf8")).state, "sealed");
});

test("encrypt seals a plaintext file that carries the public seal magic", async (t) => {
  const dataDirectory = await newVault(t, "1667-vault-magic-prefix-");
  const file = path.join(dataDirectory, "crafted.json");
  const plaintext = Buffer.concat([
    Buffer.from([0x00, 0x31, 0x36, 0x36, 0x37, 0x56, 0x01, 0x01]),
    Buffer.alloc(48, 0x61)
  ]);
  await writeFile(file, plaintext);

  await encryptVault({ dataDirectory, password: "correct horse battery staple" });

  assert.equal(isSealed(await readFile(file)), true);
  await decryptVault({ dataDirectory, password: "correct horse battery staple" });
  assert.deepEqual(await readFile(file), plaintext);
});

test("encrypt seals a POSIX backslash progress look-alike", async (t) => {
  if (process.platform === "win32") return;
  const dataDirectory = await newVault(t, "1667-vault-progress-look-alike-");
  const filename = `.1667-vault-unseal-progress\\${"a".repeat(64)}.json`;
  const file = path.join(dataDirectory, filename);
  const plaintext = "backslash progress look-alike sentinel";
  await writeFile(file, plaintext);

  await encryptVault({ dataDirectory, password: "correct horse battery staple" });

  assert.equal(isSealed(await readFile(file)), true);
  await decryptVault({ dataDirectory, password: "correct horse battery staple" });
  assert.equal(await readFile(file, "utf8"), plaintext);
});

test("encrypt refuses a pre-existing unseal progress directory before format 5", async (t) => {
  const dataDirectory = await newVault(t, "1667-vault-preexisting-progress-");
  const progressDirectory = path.join(dataDirectory, VAULT_UNSEAL_PROGRESS_DIRECTORY);
  const child = path.join(progressDirectory, "unexpected.txt");
  await mkdir(progressDirectory, { mode: 0o700 });
  await writeFile(child, "unexpected plaintext progress child");

  await assert.rejects(
    encryptVault({ dataDirectory, password: "correct horse battery staple" }),
    /Vault unseal progress already exists/
  );

  assert.equal(await readDataDirectoryFormat(dataDirectory), 4);
  assert.equal(await readFile(child, "utf8"), "unexpected plaintext progress child");
  await assert.rejects(readFile(path.join(dataDirectory, VAULT_KEYSLOT_FILE)), { code: "ENOENT" });
});

test("encrypt preserves deceptive replace residue and removes valid residue", async (t) => {
  const dataDirectory = await newVault(t, "1667-vault-replace-residue-");
  const deceptive = [
    path.join(dataDirectory, ".1667-vault-replace-123e4567-e89b-12d3-a456-426614174000.tmp"),
    path.join(dataDirectory, ".1667-vault-replace-123E4567-E89B-42D3-A456-426614174000.tmp")
  ];
  const validResidue = path.join(
    dataDirectory,
    ".1667-vault-replace-123e4567-e89b-42d3-a456-426614174000.tmp"
  );
  const plaintext = "deceptive replace residue sentinel";
  await Promise.all(deceptive.map(async (file) => await writeFile(file, plaintext)));
  await writeFile(validResidue, "abandoned replacement bytes");

  await encryptVault({ dataDirectory, password: "correct horse battery staple" });

  for (const file of deceptive) assert.equal(isSealed(await readFile(file)), true);
  await assert.rejects(readFile(validResidue), { code: "ENOENT" });
  await decryptVault({ dataDirectory, password: "correct horse battery staple" });
  for (const file of deceptive) assert.equal(await readFile(file, "utf8"), plaintext);
});

test("encrypt seals malformed root control residue chains", async (t) => {
  const dataDirectory = await newVault(t, "1667-vault-control-residue-chain-");
  const valid = path.join(dataDirectory, ".gitignore.1667-replace-v1.next.1667-publish-v1.tmp");
  const malformed = [
    path.join(dataDirectory, ".gitignore.1667-publish-v1.tmp.1667-publish-v1.tmp"),
    path.join(dataDirectory, ".gitignore.1667-publish-v1.tmp.1667-replace-v1.next"),
    path.join(dataDirectory, ".gitignore.1667-replace-v1.next.1667-replace-v1.next")
  ];
  await writeFile(valid, "valid control residue sentinel");
  await Promise.all(malformed.map(async (file) => await writeFile(file, "malformed control residue sentinel")));

  await encryptVault({ dataDirectory, password: "correct horse battery staple" });

  assert.equal(isSealed(await readFile(valid)), false);
  for (const file of malformed) assert.equal(isSealed(await readFile(file)), true);
  await decryptVault({ dataDirectory, password: "correct horse battery staple" });
  assert.equal(await readFile(valid, "utf8"), "valid control residue sentinel");
  for (const file of malformed) {
    assert.equal(await readFile(file, "utf8"), "malformed control residue sentinel");
  }
});

test("encrypt refuses a symbolic-link payload before format 5", async (t) => {
  if (process.platform === "win32") return;
  const dataDirectory = await newVault(t, "1667-vault-symbolic-link-");
  const linkPath = path.join(dataDirectory, "payload-link");
  await symlink("missing-payload", linkPath);

  await assert.rejects(
    encryptVault({ dataDirectory, password: "correct horse battery staple" }),
    /Vault contains an unsupported filesystem entry/
  );

  assert.equal(await readDataDirectoryFormat(dataDirectory), 4);
  await assert.rejects(readFile(path.join(dataDirectory, VAULT_KEYSLOT_FILE)), { code: "ENOENT" });
});

test("encrypt refuses a hard link from a control file to payload", async (t) => {
  const dataDirectory = await newVault(t, "1667-vault-control-hard-link-");
  const control = path.join(dataDirectory, ".gitignore");
  const payload = path.join(dataDirectory, "story.json");
  await writeFile(control, "control and payload hard-link sentinel");
  await link(control, payload);

  await assert.rejects(
    encryptVault({ dataDirectory, password: "correct horse battery staple" }),
    /Vault hard-link group mixes control and payload paths/
  );

  assert.equal(await readDataDirectoryFormat(dataDirectory), 4);
  assert.equal((await stat(control)).ino, (await stat(payload)).ino);
  assert.equal(await readFile(payload, "utf8"), "control and payload hard-link sentinel");
  await assert.rejects(readFile(path.join(dataDirectory, VAULT_KEYSLOT_FILE)), { code: "ENOENT" });
});

test("decrypt resume removes an exact stale run record atomic residue", async (t) => {
  const dataDirectory = await newVault(t, "1667-vault-run-record-residue-");
  const story = path.join(dataDirectory, "story.json");
  const residue = path.join(
    dataDirectory,
    "run.json.123e4567-e89b-42d3-a456-426614174000.tmp"
  );
  const plaintext = "run record residue resume sentinel";
  await writeFile(story, plaintext);
  await encryptVault({ dataDirectory, password: "correct horse battery staple" });
  await assert.rejects(
    decryptVault({
      dataDirectory,
      password: "correct horse battery staple",
      afterUnsealReplacement: async () => {
        throw new Error("simulated crash before run record cleanup");
      }
    }),
    /simulated crash before run record cleanup/
  );
  await writeFile(residue, "plaintext stale run record");

  await decryptVault({ dataDirectory, password: "correct horse battery staple" });

  assert.equal(await readFile(story, "utf8"), plaintext);
  await assert.rejects(readFile(residue), { code: "ENOENT" });
});

test("encrypt seals a malformed run record atomic name", async (t) => {
  const dataDirectory = await newVault(t, "1667-vault-run-record-look-alike-");
  const file = path.join(
    dataDirectory,
    "run.json.123e4567-e89b-12d3-a456-426614174000.tmp"
  );
  const plaintext = "malformed run record atomic sentinel";
  await writeFile(file, plaintext);

  await encryptVault({ dataDirectory, password: "correct horse battery staple" });

  assert.equal(isSealed(await readFile(file)), true);
  await decryptVault({ dataDirectory, password: "correct horse battery staple" });
  assert.equal(await readFile(file, "utf8"), plaintext);
});

test("decrypt resume accepts a witnessed magic-prefix plaintext replacement", async (t) => {
  const dataDirectory = await newVault(t, "1667-vault-magic-resume-");
  const file = path.join(dataDirectory, "crafted.json");
  const plaintext = Buffer.concat([
    Buffer.from([0x00, 0x31, 0x36, 0x36, 0x37, 0x56, 0x01, 0x01]),
    Buffer.alloc(48, 0x62)
  ]);
  await writeFile(file, plaintext);
  await encryptVault({ dataDirectory, password: "correct horse battery staple" });

  await assert.rejects(
    decryptVault({
      dataDirectory,
      password: "correct horse battery staple",
      afterUnsealReplacement: async () => {
        throw new Error("simulated crash after magic replacement");
      }
    }),
    /simulated crash after magic replacement/
  );
  if (process.platform !== "win32") {
    assert.equal(
      (await stat(path.join(dataDirectory, VAULT_UNSEAL_PROGRESS_DIRECTORY))).mode & 0o777,
      0o700
    );
  }
  await decryptVault({ dataDirectory, password: "correct horse battery staple" });

  assert.deepEqual(await readFile(file), plaintext);
});

test("decrypt refuses an unseal progress directory with an unknown child", async (t) => {
  const dataDirectory = await newVault(t, "1667-vault-unknown-progress-child-");
  const story = path.join(dataDirectory, "story.json");
  const progressDirectory = path.join(dataDirectory, VAULT_UNSEAL_PROGRESS_DIRECTORY);
  await writeFile(story, "unknown progress child sentinel");
  await encryptVault({ dataDirectory, password: "correct horse battery staple" });
  await mkdir(progressDirectory, { mode: 0o700 });
  await writeFile(path.join(progressDirectory, "unexpected.txt"), "unexpected plaintext child");

  await assert.rejects(
    decryptVault({ dataDirectory, password: "correct horse battery staple" }),
    /Vault unseal progress has an unknown entry/
  );

  assert.equal(await readDataDirectoryFormat(dataDirectory), 5);
  assert.equal(isSealed(await readFile(story)), true);
});

test("decrypt refuses a repeated unseal progress residue before format 4", async (t) => {
  const dataDirectory = await newVault(t, "1667-vault-progress-residue-chain-");
  const story = path.join(dataDirectory, "story.json");
  const progressDirectory = path.join(dataDirectory, VAULT_UNSEAL_PROGRESS_DIRECTORY);
  const malformed = path.join(
    progressDirectory,
    `${"a".repeat(64)}.json.1667-publish-v1.tmp.1667-publish-v1.tmp`
  );
  await writeFile(story, "repeated progress residue sentinel");
  await encryptVault({ dataDirectory, password: "correct horse battery staple" });
  await mkdir(progressDirectory, { mode: 0o700 });
  await writeFile(malformed, "malformed progress residue");

  await assert.rejects(
    decryptVault({ dataDirectory, password: "correct horse battery staple" }),
    /Vault unseal progress has an unknown entry/
  );

  assert.equal(await readDataDirectoryFormat(dataDirectory), 5);
  assert.equal(isSealed(await readFile(story)), true);
});

test("decrypt accepts an empty unseal progress directory", async (t) => {
  const dataDirectory = await newVault(t, "1667-vault-empty-progress-");
  const story = path.join(dataDirectory, "story.json");
  const progressDirectory = path.join(dataDirectory, VAULT_UNSEAL_PROGRESS_DIRECTORY);
  await writeFile(story, "empty progress directory sentinel");
  await encryptVault({ dataDirectory, password: "correct horse battery staple" });
  await mkdir(progressDirectory, { mode: 0o700 });

  await decryptVault({ dataDirectory, password: "correct horse battery staple" });

  assert.equal(await readFile(story, "utf8"), "empty progress directory sentinel");
  await assert.rejects(readFile(progressDirectory), { code: "ENOENT" });
});

test("decrypt refuses an unwitnessed sealed file that fails authentication", async (t) => {
  const dataDirectory = await newVault(t, "1667-vault-corrupt-ciphertext-");
  const file = path.join(dataDirectory, "story.json");
  await writeFile(file, "ciphertext corruption sentinel");
  await encryptVault({ dataDirectory, password: "correct horse battery staple" });
  const corrupted = await readFile(file);
  const lastIndex = corrupted.byteLength - 1;
  const lastByte = corrupted[lastIndex];
  if (lastByte === undefined) throw new Error("sealed test file is empty");
  corrupted[lastIndex] = lastByte ^ 0x01;
  await writeFile(file, corrupted);

  await assert.rejects(
    decryptVault({ dataDirectory, password: "correct horse battery staple" }),
    /authentication failed/
  );
  assert.equal(isSealed(await readFile(file)), true);
});

test("decrypt tail removes an unsealing Keyslot without a password", async (t) => {
  const dataDirectory = await newVault(t, "1667-vault-decrypt-tail-");
  const story = path.join(dataDirectory, "story.json");
  const password = "correct horse battery staple";
  await writeFile(story, "decrypt tail sentinel");
  await encryptVault({ dataDirectory, password });
  const sealedKeyslot = parseKeyslot(await readFile(path.join(dataDirectory, VAULT_KEYSLOT_FILE)));
  await decryptVault({ dataDirectory, password });
  await writeFile(
    path.join(dataDirectory, VAULT_KEYSLOT_FILE),
    encodeKeyslot(keyslotWithState(sealedKeyslot, "unsealing")),
    { mode: 0o600 }
  );

  await decryptVault({ dataDirectory });

  assert.equal(await readFile(story, "utf8"), "decrypt tail sentinel");
  await assert.rejects(readFile(path.join(dataDirectory, VAULT_KEYSLOT_FILE)), { code: "ENOENT" });
});

test("a held vault lock refuses before the password provider runs", async (t) => {
  const dataDirectory = await newVault(t, "1667-vault-password-lock-");
  const holder = new DataDirectoryLock(dataDirectory);
  await holder.acquire();
  t.after(async () => await holder.release());
  let passwordRequests = 0;

  await assert.rejects(
    encryptVault({
      dataDirectory,
      password: async () => {
        passwordRequests += 1;
        return "correct horse battery staple";
      }
    }),
    /already open/
  );

  assert.equal(passwordRequests, 0);
});

async function newVault(t: TestContext, prefix: string): Promise<string> {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(async () => await rm(dataDirectory, { recursive: true, force: true }));
  const initializer = new DataDirectoryLock(dataDirectory);
  await initializer.acquire();
  await initializer.release();
  return dataDirectory;
}

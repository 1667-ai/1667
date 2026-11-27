import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  createKeyslot,
  encodeKeyslot,
  keyslotWithState,
  sealVaultBytes,
  sealVersion,
  VAULT_SEAL_VERSION_BOUND,
  VAULT_SEAL_VERSION_UNBOUND
} from "../shared/vault-cipher.js";
import { publishDataDirectoryOwnerMarker } from "../server/data-directory-format.js";
import { DataDirectoryLock } from "../server/data-directory-lock.js";
import { writeDurableAtomic } from "../server/story-lifecycle.js";
import { readUnsealedFile } from "../server/vault-file-read.js";
import { registerVaultKey } from "../server/vault-key-registry.js";
import {
  decryptVault,
  encryptVault,
  VAULT_KEYSLOT_FILE
} from "../server/vault-lifecycle.js";
import { vaultSealBinding } from "../server/vault-seal-binding.js";

const PASSWORD = "correct horse battery staple";

interface VaultCipherCorpus {
  readonly sealedFile: {
    readonly prefixHex: string;
    readonly sealVersionUnbound: number;
    readonly sealVersionBound: number;
  };
}

/** The published format contract, so a version number cannot drift silently. */
const CORPUS = JSON.parse(
  await readFile(new URL("../schema/vault-cipher.corpus.json", import.meta.url), "utf8")
) as VaultCipherCorpus;

test("a sealed vault reads both the unbound and the bound seal version", async (t) => {
  const root = await newVault(t, "1667-seal-version-read-");
  const key = randomBytes(32);
  const registration = registerVaultKey(root, key);
  t.after(() => registration.clear());

  const unboundText = "unbound seal sentinel: amber lighthouse";
  const boundText = "bound seal sentinel: small green comet";
  const unbound = path.join(root, "mutation-outbox", "unbound.json");
  const bound = await objectPath(root, "story-a", "chunks", boundText);
  await mkdir(path.dirname(unbound), { recursive: true });
  await writeFile(unbound, sealVaultBytes(key, Buffer.from(unboundText)));
  await writeFile(bound, sealBound(key, root, bound, boundText));

  assert.equal(VAULT_SEAL_VERSION_UNBOUND, CORPUS.sealedFile.sealVersionUnbound);
  assert.equal(VAULT_SEAL_VERSION_BOUND, CORPUS.sealedFile.sealVersionBound);
  const unboundBytes = await readFile(unbound);
  const boundBytes = await readFile(bound);
  // Both versions keep the prefix every build recognizes, so an older build
  // reports an unreadable version rather than mistaking a seal for plaintext.
  for (const sealed of [unboundBytes, boundBytes]) {
    assert.equal(sealed.subarray(0, 7).toString("hex"), CORPUS.sealedFile.prefixHex);
  }
  assert.equal(sealVersion(unboundBytes), VAULT_SEAL_VERSION_UNBOUND);
  assert.equal(sealVersion(boundBytes), VAULT_SEAL_VERSION_BOUND);
  assert.equal((await readUnsealedFile(unbound)).toString("utf8"), unboundText);
  assert.equal((await readUnsealedFile(bound)).toString("utf8"), boundText);
});

test("a bound object ciphertext does not open under another object's name", async (t) => {
  const root = await newVault(t, "1667-seal-version-relocate-");
  const key = randomBytes(32);
  const registration = registerVaultKey(root, key);
  t.after(() => registration.clear());

  const secret = "relocation sentinel: the private chapter";
  const source = await objectPath(root, "story-a", "chunks", secret);
  const decoy = await objectPath(root, "story-a", "chunks", "a harmless public note");
  await writeFile(source, sealBound(key, root, source, secret));

  // The attacker owns the filesystem: they copy one object's ciphertext onto
  // another object's name, whose plaintext the product may export or send.
  await writeFile(decoy, await readFile(source));

  await assert.rejects(readUnsealedFile(decoy), /authentication failed/);
  assert.equal((await readUnsealedFile(source)).toString("utf8"), secret);
});

test("one object stays readable at every story that reuses its bytes", async (t) => {
  const root = await newVault(t, "1667-seal-version-reuse-");
  const key = randomBytes(32);
  const registration = registerVaultKey(root, key);
  t.after(() => registration.clear());

  // `StoryObjectStore` hard-links one identical object into several stories, so
  // a single ciphertext must authenticate at the same kind and hash under any
  // story. A path binding would have broken that reuse.
  const shared = "object reuse sentinel: the shared paragraph";
  const first = await objectPath(root, "story-a", "chunks", shared);
  const second = await objectPath(root, "story-b", "chunks", shared);
  await writeFile(first, sealBound(key, root, first, shared));
  await writeFile(second, await readFile(first));

  assert.equal((await readUnsealedFile(first)).toString("utf8"), shared);
  assert.equal((await readUnsealedFile(second)).toString("utf8"), shared);
});

test("a changed seal version byte fails instead of selecting another rule", async (t) => {
  const root = await newVault(t, "1667-seal-version-tamper-");
  const key = randomBytes(32);
  const registration = registerVaultKey(root, key);
  t.after(() => registration.clear());

  const first = "version tamper sentinel: nine brass keys";
  const second = "version tamper sentinel: four copper bells";
  const raisedObject = await objectPath(root, "story-a", "chunks", first);
  const loweredObject = await objectPath(root, "story-a", "chunks", second);
  const raisedPlain = path.join(root, "unbound.json");
  await writeFile(raisedObject, withSealVersion(sealVaultBytes(key, Buffer.from(first)), VAULT_SEAL_VERSION_BOUND));
  await writeFile(loweredObject, withSealVersion(sealBound(key, root, loweredObject, second), VAULT_SEAL_VERSION_UNBOUND));
  await writeFile(raisedPlain, withSealVersion(sealVaultBytes(key, Buffer.from(first)), VAULT_SEAL_VERSION_BOUND));

  // Where a binding exists, the tag covers the version byte, so a flip in
  // either direction fails authentication.
  await assert.rejects(readUnsealedFile(raisedObject), /authentication failed/);
  await assert.rejects(readUnsealedFile(loweredObject), /authentication failed/);
  // Where none exists, the raised version is refused for the missing binding.
  await assert.rejects(readUnsealedFile(raisedPlain), /needs its location binding/);
});

test("a bound seal at a path that takes no binding fails closed", async (t) => {
  // Only a story object carries a binding. A bound seal anywhere else has
  // nothing to authenticate against, so the read must refuse it rather than
  // fall back to reading it unbound.
  const root = await newVault(t, "1667-seal-version-unbindable-");
  const key = randomBytes(32);
  const registration = registerVaultKey(root, key);
  t.after(() => registration.clear());

  const secret = "unbindable sentinel: the private chapter";
  const object = await objectPath(root, "story-a", "chunks", secret);
  const plain = path.join(root, "mutation-outbox", "record.json");
  await mkdir(path.dirname(plain), { recursive: true });
  await writeFile(object, sealBound(key, root, object, secret));
  await writeFile(plain, await readFile(object));

  assert.equal(vaultSealBinding(path.relative(root, plain)), null);
  await assert.rejects(readUnsealedFile(plain), /needs its location binding/);
});

test("a seal version this build cannot open is refused, not sealed again", async (t) => {
  const root = await newVault(t, "1667-seal-version-unknown-");
  const file = path.join(root, "newer.json");
  await writeFile(file, withSealVersion(sealVaultBytes(randomBytes(32), Buffer.alloc(48, 0x61)), 9));

  await assert.rejects(
    encryptVault({ dataDirectory: root, password: PASSWORD }),
    /needs a newer 1667/
  );
});

test("decrypt restores a vault that mixes unbound and bound seals", async (t) => {
  // The downgrade this release exists to survive: a newer build wrote one
  // bound file into a vault whose other files this build sealed itself, and
  // the user then runs an older `1667 decrypt`.
  const root = await newVault(t, "1667-seal-version-decrypt-");
  const key = randomBytes(32);
  const text = "downgrade sentinel: the last unsealed page";
  const story = await objectPath(root, "story-a", "revisions", text);
  await writeFile(story, text);
  await writeFile(
    path.join(root, VAULT_KEYSLOT_FILE),
    encodeKeyslot(keyslotWithState(await createKeyslot(PASSWORD, key), "sealing")),
    { mode: 0o600 }
  );
  await publishDataDirectoryOwnerMarker(root, 5);
  await encryptVault({ dataDirectory: root, password: PASSWORD });
  assert.equal(sealVersion(await readFile(story)), VAULT_SEAL_VERSION_UNBOUND);
  await writeFile(story, sealBound(key, root, story, text));

  await decryptVault({ dataDirectory: root, password: PASSWORD });

  assert.equal(await readFile(story, "utf8"), text);
  await assert.rejects(readFile(path.join(root, VAULT_KEYSLOT_FILE)), { code: "ENOENT" });
});

test("decrypt refuses a hard-link group that disagrees on its binding", async (t) => {
  // Hard-linking reaches the plaintext without touching the ciphertext: one
  // alias authenticates, and the group replacement would then publish that
  // plaintext at every other name. `decrypt` must refuse the whole group.
  const root = await newVault(t, "1667-seal-version-alias-");
  const key = randomBytes(32);
  const secret = "alias relocation sentinel: the private chapter";
  const story = await objectPath(root, "story-a", "revisions", secret);
  const relocated = path.join(root, "relocated.json");
  await writeFile(story, secret);
  await writeFile(
    path.join(root, VAULT_KEYSLOT_FILE),
    encodeKeyslot(keyslotWithState(await createKeyslot(PASSWORD, key), "sealing")),
    { mode: 0o600 }
  );
  await publishDataDirectoryOwnerMarker(root, 5);
  await encryptVault({ dataDirectory: root, password: PASSWORD });
  await writeFile(story, sealBound(key, root, story, secret));
  await link(story, relocated);

  await assert.rejects(
    decryptVault({ dataDirectory: root, password: PASSWORD }),
    /disagrees on its seal binding/
  );

  assert.equal((await readFile(relocated)).includes(Buffer.from(secret)), false);
  assert.equal((await readFile(story)).includes(Buffer.from(secret)), false);
});

test("this build still writes the unbound seal version", async (t) => {
  const root = await newVault(t, "1667-seal-version-writer-");
  const registration = registerVaultKey(root, randomBytes(32));
  t.after(() => registration.clear());
  const file = path.join(root, "written.json");

  await writeDurableAtomic(file, "writer sentinel\n");

  assert.equal(sealVersion(await readFile(file)), VAULT_SEAL_VERSION_UNBOUND);
});

function sealBound(key: Uint8Array, root: string, file: string, text: string): Buffer {
  const binding = vaultSealBinding(path.relative(root, file));
  assert.notEqual(binding, null, `${file} takes no seal binding`);
  return sealVaultBytes(key, Buffer.from(text), binding!);
}

/** Rewrite the seal version byte the way a tampering attacker would. */
function withSealVersion(sealed: Buffer, version: number): Buffer {
  const copy = Buffer.from(sealed);
  copy[7] = version;
  return copy;
}

/** The content-addressed location `StoryObjectStore` would publish to. */
async function objectPath(
  root: string,
  storyId: string,
  kind: "chunks" | "revisions",
  content: string
): Promise<string> {
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  const extension = kind === "chunks" ? ".txt" : ".json";
  const file = path.join(root, "stories", storyId, kind, hash.slice(0, 2), `${hash}${extension}`);
  await mkdir(path.dirname(file), { recursive: true });
  return file;
}

async function newVault(t: TestContext, prefix: string): Promise<string> {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(async () => await rm(dataDirectory, { recursive: true, force: true }));
  const initializer = new DataDirectoryLock(dataDirectory);
  await initializer.acquire();
  await initializer.release();
  return dataDirectory;
}

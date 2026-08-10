import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isSealed } from "../shared/vault-cipher.js";
import { MutationOutbox } from "../server/mutation-outbox.js";
import { publishProjectRunRecord, readProjectRunRecord } from "../server/project-run-record.js";
import { RuntimeDataDirectoryLock } from "../server/runtime-data-directory.js";
import { writeDurableAtomic } from "../server/story-lifecycle.js";
import {
  isVaultControlPath,
  registerVaultKey,
  vaultKeyForPath
} from "../server/vault-key-registry.js";

test("sealed storage hooks keep mutation records encrypted on disk and readable in process", async (t) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "1667-vault-storage-hooks-"));
  t.after(async () => await rm(dataDirectory, { recursive: true, force: true }));
  const registration = registerVaultKey(dataDirectory, randomBytes(32));
  t.after(() => registration.clear());

  const mutationId = "m1.1767225600000.0123456789abcdef0123456789abcdef";
  const sentinel = "vault storage hook sentinel: amber lighthouse";
  const outbox = new MutationOutbox(path.join(dataDirectory, "mutation-outbox"));
  await outbox.init();
  await outbox.enqueue(mutationId, "createStory", { title: sentinel });

  const stored = await readFile(path.join(dataDirectory, "mutation-outbox", `${mutationId}.json`));
  assert.equal(isSealed(stored), true);
  assert.equal(stored.includes(Buffer.from(sentinel)), false);
  const [record] = await new MutationOutbox(path.join(dataDirectory, "mutation-outbox")).list();
  assert.equal((record?.input as { title?: unknown } | undefined)?.title, sentinel);
});

test("a scoped key registration covers retained authority writes and leaves atomic control files plain", async (t) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "1667-vault-authority-hooks-"));
  t.after(async () => await rm(dataDirectory, { recursive: true, force: true }));
  const lock = new RuntimeDataDirectoryLock(dataDirectory);
  const canonical = await lock.acquire();
  t.after(async () => await lock.release());
  const authority = lock.authorityPath;
  const registration = registerVaultKey(canonical, randomBytes(32));
  registration.addAlias(authority);
  t.after(() => registration.clear());
  const registeredKey = vaultKeyForPath(path.join(authority, "mutation-outbox", "probe.json"));
  assert.notEqual(registeredKey, null);

  const mutationId = "m1.1767225600000.1123456789abcdef0123456789abcdef";
  const sentinel = "retained authority vault sentinel";
  const outbox = new MutationOutbox(path.join(authority, "mutation-outbox"));
  await outbox.init();
  await outbox.enqueue(mutationId, "createStory", { title: sentinel });
  const stored = await readFile(path.join(authority, "mutation-outbox", `${mutationId}.json`));
  assert.equal(isSealed(stored), true);
  const [record] = await outbox.list();
  assert.equal((record?.input as { title?: unknown } | undefined)?.title, sentinel);

  const runRecord = { pid: process.pid, port: null, url: null, startedAt: "2026-08-09T00:00:00.000Z" };
  await publishProjectRunRecord(authority, runRecord);
  const storedRunRecord = await readFile(path.join(authority, "run.json"));
  assert.equal(isSealed(storedRunRecord), false);
  registration.clear();
  assert.deepEqual(await readProjectRunRecord(authority), runRecord);
  assert.equal(vaultKeyForPath(path.join(authority, "mutation-outbox", "probe.json")), null);
  assert.equal(registeredKey!.every((byte) => byte === 0), true);
});

test("an alias collision can clear a failed scoped registration without leaving its key active", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-vault-alias-collision-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const alias = path.join(root, "retained-authority");
  await mkdir(alias);
  const registration = registerVaultKey(root, randomBytes(32));
  const registeredKey = vaultKeyForPath(path.join(root, "story.json"));
  assert.notEqual(registeredKey, null);
  const conflicting = registerVaultKey(alias, randomBytes(32));
  try {
    assert.throws(() => registration.addAlias(alias), /already registered/);
  } finally {
    registration.clear();
    conflicting.clear();
  }
  assert.equal(vaultKeyForPath(path.join(alias, "child.json")), null);
  assert.equal(registeredKey!.every((byte) => byte === 0), true);
});

test("only the documented story cleanup marker remains plaintext", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-vault-cleanup-control-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const registration = registerVaultKey(root, randomBytes(32));
  t.after(() => registration.clear());
  const storyMarker = path.join(root, "stories", "story-1", ".1667-cleanup-needed");
  const unrelatedMarker = path.join(root, "other", ".1667-cleanup-needed");
  await mkdir(path.dirname(storyMarker), { recursive: true });
  await mkdir(path.dirname(unrelatedMarker), { recursive: true });

  await writeDurableAtomic(storyMarker, "cleanup pending\n");
  await writeDurableAtomic(unrelatedMarker, "must be sealed\n");

  assert.equal(isSealed(await readFile(storyMarker)), false);
  assert.equal(isSealed(await readFile(unrelatedMarker)), true);
  assert.equal(isVaultControlPath(root, path.relative(root, storyMarker)), true);
  assert.equal(
    isVaultControlPath(root, path.join(
      "stories",
      "story-1",
      ".1667-cleanup-needed.12345678-1234-4123-8123-123456789abc.tmp"
    )),
    true
  );
  assert.equal(isVaultControlPath(root, path.join(
    "other",
    ".1667-cleanup-needed.12345678-1234-4123-8123-123456789abc.tmp"
  )), false);
});

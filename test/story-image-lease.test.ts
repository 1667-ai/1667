import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { registerVaultKey } from "../server/vault-key-registry.js";
import { isSealed } from "../shared/vault-cipher.js";
import { isDraftImageLeaseId } from "../shared/image-attachment.js";
import {
  createDraftImageLeaseId,
  createDraftImageLeaseRecord,
  IMAGE_LEASE_DIRECTORY_NAME,
  imageLeaseDirectoryPath,
  imageLeasePath,
  listDraftImageLeases,
  parseDraftImageLeaseBytes,
  publishDraftImageLease,
  readDraftImageLease,
  removeDraftImageLease,
  serializeDraftImageLease
} from "../server/story-image-lease.js";
import { StoryFormatError } from "../server/story-format-facts.js";

const IMAGE_HASH = "b".repeat(64);

function sampleRecord(leaseId = createDraftImageLeaseId()) {
  return createDraftImageLeaseRecord({
    leaseId,
    attachment: {
      objectId: IMAGE_HASH,
      mediaType: "image/png",
      width: 100,
      height: 50,
      byteLength: 1_234
    },
    createdAt: 1_000,
    expiresAt: 1_000 + 24 * 60 * 60 * 1000
  });
}

async function tempBundle(t: import("node:test").TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-image-lease-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("draft image lease id: exactly 64 lowercase hex characters, 256 random bits", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 32; i += 1) {
    const id = createDraftImageLeaseId();
    assert.ok(isDraftImageLeaseId(id), `expected a valid lease id, got ${id}`);
    assert.match(id, /^[a-f0-9]{64}$/u);
    assert.equal(seen.has(id), false, "two generated ids must not collide across 32 draws");
    seen.add(id);
  }
});

test("draft image lease: canonical round trip and closed key set", () => {
  const record = sampleRecord();
  const raw = serializeDraftImageLease(record);
  assert.deepEqual(parseDraftImageLeaseBytes(Buffer.from(raw, "utf8"), record.leaseId), record);

  const withExtraKey = `${raw.slice(0, -1)},"extra":1}`;
  assert.throws(
    () => parseDraftImageLeaseBytes(Buffer.from(withExtraKey, "utf8")),
    /unknown key/
  );

  const nonCanonical = `${raw.slice(0, -1)}  }`;
  assert.throws(
    () => parseDraftImageLeaseBytes(Buffer.from(nonCanonical, "utf8")),
    StoryFormatError
  );
});

test("draft image lease: the path resolver validates grammar and stays inside image-leases/", async (t) => {
  const dir = await tempBundle(t);
  assert.throws(() => imageLeasePath(dir, "not-a-lease-id"), StoryFormatError);
  assert.throws(() => imageLeasePath(dir, "../../../../etc/passwd"), StoryFormatError);
  assert.throws(() => imageLeasePath(dir, `${"a".repeat(63)}/../${"a".repeat(64)}`), StoryFormatError);
  const leaseId = createDraftImageLeaseId();
  const file = imageLeasePath(dir, leaseId);
  assert.equal(path.dirname(file), imageLeaseDirectoryPath(dir));
  assert.equal(path.basename(file), `${leaseId}.json`);
});

test("draft image lease: publish, read, list, and idempotent remove", async (t) => {
  const dir = await tempBundle(t);
  const record = sampleRecord();
  await publishDraftImageLease(dir, record);

  const read = await readDraftImageLease(dir, record.leaseId);
  assert.deepEqual(read, record);

  const listed = await listDraftImageLeases(dir);
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0], record);

  await removeDraftImageLease(dir, record.leaseId);
  assert.equal(await readDraftImageLease(dir, record.leaseId), null);
  assert.deepEqual(await listDraftImageLeases(dir), []);

  // Releasing an already-absent lease succeeds with no error.
  await removeDraftImageLease(dir, record.leaseId);
});

test("draft image lease: reading an absent lease, and an absent directory, both read as null", async (t) => {
  const dir = await tempBundle(t);
  assert.equal(await readDraftImageLease(dir, createDraftImageLeaseId()), null);
  assert.deepEqual(await listDraftImageLeases(dir), []);
});

test("draft image lease: the lease directory is created with mode 0o700", async (t) => {
  if (process.platform === "win32") return;
  const dir = await tempBundle(t);
  await publishDraftImageLease(dir, sampleRecord());
  const info = await (await import("node:fs/promises")).stat(
    path.join(dir, IMAGE_LEASE_DIRECTORY_NAME)
  );
  assert.equal(info.mode & 0o777, 0o700);
});

test("draft image lease: sealed on disk under a Vault key", async (t) => {
  const dir = await tempBundle(t);
  const registration = registerVaultKey(dir, randomBytes(32));
  t.after(() => registration.clear());
  const record = sampleRecord();
  await publishDraftImageLease(dir, record);
  const onDisk = await readFile(imageLeasePath(dir, record.leaseId));
  assert.ok(isSealed(onDisk), "a Draft Lease under a Vault key must be sealed on disk");
  assert.ok(
    !onDisk.includes(Buffer.from(record.objectId, "utf8")),
    "the object id must not appear in plaintext in the sealed bytes"
  );
  const read = await readDraftImageLease(dir, record.leaseId);
  assert.deepEqual(read, record);
});

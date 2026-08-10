import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StoryStore } from "../server/stories.js";
import { registerVaultKey } from "../server/vault-key-registry.js";
import { isSealed } from "../shared/vault-cipher.js";
import type { NormalizedImage } from "../server/image-normalize.js";

/**
 * The vault sentinel: prove a staged image is sealed on disk, and that its
 * plaintext bytes never appear anywhere in the bundle unsealed, modeled on
 * `test/vault-storage-hooks.integration.test.ts`, which does the same for a
 * mutation-outbox record.
 */

const SENTINEL = "1667 image vault sentinel: violet cartographer";

function sentinelImage(): NormalizedImage {
  // A real Normalized Image is binary and would never literally contain a
  // readable ASCII sentinel by construction, but the property under test is
  // about the STORAGE layer, not image content: whatever bytes go in must
  // never appear anywhere in the bundle except sealed.
  return {
    mediaType: "image/png",
    width: 1,
    height: 1,
    bytes: Buffer.from(`fake-png-body:${SENTINEL}`)
  };
}

test("a staged image is sealed on disk, and the sentinel never appears anywhere in the bundle unsealed", async (t) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "1667-image-vault-sentinel-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const registration = registerVaultKey(dataDirectory, randomBytes(32));
  t.after(() => registration.clear());

  const stories = new StoryStore(dataDirectory);
  await stories.init();
  const story = await stories.create("Vault sentinel story");
  const staged = await stories.stageImage(story.id, sentinelImage());

  // The Image Object itself: sealed on disk, and read back correctly
  // through the ordinary object store (the unseal happens transparently).
  const objectFile = path.join(
    dataDirectory,
    story.id,
    "images",
    staged.attachment.objectId.slice(0, 2),
    `${staged.attachment.objectId}.bin`
  );
  const sealedObject = await readFile(objectFile);
  assert.equal(isSealed(sealedObject), true, "the Image Object must be sealed on disk");
  assert.equal(
    sealedObject.includes(Buffer.from(SENTINEL)),
    false,
    "the sentinel must not appear in plaintext in the sealed object bytes"
  );

  const { StoryObjectStore } = await import("../server/story-objects.js");
  const readBack = await new StoryObjectStore(path.join(dataDirectory, story.id))
    .readImage(staged.attachment.objectId);
  assert.equal(readBack.toString("utf8"), `fake-png-body:${SENTINEL}`);

  // The Draft Lease: sealed too (it is four path segments deep, so it is
  // ordinary sealed bundle content, not a Vault control path).
  const leaseFile = path.join(dataDirectory, story.id, "image-leases", `${staged.leaseId}.json`);
  const sealedLease = await readFile(leaseFile);
  assert.equal(isSealed(sealedLease), true, "the Draft Lease must be sealed on disk");
  assert.equal(sealedLease.includes(Buffer.from(SENTINEL)), false);

  // A recursive scan of the whole bundle: the sentinel appears nowhere
  // unsealed, not only in the two files this test already knows about.
  await assertSentinelNeverUnsealed(path.join(dataDirectory, story.id), SENTINEL);
});

async function assertSentinelNeverUnsealed(root: string, sentinel: string): Promise<void> {
  const needle = Buffer.from(sentinel);
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const bytes = await readFile(file);
    assert.equal(
      bytes.includes(needle),
      false,
      `sentinel leaked in plaintext into ${path.relative(root, file)}`
    );
  }
}

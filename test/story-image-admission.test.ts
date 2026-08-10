import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StoryStore } from "../server/stories.js";
import { readDraftImageLease } from "../server/story-image-lease.js";
import type { NormalizedImage } from "../server/image-normalize.js";

/**
 * Integration coverage for the generation-admission side of Draft Image
 * staging: the durable lease refresh `resolveDraftImage` performs, and the
 * process-local pin `pinImages`/`releaseImagePins` uses to keep a Draft
 * Image readable through a provider round trip even while a concurrent
 * sweep runs. Driven through `StoryStore` the same way
 * test/story-image-cleanup.test.ts drives sweep/cleanup coverage.
 */

async function library(t: import("node:test").TestContext): Promise<{ dir: string; stories: StoryStore }> {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-image-admission-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  return { dir, stories };
}

function image(marker: string): NormalizedImage {
  return { mediaType: "image/png", width: 1, height: 1, bytes: Buffer.from(marker) };
}

function objectPath(dir: string, storyId: string, objectId: string): string {
  return path.join(dir, storyId, "images", objectId.slice(0, 2), `${objectId}.bin`);
}

test("resolveDraftImage refuses an absent or expired lease before any object read", async (t) => {
  const { stories } = await library(t);
  const story = await stories.create("Missing lease");
  await assert.rejects(
    () => stories.resolveDraftImage(story.id, { leaseId: "f".repeat(64), objectId: "a".repeat(64) }),
    (error: unknown) => (error as { code?: string }).code === "image_attachment_expired"
  );
});

test("resolveDraftImage refuses a lease/object mismatch", async (t) => {
  const { stories } = await library(t);
  const story = await stories.create("Mismatched reference");
  const staged = await stories.stageImage(story.id, image("real"));
  await assert.rejects(
    () => stories.resolveDraftImage(story.id, { leaseId: staged.leaseId, objectId: "c".repeat(64) }),
    (error: unknown) => (error as { code?: string }).code === "image_attachment_expired"
  );
});

test("resolveDraftImage durably refreshes the lease to the full lifetime", async (t) => {
  const { dir, stories } = await library(t);
  const story = await stories.create("Refreshed lease");
  const staged = await stories.stageImage(story.id, image("refresh-me"));
  const bundleDir = path.join(dir, story.id);
  const before = await readDraftImageLease(bundleDir, staged.leaseId);
  assert.ok(before !== null);

  const attachment = await stories.resolveDraftImage(story.id, {
    leaseId: staged.leaseId,
    objectId: staged.attachment.objectId
  });
  assert.deepEqual(attachment, staged.attachment);

  const after = await readDraftImageLease(bundleDir, staged.leaseId);
  assert.ok(after !== null);
  assert.equal(after.leaseId, staged.leaseId, "the leaseId a client references must survive the refresh");
  assert.equal(after.objectId, staged.attachment.objectId);
  // Refreshed to a fresh 24-hour window, not merely left with its original
  // expiry: "at generation admission, durably refresh each consumed lease
  // for the full lifetime" (rollout plan).
  assert.ok(
    after.expiresAt > before.expiresAt,
    `refreshed expiry (${after.expiresAt}) must be later than the original (${before.expiresAt})`
  );
  assert.ok(
    after.expiresAt - after.createdAt >= 24 * 60 * 60 * 1000 - 1_000,
    "the refreshed lease must carry the full lease lifetime"
  );
});

test("pinImages keeps a Draft Image readable through a concurrent sweep; releasing lets the sweep reap it", async (t) => {
  const { dir, stories } = await library(t);
  const story = await stories.create("Pinned image");
  const staged = await stories.stageImage(story.id, image("pinned"));
  await stories.releaseImage(story.id, staged.leaseId);
  // No live lease protects the object any more, so an ordinary sweep would
  // reap it unless the process-local pin below keeps it marked live.
  stories.pinImages(story.id, [staged.attachment.objectId]);
  await stories.waitForMaintenance();
  await readFile(objectPath(dir, story.id, staged.attachment.objectId));

  stories.releaseImagePins(story.id, [staged.attachment.objectId]);
  await stories.waitForMaintenance();
  await assert.rejects(() => readFile(objectPath(dir, story.id, staged.attachment.objectId)));
});

test("releaseImagePins and pinImages are no-ops for an empty list", async (t) => {
  const { stories } = await library(t);
  const story = await stories.create("Empty pin calls");
  // Must not throw, and must not schedule cleanup work for a story with
  // nothing to protect or release.
  stories.pinImages(story.id, []);
  stories.releaseImagePins(story.id, []);
});

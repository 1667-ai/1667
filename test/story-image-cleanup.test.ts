import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StoryStore } from "../server/stories.js";
import { cleanupPending } from "../server/story-cleanup.js";
import {
  createDraftImageLeaseId,
  createDraftImageLeaseRecord,
  publishDraftImageLease,
  removeDraftImageLease
} from "../server/story-image-lease.js";
import type { NormalizedImage } from "../server/image-normalize.js";

/**
 * Integration coverage for the sweep/cleanup side of Draft Image staging,
 * driven through `StoryStore` the way `test/story-mutation-cleanup.test.ts`
 * drives revision cleanup: create a story, stage or seed a lease, run
 * maintenance, then inspect the bundle directly.
 */

async function library(t: import("node:test").TestContext): Promise<{ dir: string; stories: StoryStore }> {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-image-cleanup-"));
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

test("image cleanup: a staged image survives maintenance while its Draft Lease is live", async (t) => {
  const { dir, stories } = await library(t);
  const story = await stories.create("Kept image story");
  const staged = await stories.stageImage(story.id, image("kept"));
  await stories.waitForMaintenance();

  await readFile(objectPath(dir, story.id, staged.attachment.objectId));
  // A live lease keeps the marker: a future cleanup pass must still check
  // this bundle once the lease expires.
  assert.equal(await cleanupPending(path.join(dir, story.id)), true);
});

test("image cleanup: releasing the only Draft Lease lets maintenance reap its Image Object and retire the marker", async (t) => {
  const { dir, stories } = await library(t);
  const story = await stories.create("Released image story");
  const staged = await stories.stageImage(story.id, image("released"));
  await stories.releaseImage(story.id, staged.leaseId);
  await stories.waitForMaintenance();

  await assert.rejects(() => readFile(objectPath(dir, story.id, staged.attachment.objectId)));
  assert.equal(await cleanupPending(path.join(dir, story.id)), false);
});

test("image cleanup: an expired Draft Lease no longer protects its Image Object", async (t) => {
  const { dir, stories } = await library(t);
  const story = await stories.create("Expiring image story");
  const staged = await stories.stageImage(story.id, image("expiring"));

  // Publish a fresh lease directly with an already-past expiry, replacing
  // the live one `stageImage` just wrote, so the object is referenced by
  // exactly one lease and that lease is already due for reclaim.
  const bundleDir = path.join(dir, story.id);
  await removeDraftImageLease(bundleDir, staged.leaseId);
  const now = Date.now();
  await publishDraftImageLease(bundleDir, createDraftImageLeaseRecord({
    leaseId: createDraftImageLeaseId(),
    attachment: staged.attachment,
    createdAt: now - 25 * 60 * 60 * 1000,
    expiresAt: now - 60 * 60 * 1000
  }));
  // The maintenance pass `stageImage` scheduled earlier may already have run
  // and gone idle (correctly finding lease A still live and changing
  // nothing) before the direct swap above ever happened. Staging a second
  // image on the same story schedules a fresh pass that is guaranteed to
  // run after the swap, so `waitForMaintenance` below observes the expired
  // lease rather than a stale, already-finished one.
  await stories.stageImage(story.id, image("keeps-marker-pending"));
  await stories.waitForMaintenance();

  await assert.rejects(() => readFile(objectPath(dir, story.id, staged.attachment.objectId)));
});

test("image cleanup: two stories keep their own images independent of each other", async (t) => {
  const { dir, stories } = await library(t);
  const first = await stories.create("First story");
  const second = await stories.create("Second story");
  const stagedFirst = await stories.stageImage(first.id, image("first"));
  const stagedSecond = await stories.stageImage(second.id, image("second"));
  await stories.releaseImage(first.id, stagedFirst.leaseId);
  await stories.waitForMaintenance();

  await assert.rejects(() => readFile(objectPath(dir, first.id, stagedFirst.attachment.objectId)));
  await readFile(objectPath(dir, second.id, stagedSecond.attachment.objectId));
});

test("image cleanup: releasing a malformed lease id is a client error, not an internal one", async (t) => {
  const { stories } = await library(t);
  const story = await stories.create("Malformed lease id story");

  await assert.rejects(
    () => stories.releaseImage(story.id, "not-a-lease-id"),
    (error: unknown) => (error as { status?: number; code?: string }).status === 400
      && (error as { code?: string }).code === "invalid_request"
  );
  await assert.rejects(
    () => stories.releaseImage(story.id, "../../../../etc/passwd"),
    (error: unknown) => (error as { status?: number }).status === 400
  );
});

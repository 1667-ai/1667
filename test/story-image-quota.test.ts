import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StoryStore } from "../server/stories.js";
import {
  createDraftImageLeaseId,
  createDraftImageLeaseRecord,
  publishDraftImageLease
} from "../server/story-image-lease.js";
import {
  MAX_PROJECT_DRAFT_IMAGE_LEASES,
  MAX_STORY_DRAFT_IMAGE_LEASES
} from "../shared/image-attachment.js";
import type { StoryImageAttachment } from "../shared/image-attachment.js";
import type { NormalizedImage } from "../server/image-normalize.js";

/**
 * These drive `StoryStore.stageImage` directly with an already-"normalized"
 * image (small, synthetic bytes) rather than through the real normalizer
 * child, the same way `test/story-image-objects.test.ts` drives
 * `StoryObjectStore` directly: the normalizer has its own dedicated test
 * coverage, and a quota boundary needs many staged leases, which a real
 * child-process spawn per lease would make slow without adding coverage.
 */

interface TestLibrary {
  readonly dir: string;
  readonly stories: StoryStore;
}

async function tempLibrary(t: import("node:test").TestContext): Promise<TestLibrary> {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-image-quota-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  return { dir, stories };
}

function image(index: number): NormalizedImage {
  return {
    mediaType: "image/png",
    width: 1,
    height: 1,
    bytes: Buffer.from(`synthetic normalized image bytes #${index}`)
  };
}

/** Seed a bare story directory with one Draft Lease that references no real
 *  Image Object. Quota accounting reads lease records only, it never opens
 *  the object a lease names, so this is enough to make `catalogStoryIds`
 *  and `listDraftImageLeases` count it without paying for a full story or a
 *  real staged image. */
async function seedForeignLease(
  libraryDir: string,
  storyId: string,
  byteLength: number
): Promise<void> {
  await seedSharedForeignLease(libraryDir, storyId, sha256Like(storyId), byteLength);
}

/** Like `seedForeignLease`, but the caller names the object id directly, so
 *  several seeded leases across several stories can name the exact same
 *  Image Object, the shape "unique draft image bytes" accounting needs to
 *  be observable at all. */
async function seedSharedForeignLease(
  libraryDir: string,
  storyId: string,
  objectId: string,
  byteLength: number
): Promise<void> {
  const bundleDir = path.join(libraryDir, storyId);
  await mkdir(bundleDir, { mode: 0o700 });
  const now = Date.now();
  const attachment: StoryImageAttachment = {
    objectId,
    mediaType: "image/png",
    width: 1,
    height: 1,
    byteLength
  };
  const record = createDraftImageLeaseRecord({
    leaseId: createDraftImageLeaseId(),
    attachment,
    createdAt: now,
    expiresAt: now + 24 * 60 * 60 * 1000
  });
  await publishDraftImageLease(bundleDir, record);
}

function sha256Like(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

test("story image quota: exactly 8 live leases per story is allowed, a 9th is refused", async (t) => {
  const { stories } = await tempLibrary(t);
  const story = await stories.create("Quota story");
  for (let i = 0; i < MAX_STORY_DRAFT_IMAGE_LEASES; i += 1) {
    const staged = await stories.stageImage(story.id, image(i));
    assert.ok(staged.leaseId.length === 64);
  }
  await assert.rejects(
    () => stories.stageImage(story.id, image(MAX_STORY_DRAFT_IMAGE_LEASES)),
    (error: unknown) => (error as { code?: string }).code === "image_draft_quota_exceeded"
  );
});

test("story image quota: releasing a lease frees room for another", async (t) => {
  const { stories } = await tempLibrary(t);
  const story = await stories.create("Quota release story");
  const leaseIds: string[] = [];
  for (let i = 0; i < MAX_STORY_DRAFT_IMAGE_LEASES; i += 1) {
    leaseIds.push((await stories.stageImage(story.id, image(i))).leaseId);
  }
  await assert.rejects(() => stories.stageImage(story.id, image(99)));
  await stories.releaseImage(story.id, leaseIds[0]!);
  const staged = await stories.stageImage(story.id, image(100));
  assert.ok(staged.leaseId.length === 64);
});

test("story image quota: 63 leases elsewhere in the project leave room for one more, 64 do not", async (t) => {
  const { dir, stories } = await tempLibrary(t);
  const story = await stories.create("Project quota story");
  for (let i = 0; i < MAX_PROJECT_DRAFT_IMAGE_LEASES - 1; i += 1) {
    await seedForeignLease(dir, `foreign-story-${i}`, 1_024);
  }
  // 63 elsewhere + 1 new = 64, at the limit, not over it.
  const staged = await stories.stageImage(story.id, image(0));
  assert.ok(staged.leaseId.length === 64);
  await stories.releaseImage(story.id, staged.leaseId);

  await seedForeignLease(dir, "foreign-story-last", 1_024);
  // 64 elsewhere + 1 new = 65, over the limit.
  await assert.rejects(
    () => stories.stageImage(story.id, image(1)),
    (error: unknown) => (error as { code?: string }).code === "image_draft_quota_exceeded"
  );
});

// The story (40 MiB) and project (256 MiB) BYTE quotas cannot actually bind
// given the other numbers this same design fixes: one Image Object is
// capped at MAX_IMAGE_OBJECT_BYTES (≈3.75 MiB), and the LEASE-COUNT quotas
// (8 per story, 64 per project) already cap total bytes at ≈30 MiB and
// ≈240 MiB respectively, both under their own byte ceiling. A lease's
// recorded byteLength is re-validated against MAX_IMAGE_OBJECT_BYTES on
// every read (`createStoryImageAttachment`, inside
// `parseDraftImageLeaseBytes`), so no on-disk lease can carry a larger
// number either. The byte quotas stay implemented exactly as specified,
// they are a real, correct ceiling, but no valid combination of leases can
// reach them today. This test instead proves the accounting itself: many
// leases that name the SAME Image Object count its bytes once, not once per
// lease, exactly as "unique draft image bytes" requires.
test("story image quota: leases naming the same object id count its bytes once, not once per lease", async (t) => {
  const { dir, stories } = await tempLibrary(t);
  const story = await stories.create("Shared object quota story");
  const sharedObjectId = sha256Like("shared-object");
  // 60 foreign leases all naming the same object: deduped, this project
  // holds one object's worth of unique bytes; summed naively, 60 times
  // MAX_IMAGE_OBJECT_BYTES would be far over the 256 MiB cap.
  for (let i = 0; i < 60; i += 1) {
    await seedSharedForeignLease(dir, `foreign-shared-${i}`, sharedObjectId, 3_000_000);
  }
  const staged = await stories.stageImage(story.id, image(0));
  assert.ok(staged.leaseId.length === 64);
});

test("story image quota: an expired lease is excluded and removed before the next check", async (t) => {
  const { dir, stories } = await tempLibrary(t);
  const story = await stories.create("Expiry quota story");
  const bundleDir = path.join(dir, story.id);
  const now = Date.now();
  for (let i = 0; i < MAX_STORY_DRAFT_IMAGE_LEASES; i += 1) {
    const attachment: StoryImageAttachment = {
      objectId: sha256Like(`expired-${i}`),
      mediaType: "image/png",
      width: 1,
      height: 1,
      byteLength: 512
    };
    await publishDraftImageLease(bundleDir, createDraftImageLeaseRecord({
      leaseId: createDraftImageLeaseId(),
      attachment,
      createdAt: now - 25 * 60 * 60 * 1000,
      expiresAt: now - 60 * 60 * 1000 // already expired
    }));
  }
  // Every existing lease is expired, so the story is effectively empty.
  const staged = await stories.stageImage(story.id, image(0));
  assert.ok(staged.leaseId.length === 64);
});

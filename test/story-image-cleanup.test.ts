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
import { StoryObjectStore } from "../server/story-objects.js";
import { parseStoryManifestBytes, STORY_SCHEMA_VERSION_V8 } from "../server/story-v6-codec.js";
import type { NormalizedImage } from "../server/image-normalize.js";
import type { StoryImageAttachment } from "../shared/image-attachment.js";
import {
  providerOperation,
  request,
  setup,
  storyFixture,
  STORY_ID
} from "./story-mutation-fixtures.js";

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

function seedAttachment(objectId: string): StoryImageAttachment {
  return { objectId, mediaType: "image/png", width: 1, height: 1, byteLength: 17 };
}

test("image cleanup: a Draft Lease on a successor-schema (v8) story is swept exactly like on an ordinary story", async (t) => {
  // Regression coverage for the sweep going dead on a successor story:
  // `requireStageableStory` (server/story-draft-images.ts) deliberately
  // admits a v8-live story, but before the fix `runCleanup`'s slot-content
  // lookup fell through to `null` for "v8-live", so it returned before ever
  // calling the sweep. The Image Object and the cleanup marker both stayed
  // forever, and every later `load()` scheduled a pass that did nothing.
  const fixture = await setup(
    t,
    "1667-image-cleanup-successor-",
    {},
    undefined,
    { imageInputActivation: true }
  );
  const storiesDir = path.join(fixture.dataDir, "stories");

  // Commit a take carrying an Image Attachment first: that is what moves a
  // story from a V6 to a V8 envelope
  // (test/story-aggregate-successor-write.test.ts).
  const seedObjects = new StoryObjectStore(path.join(storiesDir, STORY_ID));
  await seedObjects.init();
  const seedObjectId = await seedObjects.storeImage(Buffer.from("seed image bytes"));
  await seedObjects.flush();

  await fixture.mutations.runProviderOperation(
    request(fixture.v5Hash),
    "continueStory",
    providerOperation(
      async (stories, providerStarted) => {
        await providerStarted();
        return await stories.commitProviderEffect(STORY_ID, {
          kind: "continue",
          parentId: null,
          appendTo: null,
          expectedTextHash: null,
          instruction: "Describe the image.",
          text: "A lantern-lit room.",
          model: "test",
          genId: "g-seed",
          expectedParentActiveChildId: null,
          expectedAppendActiveChildId: null,
          expectedActiveRootId: null,
          expectedActiveLeafId: null,
          imageAttachments: [seedAttachment(seedObjectId)]
        });
      },
      storyFixture
    )
  );

  const afterSeed = await readFile(fixture.manifestFile);
  const parsedSeed = parseStoryManifestBytes(afterSeed, STORY_ID);
  assert.equal(parsedSeed.kind, "v8-live", "the seed commit really did move the story to the successor envelope");
  if (parsedSeed.kind !== "v8-live") return;
  assert.equal(parsedSeed.manifest.schemaVersion, STORY_SCHEMA_VERSION_V8);

  // Stage a fresh Draft Image the same way any story accepts one.
  const staged = await fixture.stories.stageImage(STORY_ID, image("draft-on-v8"));
  await fixture.stories.waitForMaintenance();
  await readFile(objectPath(storiesDir, STORY_ID, staged.attachment.objectId));
  assert.equal(
    await cleanupPending(path.join(storiesDir, STORY_ID)),
    true,
    "a live Draft Lease keeps the marker set on a successor-schema story too"
  );

  await fixture.stories.releaseImage(STORY_ID, staged.leaseId);
  await fixture.stories.waitForMaintenance();
  await assert.rejects(() => readFile(objectPath(storiesDir, STORY_ID, staged.attachment.objectId)));
  assert.equal(
    await cleanupPending(path.join(storiesDir, STORY_ID)),
    false,
    "the sweep actually ran and retired the marker: it is no longer dead for v8-live"
  );
});

import assert from "node:assert/strict";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createGenerationRecord } from "../shared/generation-record.js";
import { StoryCleanupIntent, cleanupPending } from "../server/story-cleanup.js";
import { StoryObjectStore } from "../server/story-objects.js";
import { StoryStore } from "../server/stories.js";

test("story cleanup keeps staged Generation Record objects until transaction recovery", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-generation-record-staged-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stories = new StoryStore(root);
  await stories.init();
  const story = await stories.create("Staged record");
  const bundle = path.join(root, story.id);
  await stories.withAggregateSession(story.id, async () => undefined);
  const objects = new StoryObjectStore(bundle);
  const recordId = await objects.storeGenerationRecord(createGenerationRecord({
    kind: "continue",
    createdAt: "2026-08-10T00:00:00.000Z",
    provider: { provider: "dry-run", model: "dry-run" },
    effective: { wireProtocol: "dry-run", fields: [], adjustments: [] },
    prompt: { operation: "continue", entries: [] }
  }));
  await objects.flush();

  const staged = path.join(bundle, "manifest.json.next");
  await stories.withAggregateSession(story.id, async (session) => {
    await session.stageManifest(session.snapshot.manifest);
  });
  await (await StoryCleanupIntent.begin(bundle, story.id)).publish();

  await stories.schedulePendingCleanup(story.id);
  await stories.waitForMaintenance();
  assert.equal((await objects.readGenerationRecord(recordId)).kind, "continue");
  assert.equal(await cleanupPending(bundle), true);

  await unlink(staged);
  await stories.schedulePendingCleanup(story.id);
  await stories.waitForMaintenance();
  await assert.rejects(
    objects.readGenerationRecord(recordId),
    /Missing generation-records object/
  );
  assert.equal(await cleanupPending(bundle), false);
});

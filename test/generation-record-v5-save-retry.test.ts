import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StoryStore } from "../server/stories.js";
import { appendPendingGenerationRecord } from "../server/story-node-generation-records.js";
import { StoryObjectStore } from "../server/story-objects.js";
import { createGenerationRecord } from "../shared/generation-record.js";
import type { Story, StoryNode } from "../shared/types.js";

const NOW = "2026-08-10T00:00:00.000Z";

/**
 * `StoryStore.save`'s update path for a story that already has a published V5
 * bundle (see `saveUnlocked`'s `slot.kind === "v5"` branch, distinct from
 * `publishNewBundle`'s first-ever save) also drains a node's pending
 * Generation Record the moment `encodeStoryBundle` stores its bytes — into
 * this story's *live* bundle directory this time, not a revocable staging
 * one. A failure between that drain and the manifest write that makes the
 * new object reachable used to leave the pending queue empty forever: the
 * catch only scheduled cleanup, which can reap the now-unreferenced object
 * (reproduced below via `waitForMaintenance`), so a same-Story retry
 * referenced a Generation Record id whose bytes were gone, and could never
 * pass graph verification again. See story-node-generation-records.ts.
 */
test("a failure after Generation Record staging during a V5 update save leaves the record queued for a same-story retry", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-gr-v5-save-retry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();

  const node = baseNode(randomUUID(), null, "Opening.");
  const story = runtimeStory(node);

  // Install the flush mock before the first save below, so its flush call is
  // the one counted as #1. Installing it after (as a prior version of this
  // test did) leaves that first flush uncounted, so the update save's own
  // flush becomes #1 instead of #2 and the fault below never fires.
  const originalFlush = StoryObjectStore.prototype.flush;
  let flushCalls = 0;
  t.mock.method(
    StoryObjectStore.prototype,
    "flush",
    async function (this: StoryObjectStore) {
      flushCalls += 1;
      // The first save's `publishNewBundle` call below is flush #1; fail only
      // the update save's flush (#2), after encodeStoryBundle has stored the
      // Generation Record's bytes into the live bundle directory but before
      // verifyGraph or the manifest write that would make it reachable.
      if (flushCalls === 2) throw new Error("simulated post-staging update flush failure");
      return await originalFlush.call(this);
    }
  );

  // First save has no pending Generation Records: it publishes a plain V5
  // bundle via `publishNewBundle` (flush call #1), giving the update path
  // below something to update.
  await stories.save(story);

  const record = createGenerationRecord({
    kind: "continue",
    createdAt: NOW,
    provider: { provider: "dry-run", model: "dry-run" },
    effective: { wireProtocol: "dry-run", fields: [], adjustments: [] },
    prompt: { operation: "continue", entries: [] }
  });
  const hash = appendPendingGenerationRecord(node, record);

  await assert.rejects(stories.save(story), /simulated post-staging update flush failure/);
  assert.equal(flushCalls, 2);

  // Let scheduled cleanup actually reap the orphaned object the failed save
  // left in the live bundle directory, unreferenced by the still-current
  // (old) manifest — the exact condition the fix must survive.
  await stories.waitForMaintenance();

  // Retrying the same Story object must succeed and actually write the
  // record's bytes again — cleanup already removed the first attempt's copy.
  await stories.save(story);
  assert.equal(flushCalls, 3);

  const resolved = await stories.loadGenerationRecord(story.id, node.id, hash);
  assert.equal(resolved.kind, "continue");
});

function baseNode(id: string, parentId: string | null, text: string): StoryNode {
  return { id, parentId, instruction: "Continue", text, model: "test", createdAt: NOW, activeChildId: null };
}

function runtimeStory(node: StoryNode): Story {
  return {
    id: randomUUID(), title: "Runtime", createdAt: NOW, updatedAt: NOW,
    nodes: [node], activeRootId: node.id, tags: [], recentNodeIds: [], facts: [], chapterBreaks: []
  };
}

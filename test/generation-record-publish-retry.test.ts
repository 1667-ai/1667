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
 * `StoryStore.save`'s first-ever save of a story (nothing on disk yet, or a
 * legacy v1 file to migrate) goes through `publishNewBundle`: it encodes into
 * a staging directory, then publishes by renaming that directory into place.
 * `encodeStoryBundle` drains a node's pending Generation Record the moment
 * its bytes settle in that *staging* store — before the rename that actually
 * makes staging durable at the story's real path. A failure between those
 * two points used to delete the whole staging directory (see
 * `publishNewBundle`'s catch) while the pending queue had already been
 * cleared, so a same-Story retry would encode a manifest that referenced the
 * id without ever writing its bytes again. See story-node-generation-records.ts.
 */
test("a failure after Generation Record staging during new-bundle publication leaves the record queued for a same-story retry", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-gr-publish-retry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();

  const node = baseNode(randomUUID(), null, "Opening.");
  const record = generationRecord("continue");
  const hash = appendPendingGenerationRecord(node, record);
  const story = runtimeStory(node);

  const originalFlush = StoryObjectStore.prototype.flush;
  let flushCalls = 0;
  t.mock.method(
    StoryObjectStore.prototype,
    "flush",
    async function (this: StoryObjectStore) {
      flushCalls += 1;
      // Fails only the first attempt, after encodeStoryBundle has already
      // staged the Generation Record's bytes (storeGenerationRecord settled)
      // but before the staging directory is published.
      if (flushCalls === 1) throw new Error("simulated post-staging flush failure");
      return await originalFlush.call(this);
    }
  );

  await assert.rejects(stories.save(story), /simulated post-staging flush failure/);
  assert.equal(flushCalls, 1);

  // Retrying the same Story object must succeed and actually write the
  // record's bytes again — the first attempt's staging directory (and the
  // object it briefly held) is gone.
  await stories.save(story);
  assert.equal(flushCalls, 2);

  const resolved = await stories.loadGenerationRecord(story.id, node.id, hash);
  assert.equal(resolved.kind, "continue");
});

function generationRecord(kind: "continue" | "rewrite-take", range?: { start: number; end: number }) {
  return createGenerationRecord({
    kind,
    createdAt: NOW,
    ...(range === undefined ? {} : { range }),
    provider: { provider: "dry-run", model: "dry-run" },
    effective: { wireProtocol: "dry-run", fields: [], adjustments: [] },
    prompt: { operation: kind === "continue" ? "continue" : "rewrite", entries: [] }
  });
}

function baseNode(id: string, parentId: string | null, text: string): StoryNode {
  return { id, parentId, instruction: "Continue", text, model: "test", createdAt: NOW, activeChildId: null };
}

function runtimeStory(node: StoryNode): Story {
  return {
    id: randomUUID(), title: "Runtime", createdAt: NOW, updatedAt: NOW,
    nodes: [node], activeRootId: node.id, tags: [], recentNodeIds: [], facts: [], chapterBreaks: []
  };
}

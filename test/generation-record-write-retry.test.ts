import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { encodeStoryBundle } from "../server/story-codec.js";
import { appendPendingGenerationRecord } from "../server/story-node-generation-records.js";
import { StoryObjectStore } from "../server/story-objects.js";
import { createGenerationRecord } from "../shared/generation-record.js";
import type { Story, StoryNode } from "../shared/types.js";

const NOW = "2026-08-10T00:00:00.000Z";

/** Fails the first `failCount` `storeGenerationRecord` calls (across the
 *  whole store, not per node) with a transient error, then behaves exactly
 *  like the base class — simulating a write that fails partway through an
 *  encode and would succeed on a plain retry. */
class FlakyObjectStore extends StoryObjectStore {
  calls = 0;
  private failuresLeft: number;

  constructor(dir: string, failCount: number) {
    super(dir);
    this.failuresLeft = failCount;
  }

  override async storeGenerationRecord(
    ...args: Parameters<StoryObjectStore["storeGenerationRecord"]>
  ): ReturnType<StoryObjectStore["storeGenerationRecord"]> {
    this.calls += 1;
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new Error("simulated transient object store write failure");
    }
    return super.storeGenerationRecord(...args);
  }
}

test("a first-write failure leaves the pending record queued for a same-Story retry", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-gr-retry-first-write-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const node = baseNode("root", null, "Opening.");
  const story = runtimeStory([node]);
  const record = generationRecord("continue");
  const hash = appendPendingGenerationRecord(node, record);
  assert.deepEqual(node.generationRecordIds, [hash]);

  const objects = new FlakyObjectStore(dir, 1);
  await assert.rejects(
    encodeStoryBundle(story, objects),
    /simulated transient object store write failure/
  );
  assert.equal(objects.calls, 1);

  // Retrying the encode with the same Story object (and the same node, whose
  // in-memory queue must still hold the record) must succeed and store it.
  const manifest = await encodeStoryBundle(story, objects);
  assert.equal(objects.calls, 2);
  assert.deepEqual(manifest.nodes[0]!.generationRecordIds, [hash]);
  const stored = await objects.readGenerationRecord(hash);
  assert.equal(stored.kind, "continue");

  // A later, unrelated encode of the same Story object must not re-send an
  // already-settled write.
  await encodeStoryBundle(story, objects);
  assert.equal(objects.calls, 2);
});

test("a partial multi-record failure retries only the unwritten record, never the settled one", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-gr-retry-partial-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const node = baseNode("root", null, "Opening.");
  const story = runtimeStory([node]);
  const firstRecord = generationRecord("continue");
  const secondRecord = generationRecord("rewrite-take", { start: 0, end: 8 });
  const firstHash = appendPendingGenerationRecord(node, firstRecord);
  const secondHash = appendPendingGenerationRecord(node, secondRecord);
  assert.notEqual(firstHash, secondHash);
  assert.deepEqual(node.generationRecordIds, [firstHash, secondHash]);

  // The first record's write succeeds; the second (still in the same
  // commit's queue) fails transiently.
  const objects = new FlakyObjectStoreAt(dir, 2);
  await assert.rejects(
    encodeStoryBundle(story, objects),
    /simulated transient object store write failure/
  );
  assert.equal(objects.calls, 2);
  assert.deepEqual(objects.sentHashes, [firstHash]);

  // Retrying must resend only the still-unwritten second record, not the
  // already-settled first one.
  const manifest = await encodeStoryBundle(story, objects);
  assert.equal(objects.calls, 3);
  assert.deepEqual(objects.sentHashes, [firstHash, secondHash]);
  assert.deepEqual(manifest.nodes[0]!.generationRecordIds, [firstHash, secondHash]);

  const storedFirst = await objects.readGenerationRecord(firstHash);
  const storedSecond = await objects.readGenerationRecord(secondHash);
  assert.equal(storedFirst.kind, "continue");
  assert.equal(storedSecond.kind, "rewrite-take");

  // Story graph verification must still see both hashes as live and readable.
  await objects.verifyGraph({
    revisions: manifest.nodes.map((stored) => stored.revisionId),
    probabilities: [],
    generationRecords: [firstHash, secondHash]
  });
});

/** Fails whichever `storeGenerationRecord` call index is 1-based `failAt`,
 *  and records every hash actually sent — used to assert a retry never
 *  resends a record whose write already settled. */
class FlakyObjectStoreAt extends StoryObjectStore {
  calls = 0;
  sentHashes: string[] = [];
  private readonly failAt: number;

  constructor(dir: string, failAt: number) {
    super(dir);
    this.failAt = failAt;
  }

  override async storeGenerationRecord(
    ...args: Parameters<StoryObjectStore["storeGenerationRecord"]>
  ): ReturnType<StoryObjectStore["storeGenerationRecord"]> {
    this.calls += 1;
    if (this.calls === this.failAt) {
      throw new Error("simulated transient object store write failure");
    }
    const hash = await super.storeGenerationRecord(...args);
    this.sentHashes.push(hash);
    return hash;
  }
}

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

function runtimeStory(nodes: StoryNode[]): Story {
  return {
    id: "runtime", title: "Runtime", createdAt: NOW, updatedAt: NOW,
    nodes, activeRootId: nodes[0]?.id ?? null, tags: [], recentNodeIds: [], facts: [], chapterBreaks: []
  };
}

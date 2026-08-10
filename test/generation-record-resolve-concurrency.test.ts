import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveGenerationRecord } from "../server/generation-record-resolve.js";
import { StoryObjectStore, createStoryReadCache, type StoryReadCache } from "../server/story-objects.js";
import { type ObjectHash } from "../server/story-format.js";
import {
  GENERATION_RECORD_FORMAT,
  GENERATION_RECORD_SCHEMA_VERSION,
  type GenerationRecord,
  type GenerationRecordSourcePart
} from "../shared/generation-record.js";

/**
 * Regression for a source entry's parts being resolved with a plain,
 * unbounded `Promise.all` — an entry can carry up to 8,192 parts (see
 * `MAX_GENERATION_RECORD_SOURCE_PARTS`), so resolving one could open
 * thousands of file descriptors at once. Proves the fix by observing
 * `StoryObjectStore.readText`'s real concurrent-call count during a
 * resolve, rather than asserting anything about how the fix is implemented.
 */
test("resolving a Generation Record's source parts bounds concurrent revision reads", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-resolve-concurrency-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const objects = new StoryObjectStore(dir);
  await objects.init();

  const PART_COUNT = 20;
  const texts = Array.from({ length: PART_COUNT }, (_, index) => `part-${index}-${"x".repeat(64)}`);
  const revisionIds = await Promise.all(texts.map((text) => objects.storeText(text)));

  const parts: GenerationRecordSourcePart[] = revisionIds.map((revisionId, index) => ({
    nodeId: `node-${index}`,
    category: "recent",
    instruction: "",
    revisionId,
    textLength: texts[index]!.length
  }));

  const record: GenerationRecord = {
    format: GENERATION_RECORD_FORMAT,
    schemaVersion: GENERATION_RECORD_SCHEMA_VERSION,
    kind: "continue",
    createdAt: "2026-01-01T00:00:00.000Z",
    provider: { provider: "dry-run", model: "concurrency-fixture" },
    effective: { wireProtocol: "dry-run", fields: [], adjustments: [] },
    prompt: {
      operation: "continue",
      entries: [{ stability: "stable", kind: "source", source: "revisions", parts }]
    }
  };

  let active = 0;
  let maxActive = 0;
  let totalCalls = 0;
  const originalReadText = StoryObjectStore.prototype.readText;
  t.mock.method(
    StoryObjectStore.prototype,
    "readText",
    async function (this: StoryObjectStore, hash: ObjectHash, cache?: StoryReadCache) {
      totalCalls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      // Holds each call open long enough for the next-in-line calls to start,
      // so a sustained (not just initial-burst) concurrency ceiling is observable.
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await originalReadText.call(this, hash, cache ?? createStoryReadCache());
      } finally {
        active -= 1;
      }
    }
  );

  const resolved = await resolveGenerationRecord(record, objects);

  assert.equal(totalCalls, PART_COUNT, "every source part must still be resolved, none skipped");
  assert.ok(maxActive > 1, `expected observable overlap between reads, got a peak of ${maxActive}`);
  assert.ok(maxActive <= 4, `expected concurrent revision reads to stay bounded, got a peak of ${maxActive}`);

  const resolvedEntry = resolved.prompt.entries[0];
  if (resolvedEntry === undefined || resolvedEntry.source !== "revisions") {
    throw new Error("expected a resolved source entry");
  }
  assert.deepEqual(
    resolvedEntry.parts.map((part) => part.text),
    texts,
    "resolved parts must preserve exact input order"
  );
  assert.deepEqual(
    resolvedEntry.parts.map((part) => part.nodeId),
    parts.map((part) => part.nodeId)
  );
});

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import type { StoryManifestV5 } from "../server/story-format.js";
import { reduceStoryV6 } from "../server/story-v6-reducer.js";
import type { LiveStoryManifestV6, StorySummaryV6 } from "../server/story-v6-types.js";

const HASH = "a".repeat(64);
const MUTATION_ID = "m1.1767225600000.00000000000000000000000000000001";
const NOW = "2026-01-01T00:00:00.000Z";

test("story V6 reducer performance: transitions do not clone or scan large content", () => {
  const giantInstruction = "x".repeat(12 * 1024 * 1024);
  const content = storyContent(giantInstruction);
  const summary = storySummary();
  const input = live(content, summary);

  const started = performance.now();
  const output = reduceStoryV6({ kind: "present", manifest: input, manifestHash: HASH }, {
    kind: "local-prepared",
    expectedManifestHash: HASH,
    mutationId: MUTATION_ID,
    content,
    summary
  });
  const elapsed = performance.now() - started;

  assert.ok(output?.kind === "live");
  assert.strictEqual(output.content, content);
  assert.strictEqual(output.content.nodes[0]!.instruction, giantInstruction);
  assert.ok(elapsed < 250, `large immutable transition took ${elapsed.toFixed(1)}ms`);
});

test("story V6 reducer performance: many small transitions stay inexpensive", () => {
  const content = storyContent("small");
  const summary = storySummary();
  let manifest = live(content, summary);
  const started = performance.now();
  for (let index = 0; index < 50_000; index += 1) {
    const output = reduceStoryV6({ kind: "present", manifest, manifestHash: HASH }, {
      kind: "local-prepared",
      expectedManifestHash: HASH,
      mutationId: MUTATION_ID,
      content,
      summary
    });
    if (output === null || output.kind !== "live") assert.fail("Expected live output");
    manifest = output;
  }
  const elapsed = performance.now() - started;

  assert.equal(manifest.revision, "00000000000000050001");
  assert.ok(elapsed < 2_000, `50,000 reducer transitions took ${elapsed.toFixed(1)}ms`);
});

function storyContent(instruction: string): StoryManifestV5 {
  return {
    format: "1667-story",
    schemaVersion: 5,
    id: "performance-story",
    title: "Performance",
    createdAt: NOW,
    updatedAt: NOW,
    activeWordCount: 0,
    nodes: [{
      id: "root",
      parentId: null,
      instruction,
      model: "test",
      createdAt: NOW,
      revisionId: HASH,
      activeChildId: null
    }],
    facts: [],
    activeRootId: "root",
    bookmarks: [],
    recentNodeIds: [],
    chapterBreaks: []
  };
}

function storySummary(): StorySummaryV6 {
  return {
    id: "performance-story",
    title: "Performance",
    updatedAt: NOW,
    partCount: 1,
    words: "00000000000000000000",
    forked: false,
    lineCount: "00000000000000000001"
  };
}

function live(content: StoryManifestV5, summary: StorySummaryV6): LiveStoryManifestV6 {
  return {
    format: "1667-story",
    schemaVersion: 6,
    kind: "live",
    id: content.id,
    revision: "00000000000000000001",
    previousManifestHash: null,
    content,
    summary,
    unresolvedProvider: null,
    lastTransaction: null
  };
}

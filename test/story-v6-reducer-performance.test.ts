import assert from "node:assert/strict";
import test from "node:test";
import { assertWithinBudget, cpuBudget, startTiming } from "./performance-budget.js";
import type { StoryManifestV5 } from "../server/story-format.js";
import { reduceStoryV6 } from "../server/story-v6-reducer.js";
import type { LiveStoryManifestV6, StorySummaryV6 } from "../server/story-v6-types.js";

const HASH = "a".repeat(64);
const MUTATION_ID = "m1.1767225600000.00000000000000000000000000000001";
const NOW = "2026-01-01T00:00:00.000Z";
const LARGE_TRANSITION_BUDGET = cpuBudget(250);
const MANY_TRANSITIONS_BUDGET = cpuBudget(2_000);

test("story V6 reducer performance: transitions do not clone or scan large content", (context) => {
  const giantInstruction = "x".repeat(12 * 1024 * 1024);
  const content = storyContent(giantInstruction);
  const summary = storySummary();
  const input = live(content, summary);

  const read = startTiming();
  const output = reduceStoryV6({ kind: "present", manifest: input, manifestHash: HASH }, {
    kind: "local-prepared",
    expectedManifestHash: HASH,
    mutationId: MUTATION_ID,
    content,
    summary
  });
  const timing = read();

  assert.ok(output?.kind === "live");
  assert.strictEqual(output.content, content);
  assert.strictEqual(output.content.nodes[0]!.instruction, giantInstruction);
  assertWithinBudget(context, "large immutable transition", LARGE_TRANSITION_BUDGET, timing);
});

test("story V6 reducer performance: many small transitions stay inexpensive", (context) => {
  const content = storyContent("small");
  const summary = storySummary();
  let manifest = live(content, summary);
  const read = startTiming();
  for (let index = 0; index < 50_000; index += 1) {
    const output = reduceStoryV6({ kind: "present", manifest, manifestHash: HASH }, {
      kind: "local-prepared",
      expectedManifestHash: HASH,
      mutationId: MUTATION_ID,
      content,
      summary
    });
    if (output === null || output.kind !== "live") assert.fail("Expected live output");
    // This test only ever feeds V5 content, so the reducer's general
    // V6-or-V8 return type is always V6 here; check it explicitly rather
    // than casting.
    if (output.schemaVersion !== 6) assert.fail("Expected a V6 manifest");
    manifest = output;
  }
  const timing = read();

  assert.equal(manifest.revision, "00000000000000050001");
  assertWithinBudget(context, "50,000 reducer transitions", MANY_TRANSITIONS_BUDGET, timing);
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

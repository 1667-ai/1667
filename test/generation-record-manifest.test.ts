import assert from "node:assert/strict";
import test from "node:test";
import { parseManifest, serializeManifest } from "../server/story-format.js";

const NOW = "2026-01-01T00:00:00.000Z";
const HASH = "a".repeat(64);

test("a V5 manifest without generationRecordIds round-trips byte-for-byte", () => {
  const manifest = makeManifest(false);
  const raw = `${JSON.stringify(manifest, null, 2)}\n`;
  const parsed = parseManifest(raw, "story-one");

  assert.equal("generationRecordIds" in parsed.nodes[0]!, false);
  assert.equal(serializeManifest(parsed), raw);
});

test("a V5 manifest with generationRecordIds round-trips byte-for-byte", () => {
  const manifest = makeManifest(true);
  const raw = `${JSON.stringify(manifest, null, 2)}\n`;
  const parsed = parseManifest(raw, "story-one");

  assert.deepEqual(parsed.nodes[0]!.generationRecordIds, [HASH]);
  assert.equal(serializeManifest(parsed), raw);
});

function makeManifest(withGenerationRecords: boolean) {
  return {
    format: "1667-story",
    schemaVersion: 5,
    id: "story-one",
    title: "Story",
    createdAt: NOW,
    updatedAt: NOW,
    activeWordCount: 0,
    nodes: [{
      id: "root",
      parentId: null,
      instruction: "",
      model: "test",
      createdAt: NOW,
      preview: "",
      words: 0,
      tokens: 0,
      revisionId: HASH,
      ...(withGenerationRecords ? { generationRecordIds: [HASH] } : {}),
      activeChildId: null
    }],
    facts: [],
    activeRootId: "root",
    bookmarks: [],
    recentNodeIds: [],
    chapterBreaks: []
  };
}

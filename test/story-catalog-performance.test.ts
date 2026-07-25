import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { mapWithConcurrency } from "../server/concurrency.js";
import { STORY_SCHEMA_VERSION, type StoryManifestV5 } from "../server/story-format.js";
import { StoryCatalog } from "../server/story-catalog.js";

const ENTRY_COUNT = 1_024;
const SCAN_BUDGET_MS = 10_000;
const NOW = "2026-01-01T00:00:00.000Z";

test("Q catalog performance: one retained scan pages a large catalog in budget", {
  concurrency: 1,
  timeout: 60_000
}, async (context) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-q-catalog-performance-"));
  const storiesDir = path.join(dataDir, "stories");
  await mkdir(storiesDir, { mode: 0o700 });
  const catalog = new StoryCatalog(dataDir);
  context.after(async () => {
    await catalog.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  const storyIds = Array.from({ length: ENTRY_COUNT }, (_, index) =>
    `catalog-performance-${index.toString().padStart(4, "0")}`);
  await mapWithConcurrency(storyIds, 64, async (storyId) => {
    const directory = path.join(storiesDir, storyId);
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify(manifest(storyId)),
      { mode: 0o600 }
    );
  });

  const seen = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  const started = performance.now();
  do {
    const page = await catalog.listPage({ cursor, maxEntries: 64 });
    page.items.forEach(({ id }) => seen.add(id));
    cursor = page.cursor;
    pages += 1;
  } while (cursor !== null);
  const elapsed = performance.now() - started;

  context.diagnostic(
    `${ENTRY_COUNT.toLocaleString()} stories in ${pages} retained-cursor pages: ` +
    `${elapsed.toFixed(1)}ms`
  );
  assert.equal(seen.size, ENTRY_COUNT);
  // An exact page-boundary scan needs one empty terminal page to observe EOF
  // without reading a 65th directory entry into the preceding page.
  assert.equal(pages, ENTRY_COUNT / 64 + 1);
  assert.ok(elapsed < SCAN_BUDGET_MS, `Q catalog scan took ${elapsed.toFixed(1)}ms`);
});

function manifest(id: string): StoryManifestV5 {
  return {
    format: "1667-story",
    schemaVersion: STORY_SCHEMA_VERSION,
    id,
    title: id,
    createdAt: NOW,
    updatedAt: NOW,
    activeWordCount: 0,
    nodes: [],
    facts: [],
    activeRootId: null,
    bookmarks: [],
    recentNodeIds: [],
    chapterBreaks: []
  };
}

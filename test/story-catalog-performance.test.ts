import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertWithinBudget,
  budgetTimeout,
  cpuBudget,
  fileBudget,
  startTiming
} from "./performance-budget.js";
import { mapWithConcurrency } from "../server/concurrency.js";
import { STORY_SCHEMA_VERSION, type StoryManifestV5 } from "../server/story-format.js";
import { StoryCatalog } from "../server/story-catalog.js";

const ENTRY_COUNT = 1_024;
// This scan reads 1,024 story directories, and a reader waits for it. So the
// scan keeps its wall-clock budget, which is what holds that wait down. The
// budget has never failed: the scan measures 361ms when idle and 1,428ms beside
// 16 busy processes, against a limit of 10,000ms.
const SCAN_BUDGET = fileBudget(10_000);
// The scan also parses and validates every manifest it reads, and the reads run
// together, so it uses more CPU time than wall-clock time: 520ms of CPU against
// 361ms of wall-clock when idle. Wall-clock time alone therefore hides work
// growth behind the margin above, and this second budget bounds the work.
//
// The limit comes from measurement. The worst CPU time beside 16 busy processes
// was 1,039ms, and this limit keeps about four times that.
const SCAN_CPU_BUDGET = cpuBudget(4_000);
const NOW = "2026-01-01T00:00:00.000Z";

test("Q catalog performance: one retained scan pages a large catalog in budget", {
  concurrency: 1,
  timeout: budgetTimeout([SCAN_BUDGET, SCAN_CPU_BUDGET], 20_000)
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
  const read = startTiming();
  do {
    const page = await catalog.listPage({ cursor, maxEntries: 64 });
    page.items.forEach(({ id }) => seen.add(id));
    cursor = page.cursor;
    pages += 1;
  } while (cursor !== null);
  const timing = read();

  assert.equal(seen.size, ENTRY_COUNT);
  // An exact page-boundary scan needs one empty terminal page to observe EOF
  // without reading a 65th directory entry into the preceding page.
  assert.equal(pages, ENTRY_COUNT / 64 + 1);
  const label = `${ENTRY_COUNT.toLocaleString()} stories in ${pages} retained-cursor pages`;
  assertWithinBudget(context, label, SCAN_BUDGET, timing);
  assertWithinBudget(context, `${label} — work`, SCAN_CPU_BUDGET, timing);
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

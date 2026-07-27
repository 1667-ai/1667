import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Story } from "../shared/types.js";
import { ServiceError } from "../server/errors.js";
import {
  CATALOG_CURSOR_IDLE_TTL_MS,
  MAX_CATALOG_SCANS,
  StoryCatalog
} from "../server/story-catalog.js";
import { stagingBundlePath } from "../server/story-lifecycle.js";
import { StoryStore } from "../server/stories.js";

test("Q catalog paginates mixed scan order without rescanning a prefix", async (t) => {
  const fixture = await setup(t, 5);
  const catalog = new StoryCatalog(fixture.dataDir);
  t.after(() => catalog.dispose());
  let cursor: string | null = null;
  let scanId: string | null = null;
  const seen = new Set<string>();
  do {
    const page = await catalog.listPage({ cursor, maxEntries: 2 });
    scanId ??= page.scanId;
    assert.equal(page.scanId, scanId);
    assert.ok(page.items.length <= 2);
    page.items.forEach(({ id }) => seen.add(id));
    cursor = page.cursor;
    assert.equal(page.done, cursor === null);
  } while (cursor !== null);
  assert.deepEqual([...seen].sort(), fixture.storyIds);
});

test("Q catalog enforces eight retained scans before opening another", async (t) => {
  const fixture = await setup(t, 9);
  const catalog = new StoryCatalog(fixture.dataDir);
  t.after(() => catalog.dispose());
  const cursors: string[] = [];
  for (let index = 0; index < MAX_CATALOG_SCANS; index += 1) {
    const page = await catalog.listPage({ cursor: null, maxEntries: 1 });
    assert.notEqual(page.cursor, null);
    cursors.push(page.cursor!);
  }
  assert.equal(new Set(cursors).size, MAX_CATALOG_SCANS);
  await assert.rejects(
    catalog.listPage({ cursor: null, maxEntries: 1 }),
    hasServiceError("resource_busy")
  );
});

test("Q catalog reserves capacity before concurrent directory opens", async (t) => {
  const fixture = await setup(t, 20);
  const catalog = new StoryCatalog(fixture.dataDir);
  t.after(() => catalog.dispose());
  const results = await Promise.allSettled(
    Array.from({ length: MAX_CATALOG_SCANS + 1 }, () =>
      catalog.listPage({ cursor: null, maxEntries: 1 }))
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    MAX_CATALOG_SCANS
  );
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  assert.equal(rejected.length, 1);
  assert.equal(hasServiceError("resource_busy")(rejected[0]!.reason), true);
});

test("Q catalog cursors expire after 60 idle seconds and across instances", async (t) => {
  const fixture = await setup(t, 2);
  let now = 1_000;
  const first = new StoryCatalog(fixture.dataDir, { now: () => now });
  const page = await first.listPage({ cursor: null, maxEntries: 1 });
  assert.notEqual(page.cursor, null);
  now += CATALOG_CURSOR_IDLE_TTL_MS;
  await assert.rejects(
    first.listPage({ cursor: page.cursor, maxEntries: 1 }),
    hasServiceError("catalog_cursor_expired")
  );
  await first.dispose();

  const restarted = new StoryCatalog(fixture.dataDir);
  t.after(() => restarted.dispose());
  await assert.rejects(
    restarted.listPage({ cursor: page.cursor, maxEntries: 1 }),
    hasServiceError("catalog_cursor_expired")
  );
});

test("Q catalog bounds one page to 64 directory entries", async (t) => {
  const fixture = await setup(t, 0);
  const storiesDir = path.join(fixture.dataDir, "stories");
  await Promise.all(Array.from({ length: 70 }, async (_, index) => {
    await writeFile(path.join(storiesDir, `.unrelated-${index}`), "");
  }));
  const catalog = new StoryCatalog(fixture.dataDir);
  t.after(() => catalog.dispose());
  const first = await catalog.listPage({ cursor: null, maxEntries: 64 });
  assert.equal(first.items.length, 0);
  assert.equal(first.done, false);
  const second = await catalog.listPage({
    cursor: first.cursor,
    maxEntries: 64
  });
  assert.equal(second.items.length, 0);
  assert.equal(second.done, true);
});

test("Q catalog lazily reaps exact predecessor staging and schedules live maintenance", async (t) => {
  const fixture = await setup(t, 1);
  const storiesDir = path.join(fixture.dataDir, "stories");
  const staging = stagingBundlePath(storiesDir, "abandoned-story");
  await mkdir(staging, { mode: 0o700 });
  const maintained: string[] = [];
  const catalog = new StoryCatalog(fixture.dataDir, {
    maintainStory: async (storyId) => { maintained.push(storyId); }
  });
  t.after(() => catalog.dispose());
  let cursor: string | null = null;
  do {
    const page = await catalog.listPage({ cursor, maxEntries: 64 });
    cursor = page.cursor;
  } while (cursor !== null);
  await assert.rejects(access(staging), hasFsCode("ENOENT"));
  assert.deepEqual(maintained, fixture.storyIds);
});

test("Q catalog rejects noncanonical cursor requests", async (t) => {
  const fixture = await setup(t, 0);
  const catalog = new StoryCatalog(fixture.dataDir);
  t.after(() => catalog.dispose());
  for (const input of [
    { cursor: null, maxEntries: 0 },
    { cursor: null, maxEntries: 65 },
    { cursor: "not-a-cursor", maxEntries: 1 },
    { cursor: null, maxEntries: 1, extra: true }
  ]) {
    await assert.rejects(
      catalog.listPage(input),
      hasServiceError("invalid_request")
    );
  }
});

async function setup(
  t: Pick<import("node:test").TestContext, "after">,
  count: number
) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-q-catalog-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const stories = new StoryStore(path.join(dataDir, "stories"));
  await stories.init();
  const storyIds = Array.from({ length: count }, (_, index) =>
    `catalog-story-${String(index).padStart(3, "0")}`);
  for (const [index, storyId] of storyIds.entries()) {
    await stories.save(storyFixture(storyId, index));
  }
  return { dataDir, storyIds };
}

function storyFixture(id: string, index: number): Story {
  const instant = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return {
    id,
    title: `Story ${index}`,
    createdAt: instant,
    updatedAt: instant,
    nodes: [],
    activeRootId: null,
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: []
  };
}

function hasServiceError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ServiceError && error.code === code;
}

function hasFsCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && "code" in error && error.code === code;
}

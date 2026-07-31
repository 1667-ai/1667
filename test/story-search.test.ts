import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { StoryService } from "../server/story-service.js";
import { StorySearchIndex } from "../server/story-search-index.js";
import { buildSearchCorpus, type SearchCorpus, type SearchResponse } from "../shared/story-search.js";
import type { Story } from "../shared/types.js";

async function openService(): Promise<{
  service: StoryService;
  close: () => Promise<void>;
}> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-search-"));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  return {
    service,
    close: async () => {
      await service.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}

/** One story with a fork, so the off-path take is only reachable through the
 *  whole-tree scan and never through the reading line. */
async function seedForkedStory(service: StoryService): Promise<{
  storyId: string;
  onLineId: string;
  offLineId: string;
}> {
  const story = await service.createStory("the lantern keeper");
  const root = await service.createNode(story.id, {
    parentId: null,
    text: "Maren lit the lantern before the storm arrived.",
    instruction: "open on the cliff road"
  });
  const rootId = root.path.at(-1)!.id;
  const kept = await service.createNode(story.id, {
    parentId: rootId,
    text: "The brass compass on the bar pointed at her, not north.",
    instruction: "the compass unsettles her"
  });
  const onLineId = kept.path.at(-1)!.id;
  const forked = await service.createNode(story.id, {
    parentId: rootId,
    text: "The compass stayed shut, and Ashe would not say why.",
    instruction: "the compass stays closed"
  });
  const offLineId = forked.path.at(-1)!.id;
  // Leave the reading line on the first take: the second is now off-path.
  await service.switchLine(story.id, onLineId);
  return { storyId: story.id, onLineId, offLineId };
}

test("tree scope finds takes that are off the reading line", async () => {
  const { service, close } = await openService();
  try {
    const seeded = await seedForkedStory(service);
    const response: SearchResponse = await service.searchStories({
      query: "compass",
      scope: "tree",
      storyId: seeded.storyId,
      caseSensitive: false
    });

    const prose = response.hits.filter((hit) => hit.kind === "prose");
    const targets = prose.map((hit) => hit.targetId);
    assert.ok(targets.includes(seeded.onLineId));
    // The point of search: the take nobody is standing on is still findable.
    assert.ok(targets.includes(seeded.offLineId));
    assert.equal(response.storiesSearched, 1);
    assert.equal(response.capped, false);

    for (const hit of prose) {
      const match = hit.snippet.slice(hit.snippetMatch, hit.snippetMatch + hit.matchLength);
      assert.equal(match.toLowerCase(), "compass");
      assert.equal(
        hit.context.slice(hit.contextMatch, hit.contextMatch + hit.matchLength).toLowerCase(),
        "compass"
      );
    }
  } finally {
    await close();
  }
});

test("the corpus carries prompts and facts beside the prose", async () => {
  const { service, close } = await openService();
  try {
    const seeded = await seedForkedStory(service);
    await service.createFact(seeded.storyId, {
      tag: "items",
      text: "The compass points at want, not north."
    });
    const response = await service.searchStories({
      query: "compass",
      scope: "tree",
      storyId: seeded.storyId,
      caseSensitive: false
    });

    const kinds = new Set(response.hits.map((hit) => hit.kind));
    assert.ok(kinds.has("prose"));
    assert.ok(kinds.has("prompt"));
    assert.ok(kinds.has("fact"));
  } finally {
    await close();
  }
});

test("case sensitivity narrows the result set", async () => {
  const { service, close } = await openService();
  try {
    const seeded = await seedForkedStory(service);
    const insensitive = await service.searchStories({
      query: "Maren",
      scope: "tree",
      storyId: seeded.storyId,
      caseSensitive: false
    });
    const sensitive = await service.searchStories({
      query: "maren",
      scope: "tree",
      storyId: seeded.storyId,
      caseSensitive: true
    });

    assert.ok(insensitive.hits.length > 0);
    assert.equal(sensitive.hits.length, 0);
  } finally {
    await close();
  }
});

test("a query shorter than two characters runs nothing", async () => {
  const { service, close } = await openService();
  try {
    const seeded = await seedForkedStory(service);
    const response = await service.searchStories({
      query: "c",
      scope: "tree",
      storyId: seeded.storyId,
      caseSensitive: false
    });
    assert.deepEqual(response.hits, []);
    assert.equal(response.storiesSearched, 0);
  } finally {
    await close();
  }
});

test("vault scope reads every story and scans the open one first", async () => {
  const { service, close } = await openService();
  try {
    const seeded = await seedForkedStory(service);
    const other = await service.createStory("the salt year");
    await service.createNode(other.id, {
      parentId: null,
      text: "A compass is a promise you can hold.",
      instruction: "open on the harbour"
    });

    const response = await service.searchStories({
      query: "compass",
      scope: "vault",
      storyId: seeded.storyId,
      caseSensitive: false
    });

    const storyIds = response.hits.map((hit) => hit.storyId);
    assert.ok(new Set(storyIds).size > 1);
    // The open story is scanned first, so its hits survive the cap.
    assert.equal(storyIds[0], seeded.storyId);
    assert.ok(response.storiesSearched > 1);
    const titles = new Set(response.hits.map((hit) => hit.storyTitle));
    assert.ok(titles.has("the salt year"));
  } finally {
    await close();
  }
});

test("offsets index the text they travel with, whatever its case folds to", async () => {
  const { service, close } = await openService();
  try {
    const story = await service.createStory("the salt year");
    // `İ` lower-cases to two UTF-16 units. Searching a folded copy of the text
    // and reporting offsets from it would slide every later highlight.
    await service.createNode(story.id, {
      parentId: null,
      text: "İstanbul kept the lantern. The lantern kept İstanbul.",
      instruction: "open on the harbour"
    });

    const response = await service.searchStories({
      query: "lantern",
      scope: "tree",
      storyId: story.id,
      caseSensitive: false
    });

    const prose = response.hits.filter((hit) => hit.kind === "prose");
    assert.ok(prose.length >= 2);
    for (const hit of prose) {
      assert.equal(
        hit.snippet.slice(hit.snippetMatch, hit.snippetMatch + hit.matchLength).toLowerCase(),
        "lantern"
      );
      assert.equal(
        hit.context.slice(hit.contextMatch, hit.contextMatch + hit.matchLength).toLowerCase(),
        "lantern"
      );
    }
  } finally {
    await close();
  }
});

test("a query is matched literally, never as a pattern", async () => {
  const { service, close } = await openService();
  try {
    const seeded = await seedForkedStory(service);
    const response = await service.searchStories({
      query: "co.pass",
      scope: "tree",
      storyId: seeded.storyId,
      caseSensitive: false
    });
    assert.deepEqual(response.hits, []);
  } finally {
    await close();
  }
});

test("a story deleted mid-scan does not fail the vault query", async () => {
  const { service, close } = await openService();
  try {
    const seeded = await seedForkedStory(service);
    const doomed = await service.createStory("the glass tide");
    await service.createNode(doomed.id, {
      parentId: null,
      text: "A compass is a promise you can hold.",
      instruction: "open on the harbour"
    });
    // Warm the listing this scan will walk, then delete a story it names.
    await service.listStories();
    await service.deleteStory(doomed.id);

    const response = await service.searchStories({
      query: "compass",
      scope: "vault",
      storyId: seeded.storyId,
      caseSensitive: false
    });
    assert.ok(response.hits.length > 0);
    assert.ok(!response.hits.some((hit) => hit.storyId === doomed.id));
  } finally {
    await close();
  }
});

test("a corpus rebuilds after the story it came from changes", async () => {
  const { service, close } = await openService();
  try {
    const seeded = await seedForkedStory(service);
    const before = await service.searchStories({
      query: "weathervane",
      scope: "tree",
      storyId: seeded.storyId,
      caseSensitive: false
    });
    assert.deepEqual(before.hits, []);

    await service.createNode(seeded.storyId, {
      parentId: seeded.onLineId,
      text: "The weathervane above the inn had not turned in a week.",
      instruction: "hold on the roofline"
    });

    const after = await service.searchStories({
      query: "weathervane",
      scope: "tree",
      storyId: seeded.storyId,
      caseSensitive: false
    });
    assert.ok(after.hits.length > 0);
  } finally {
    await close();
  }
});

test("secondary snippet trims stay surrogate-safe when astral characters straddle boundaries", async () => {
  const { service, close } = await openService();
  try {
    const story = await service.createStory("astral story");
    // Long padding text with emoji 🧩 🌊 🔮 placed around cut edges.
    const leadEmoji = "🧩".repeat(30);
    const tailEmoji = "🌊".repeat(30);
    await service.createNode(story.id, {
      parentId: null,
      text: `${leadEmoji} TARGET ${tailEmoji}`,
      instruction: "test"
    });

    const response = await service.searchStories({
      query: "TARGET",
      scope: "tree",
      storyId: story.id,
      caseSensitive: false
    });

    assert.equal(response.hits.length, 1);
    const hit = response.hits[0]!;
    // Ensure snippet contains valid UTF-16 code units (no lone surrogates)
    assert.doesNotThrow(() => {
      Array.from(hit.snippet);
    });
    const match = hit.snippet.slice(hit.snippetMatch, hit.snippetMatch + hit.matchLength);
    assert.equal(match, "TARGET");
  } finally {
    await close();
  }
});

test("a match longer than the preview window still fits its own context", async () => {
  const { service, close } = await openService();
  try {
    const story = await service.createStory("the salt year");
    // A writer can paste a passage out of their own prose. The hit must carry a
    // context its own match fits inside, or the client rejects the response.
    const passage = Array.from({ length: 40 }, (_, index) =>
      `sentence ${index} of one very long contiguous passage`).join(" ");
    await service.createNode(story.id, {
      parentId: null,
      text: `Before. ${passage} After.`,
      instruction: "open on the harbour"
    });

    const response = await service.searchStories({
      query: passage.slice(0, 250),
      scope: "tree",
      storyId: story.id,
      caseSensitive: false
    });

    assert.ok(response.hits.length > 0);
    for (const hit of response.hits) {
      assert.ok(hit.contextMatch + hit.matchLength <= hit.context.length);
      assert.ok(hit.snippetMatch + hit.matchLength <= hit.snippet.length);
    }
  } finally {
    await close();
  }
});

test("a query longer than the cap does not run", async () => {
  const { service, close } = await openService();
  try {
    const seeded = await seedForkedStory(service);
    const response = await service.searchStories({
      query: "compass ".repeat(80),
      scope: "tree",
      storyId: seeded.storyId,
      caseSensitive: false
    });
    assert.deepEqual(response.hits, []);
    assert.equal(response.storiesSearched, 0);
  } finally {
    await close();
  }
});

test("concurrent cold queries share one hydration", async () => {
  const { service, close } = await openService();
  try {
    const seeded = await seedForkedStory(service);
    // A keystroke fires a request. Several cold ones for the same revision must
    // not each queue their own full-tree read.
    const responses = await Promise.all(["comp", "compa", "compas", "compass"].map((query) =>
      service.searchStories({
        query,
        scope: "tree",
        storyId: seeded.storyId,
        caseSensitive: false
      })));
    for (const response of responses) {
      assert.ok(response.hits.length > 0);
      assert.equal(response.storiesSearched, 1);
    }
  } finally {
    await close();
  }
});

test("a deleted story leaves no prepared text behind", async () => {
  const { service, close } = await openService();
  try {
    const seeded = await seedForkedStory(service);
    const doomed = await service.createStory("the glass tide");
    await service.createNode(doomed.id, {
      parentId: null,
      text: "A compass is a promise you can hold.",
      instruction: "open on the harbour"
    });
    // Warm its corpus, then delete it.
    await service.searchStories({
      query: "compass",
      scope: "vault",
      storyId: seeded.storyId,
      caseSensitive: false
    });
    await service.deleteStory(doomed.id);

    const after = await service.searchStories({
      query: "compass",
      scope: "vault",
      storyId: seeded.storyId,
      caseSensitive: false
    });
    assert.ok(!after.hits.some((hit) => hit.storyId === doomed.id));
  } finally {
    await close();
  }
});

test("an already-cancelled search reads nothing", async () => {
  const { service, close } = await openService();
  try {
    const seeded = await seedForkedStory(service);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => service.searchStories({
        query: "compass",
        scope: "vault",
        storyId: seeded.storyId,
        caseSensitive: false
      }, controller.signal),
      /superseded or cancelled/
    );
  } finally {
    await close();
  }
});

test("a scan stops when the query behind it is superseded", async () => {
  const { service, close } = await openService();
  try {
    const seeded = await seedForkedStory(service);
    for (const title of ["the salt year", "the winter orchard", "a glass tide"]) {
      const other = await service.createStory(title);
      await service.createNode(other.id, {
        parentId: null,
        text: "A compass is a promise you can hold.",
        instruction: "open on the harbour"
      });
    }

    const controller = new AbortController();
    const scan = service.searchStories({
      query: "compass",
      scope: "vault",
      storyId: seeded.storyId,
      caseSensitive: false
    }, controller.signal);
    // The next keystroke lands while the scan is still walking the vault.
    controller.abort();
    await assert.rejects(() => scan, /superseded or cancelled/);
  } finally {
    await close();
  }
});

test("an obsolete build cannot evict the corpus that replaced it", async () => {
  const index = new StorySearchIndex();
  const corpus = (id: string): SearchCorpus =>
    ({ storyId: id, storyTitle: "t", updatedAt: "r2", entries: [] });

  // A build for the old revision is still reading when a new revision arrives.
  let releaseStale!: (value: SearchCorpus | null) => void;
  const stale = index.get("s", "t", "r1", () =>
    new Promise<SearchCorpus | null>((resolve) => { releaseStale = resolve; }));

  let freshBuilds = 0;
  const fresh = await index.get("s", "t", "r2", async () => {
    freshBuilds += 1;
    return corpus("s");
  });
  assert.equal(fresh?.updatedAt, "r2");

  // The stale build now reports the story missing. It must retire itself, not
  // the entry that replaced it.
  releaseStale(null);
  assert.equal(await stale, null);

  await index.get("s", "t", "r2", async () => {
    freshBuilds += 1;
    return corpus("s");
  });
  assert.equal(freshBuilds, 1, "the surviving corpus was served from the cache");
});

test("concurrent cold callers share one build", async () => {
  const index = new StorySearchIndex();
  let builds = 0;
  const build = async (): Promise<SearchCorpus> => {
    builds += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { storyId: "s", storyTitle: "t", updatedAt: "r1", entries: [] };
  };
  const all = await Promise.all([
    index.get("s", "t", "r1", build),
    index.get("s", "t", "r1", build),
    index.get("s", "t", "r1", build)
  ]);
  assert.equal(builds, 1);
  assert.ok(all.every((corpus) => corpus?.updatedAt === "r1"));
});

test("oversized corpus is returned without being cached in index", async () => {
  const index = new StorySearchIndex();
  // Construct a story larger than MAX_CACHED_CHARACTERS (8,000,000 chars)
  const hugeText = "x".repeat(8_000_001);
  const story: Story = {
    id: "huge-1",
    title: "Huge Story",
    updatedAt: "2026-07-30T00:00:00.000Z",
    createdAt: "2026-07-30T00:00:00.000Z",
    nodes: [{
      id: "n1",
      parentId: null,
      text: hugeText,
      instruction: "",
      model: "test-model",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
      activeChildId: null
    }],
    activeRootId: "n1",
    recentNodeIds: [],
    tags: [],
    facts: [],
    chapterBreaks: []
  };

  const corpus = await index.get("huge-1", "Huge Story", "2026-07-30T00:00:00.000Z", async () => buildSearchCorpus(story));
  assert.equal(corpus?.storyId, "huge-1");
  // Index must not retain it
  let buildCalled = false;
  await index.get("huge-1", "Huge Story", "2026-07-30T00:00:00.000Z", async () => {
    buildCalled = true;
    return null;
  });
  assert.equal(buildCalled, true);
});


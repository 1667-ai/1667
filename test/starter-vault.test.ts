import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { starterKeyToken } from "../shared/starter-keys.js";
import {
  STARTER_OPENING_STORY_ID,
  STARTER_STORIES
} from "../shared/starter-vault.js";
import { StoryService } from "../server/story-service.js";

async function withService<T>(
  options: { existingDirectory?: boolean; seed?: boolean },
  work: (service: StoryService) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "starter-vault-"));
  const dataDir = path.join(root, "data");
  if (options.existingDirectory === true) await mkdir(dataDir, { mode: 0o700 });
  const service = new StoryService({
    dataDir,
    ...(options.seed === false ? {} : { starterVault: "seed-when-new" as const })
  });
  await service.init();
  try {
    return await work(service);
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

test("a first run opens on a tour and a seed story", async () => {
  await withService({}, async (service) => {
    const stories = await service.listStories();
    assert.deepEqual(
      [...stories].map((story) => story.title).sort(),
      [...STARTER_STORIES].map((story) => story.title).sort()
    );
    assert.ok(stories.some((story) => story.id === STARTER_OPENING_STORY_ID));
  });
});

test("the tour keeps its takes, bookmarks, and chapter on the written line", async () => {
  await withService({}, async (service) => {
    const [tour, seed] = STARTER_STORIES;
    const payload = await service.loadStory(tour!.id);

    // Every declared take reached storage, and the opening beat still offers
    // the row of alternatives the prose tells the reader to flip through.
    const declaredTakes = tour!.beats.flatMap((beat) => beat.takes);
    assert.equal(payload.nodes.length, declaredTakes.length);
    assert.equal(payload.nodes.filter((node) => node.parentId === null).length, 3);

    // The line runs through the first take of each beat, not the last one
    // written, so the reader lands on take 1 of 3.
    const roots = payload.nodes.filter((node) => node.parentId === null);
    const opening = roots.find((node) => node.preview.startsWith("Welcome to 1667"));
    assert.ok(opening, "the opening take should be a root");
    assert.equal(payload.activeRootId, opening.id);

    assert.deepEqual(
      payload.bookmarks.map((bookmark) => bookmark.label).sort(),
      ["Alt", "Canon", "Draft"]
    );
    assert.equal(payload.chapterBreaks.length, 1);
    assert.equal(payload.chapterBreaks[0]?.title, "The Map");

    const seedPayload = await service.loadStory(seed!.id);
    assert.equal(seedPayload.nodes.length, 1);
    assert.equal(seedPayload.bookmarks.length, 0);
  });
});

test("bookmarks stay on the parts the prose points at", async () => {
  await withService({}, async (service) => {
    const tour = STARTER_STORIES[0]!;
    const payload = await service.loadStory(tour.id);
    const byName = new Map(payload.bookmarks.map((bookmark) => [bookmark.name, bookmark]));

    // A bookmark set on a line end migrates onto any child created afterwards.
    // Each of these sits on a part with prose that names it, so a migration
    // would silently point the tour at the wrong place.
    for (const beat of tour.beats) {
      for (const take of beat.takes) {
        if (take.bookmark === undefined) continue;
        const bookmark = byName.get(take.bookmark.name);
        assert.ok(bookmark, `missing bookmark: ${take.bookmark.name}`);
        const node = payload.nodes.find((candidate) => candidate.id === bookmark.nodeId);
        assert.ok(node, `bookmark ${take.bookmark.name} points at no part`);
        assert.ok(
          take.text.startsWith(node.preview.slice(0, 40)),
          `bookmark ${take.bookmark.name} drifted onto another part`
        );
      }
    }
  });
});

test("a first run opens on the tour, not the story seeded beside it", async () => {
  await withService({}, async (service) => {
    // Clients resolve "which story" by newest updatedAt, so the tour has to be
    // written last. Seeding in declaration order opened A Door in the Hedge.
    const stories = await service.listStories();
    const newest = [...stories].sort(
      (left, right) => right.updatedAt.localeCompare(left.updatedAt)
    )[0];
    assert.equal(newest?.id, STARTER_OPENING_STORY_ID);
    assert.equal(newest?.title, "Start Here");
  });
});

test("initializing twice does not replay the vault", async () => {
  // init() is idempotent and concurrency-safe. Seeding outside that guard used
  // to re-run and fail on the chapter seam, disposing a ready service.
  const root = await mkdtemp(path.join(tmpdir(), "starter-vault-"));
  const service = new StoryService({
    dataDir: path.join(root, "data"),
    starterVault: "seed-when-new"
  });
  try {
    await service.init();
    await service.init();
    await Promise.all([service.init(), service.init()]);
    const stories = await service.listStories();
    assert.equal(stories.length, STARTER_STORIES.length);
    const payload = await service.loadStory(STARTER_OPENING_STORY_ID);
    assert.equal(payload.chapterBreaks.length, 1);
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("an emptied library is never refilled", async () => {
  // Deleting the starter stories has to stick. Seeding keys off directory
  // creation, so a directory that already existed stays exactly as found.
  await withService({ existingDirectory: true }, async (service) => {
    assert.deepEqual(await service.listStories(), []);
  });
});

test("maintenance entry points leave a fresh directory empty", async () => {
  await withService({ seed: false }, async (service) => {
    assert.deepEqual(await service.listStories(), []);
  });
});

test("starter prose spells every key it declares", async () => {
  // Only this direction lives here. The opposite one — prose may not spell a
  // key it never declared — needs the real resolver and the keys overlay, so it
  // is asserted once in tui/test/starter-vault-keys.test.ts rather than twice.
  for (const story of STARTER_STORIES) {
    for (const beat of story.beats) {
      for (const take of beat.takes) {
        for (const id of take.keys ?? []) {
          assert.ok(
            take.text.includes(starterKeyToken(id)),
            `${take.slug} declares ${id} but never spells ${starterKeyToken(id)}`
          );
        }
      }
    }
  }
});

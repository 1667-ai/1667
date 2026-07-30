import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { starterKeyToken } from "../shared/starter-keys.js";
import {
  STARTER_LOGO_TEXT,
  STARTER_OPENING_STORY_ID,
  STARTER_STORIES,
  starterProse
} from "../shared/starter-vault.js";
import { StoryService } from "../server/story-service.js";

async function withService<T>(
  options: { seed?: boolean },
  work: (service: StoryService) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "starter-vault-"));
  const dataDir = path.join(root, "data");
  const service = StoryService.withoutDiagnostics({
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

test("the tour keeps its takes, tags, and chapter on the written line", async () => {
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
    const opening = payload.path[0];
    assert.ok(opening, "the opening take should be on the active path");
    assert.ok(opening.text.startsWith(`${STARTER_LOGO_TEXT}\n\nWelcome to 1667.`));
    assert.ok(roots.some((node) => node.id === opening.id), "the opening take should be a root");
    assert.equal(payload.activeRootId, opening.id);

    assert.deepEqual(
      payload.tags.map((tag) => tag.status).sort(),
      ["Alt", "Canon", "Draft"]
    );
    assert.equal(payload.chapterBreaks.length, 1);
    assert.equal(payload.chapterBreaks[0]?.title, "The Map");

    const seedPayload = await service.loadStory(seed!.id);
    assert.equal(seedPayload.nodes.length, 1);
    assert.equal(seedPayload.tags.length, 0);
  });
});

test("tags stay on the parts the prose points at", async () => {
  await withService({}, async (service) => {
    const tour = STARTER_STORIES[0]!;
    const payload = await service.loadStory(tour.id);
    const byName = new Map(payload.tags.map((tag) => [tag.name, tag]));

    // A tag set on a line end migrates onto any child created afterwards.
    // Each of these sits on a part with prose that names it, so a migration
    // would silently point the tour at the wrong place.
    for (const beat of tour.beats) {
      for (const take of beat.takes) {
        if (take.tag === undefined) continue;
        const tag = byName.get(take.tag.name);
        assert.ok(tag, `missing tag: ${take.tag.name}`);
        const node = payload.nodes.find((candidate) => candidate.id === tag.nodeId);
        assert.ok(node, `tag ${take.tag.name} points at no part`);
        assert.ok(
          take.text.startsWith(node.preview.slice(0, 40)),
          `tag ${take.tag.name} drifted onto another part`
        );
      }
    }
  });
});

test("both starter stories open with facts of their own", async () => {
  await withService({}, async (service) => {
    for (const story of STARTER_STORIES) {
      const payload = await service.loadStory(story.id);
      assert.deepEqual(
        payload.facts.map((fact) => ({ tag: fact.tag, text: fact.text })),
        story.facts.map((fact) => ({ tag: fact.tag, text: fact.text })),
        `${story.title} seeded the wrong facts`
      );
      // The overlay titles a fact by its first line and sorts it by its tag, so
      // a fact with neither is a blank row in a list the tour points at.
      for (const fact of payload.facts) {
        assert.ok(fact.text.split("\n")[0]?.trim(), "a fact needs a first line to be named by");
        assert.ok(fact.tag !== null && fact.tag.length > 0, "a fact needs a tag to sort under");
      }
    }
  });
});

test("a story's facts are written in the one change that writes its prose", async () => {
  // Seeding is the slowest part of a first run and each change rewrites the
  // whole manifest, so the vault writes a story once. One shared createdAt is
  // what that leaves behind: a seeder that added facts one command at a time
  // would spread them over as many timestamps as facts.
  await withService({}, async (service) => {
    for (const story of STARTER_STORIES) {
      const payload = await service.loadStory(story.id);
      const stamps = new Set(payload.facts.map((fact) => fact.createdAt));
      assert.equal(stamps.size, 1, `${story.title} wrote its facts in ${stamps.size} changes`);
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
  const service = StoryService.withoutDiagnostics({
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
  // Deleting the starter stories has to stick. Freshness keys off the format
  // marker, which an emptied library still carries, so only a directory holding
  // no 1667 data at all is ever seeded.
  const root = await mkdtemp(path.join(tmpdir(), "starter-vault-emptied-"));
  const dataDir = path.join(root, "data");
  try {
    const first = StoryService.withoutDiagnostics({
      dataDir,
      starterVault: "seed-when-new"
    });
    await first.init();
    try {
      const seeded = await first.listStories();
      assert.equal(seeded.length, STARTER_STORIES.length);
      for (const story of seeded) await first.deleteStory(story.id);
    } finally {
      await first.dispose();
    }

    const reopened = StoryService.withoutDiagnostics({
      dataDir,
      starterVault: "seed-when-new"
    });
    await reopened.init();
    try {
      assert.deepEqual(await reopened.listStories(), []);
    } finally {
      await reopened.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
  for (const prose of starterProse()) {
    for (const id of prose.keys) {
      assert.ok(
        prose.text.includes(starterKeyToken(id)),
        `${prose.slug} declares ${id} but never spells ${starterKeyToken(id)}`
      );
    }
  }
});

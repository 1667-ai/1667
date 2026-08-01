import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Story } from "../shared/types.js";
import { createMutationCoordinator } from "../server/mutation-coordinator.js";
import { StoryCatalog } from "../server/story-catalog.js";
import {
  InjectedStoryCreationCrash,
  StoryCreationMutationStore,
  type StoryCreationMutationHooks
} from "../server/story-creation-mutation.js";
import { storyIdForMutation } from "../server/story-identity.js";
import {
  storyResidueIdentityName,
  storyResidueNames
} from "../server/story-residue.js";
import { parseStoryManifestBytes } from "../server/story-v6-codec.js";
import { StoryStore } from "../server/stories.js";
import { MAX_STORY_MANIFEST_BYTES } from "../server/story-v5-strict.js";
import { partsFromMarkdown } from "../server/import-md.js";
import { storyFromImport } from "../server/import-st.js";

const MUTATION_ID = "m1.1767225600000.0123456789abcdef0123456789abcdef";
const STORY_ID = storyIdForMutation(MUTATION_ID);
const FINGERPRINT = "a".repeat(64);
const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");

for (const point of [
  "identity",
  "residue",
  "prepared",
  "publish",
  "completed",
  "cleanup"
] as const) {
  test(`Q deterministic creation recovers a crash after ${point}`, async (t) => {
    const fixture = await setup(t);
    let injected = false;
    const hooks: StoryCreationMutationHooks = {
      [`after${capitalize(point)}`]: () => {
        if (injected) return;
        injected = true;
        throw new InjectedStoryCreationCrash(point);
      }
    };
    const crashing = new StoryCreationMutationStore(
      fixture.stories,
      createMutationCoordinator(),
      fixture.dataDir,
      { hooks, now: () => FIXED_NOW }
    );
    await crashing.init();
    await assert.rejects(
      crashing.run(request(), "createStory", storyFixture),
      (error: unknown) => error instanceof InjectedStoryCreationCrash
    );

    const recovered = new StoryCreationMutationStore(
      fixture.stories,
      createMutationCoordinator(),
      fixture.dataDir,
      { now: () => FIXED_NOW }
    );
    await recovered.init();
    const committed = await recovered.run(
      request(),
      "createStory",
      storyFixture
    );
    assert.equal(committed.story.id, STORY_ID);
    assert.equal(committed.result.storyRevision, "00000000000000000001");
    const parsed = parseStoryManifestBytes(
      await readFile(fixture.manifest),
      STORY_ID
    );
    assert.equal(parsed.kind, "v6-live");
    await assert.rejects(access(fixture.residue), hasFsCode("ENOENT"));
    await assert.rejects(access(fixture.identity), hasFsCode("ENOENT"));
  });
}

for (const point of ["prepared", "publish", "completed"] as const) {
  test(`Markdown import retains one story and stable child IDs after ${point} crash`, async (t) => {
    const fixture = await setup(t);
    let injected = false;
    const crashing = new StoryCreationMutationStore(
      fixture.stories,
      createMutationCoordinator(),
      fixture.dataDir,
      {
        now: () => FIXED_NOW,
        hooks: {
          [`after${capitalize(point)}`]: () => {
            if (injected) return;
            injected = true;
            throw new InjectedStoryCreationCrash(point);
          }
        }
      }
    );
    await crashing.init();
    await assert.rejects(
      crashing.run(request(), "importMarkdown", markdownStoryFixture),
      (error: unknown) => error instanceof InjectedStoryCreationCrash
    );

    const recovered = new StoryCreationMutationStore(
      fixture.stories,
      createMutationCoordinator(),
      fixture.dataDir,
      { now: () => FIXED_NOW }
    );
    await recovered.init();
    const committed = await recovered.run(
      request(),
      "importMarkdown",
      markdownStoryFixture
    );
    assert.equal(committed.story.id, STORY_ID);
    assert.deepEqual(committed.story.nodes.map(({ id }) => id), [
      "import-node-0",
      "import-node-1"
    ]);
    assert.deepEqual(committed.story.chapterBreaks.map(({ id }) => id), [
      "chapter-break-0"
    ]);
    assert.deepEqual((await fixture.stories.list()).map(({ id }) => id), [STORY_ID]);
    const loaded = await fixture.stories.load(STORY_ID);
    assert.deepEqual(loaded.nodes.map(({ id }) => id), [
      "import-node-0",
      "import-node-1"
    ]);
    assert.deepEqual(loaded.chapterBreaks.map(({ id }) => id), [
      "chapter-break-0"
    ]);
  });
}

test("Q catalog recovery finalizes a prepared creation residue", async (t) => {
  const fixture = await setup(t);
  let injected = false;
  const crashing = new StoryCreationMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    {
      now: () => FIXED_NOW,
      hooks: {
        afterPrepared: () => {
          if (injected) return;
          injected = true;
          throw new InjectedStoryCreationCrash("prepared");
        }
      }
    }
  );
  await crashing.init();
  await assert.rejects(
    crashing.run(request(), "createStory", storyFixture),
    (error: unknown) => error instanceof InjectedStoryCreationCrash
  );

  const recovery = new StoryCreationMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    { now: () => FIXED_NOW }
  );
  await recovery.init();
  const catalog = new StoryCatalog(fixture.dataDir, {
    recoverResidue: async (kind, storyId) => {
      assert.equal(kind, "create");
      await recovery.recoverResidue(storyId);
    }
  });
  t.after(() => catalog.dispose());
  const page = await catalog.listPage({ cursor: null, maxEntries: 64 });
  assert.equal(page.items.some(({ id }) => id === STORY_ID), true);
  const loaded = await fixture.stories.loadVersioned(STORY_ID);
  assert.equal(loaded.story.title, "Atomic");
  assert.deepEqual(loaded.aggregateVersion, {
    kind: "v6",
    revision: "00000000000000000001"
  });
});

test("Q creation recovery rejects an oversized residue before reading it", async (t) => {
  const fixture = await setup(t);
  const crashing = new StoryCreationMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    {
      now: () => FIXED_NOW,
      hooks: {
        afterPrepared: () => {
          throw new InjectedStoryCreationCrash("prepared");
        }
      }
    }
  );
  await crashing.init();
  await assert.rejects(
    crashing.run(request(), "createStory", storyFixture),
    (error: unknown) => error instanceof InjectedStoryCreationCrash
  );
  await writeFile(
    path.join(fixture.residue, "manifest.json"),
    Buffer.alloc(MAX_STORY_MANIFEST_BYTES + 1)
  );
  const recovered = new StoryCreationMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    { now: () => FIXED_NOW }
  );
  await recovered.init();
  await assert.rejects(
    recovered.run(request(), "createStory", storyFixture),
    /bounded regular file|size|large|limit/i
  );
});

async function setup(t: Pick<import("node:test").TestContext, "after">) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-q-create-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const storiesDir = path.join(dataDir, "stories");
  const stories = new StoryStore(storiesDir);
  await stories.init();
  return {
    dataDir,
    stories,
    manifest: path.join(storiesDir, STORY_ID, "manifest.json"),
    residue: path.join(storiesDir, storyResidueNames(STORY_ID).create),
    identity: path.join(
      storiesDir,
      storyResidueIdentityName("create", STORY_ID)
    )
  };
}

function request() {
  return {
    transportOperationId: "operation-create",
    mutationId: MUTATION_ID,
    fingerprint: FINGERPRINT,
    scope: `story:${STORY_ID}`,
    expectedAggregateVersion: { kind: "absent" }
  };
}

function storyFixture(): Story {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: STORY_ID,
    title: "Atomic",
    createdAt: now,
    updatedAt: now,
    nodes: [],
    activeRootId: null,
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: []
  };
}

function markdownStoryFixture(deterministicStoryId = STORY_ID): Story {
  return storyFromImport(
    partsFromMarkdown("# Imported\n\nFirst.\n\n## Later\n\nSecond."),
    {
      storyId: deterministicStoryId,
      nodeId: (index) => `import-node-${index}`,
      chapterBreakId: (index) => `chapter-break-${index}`
    }
  );
}

function capitalize(value: string): string {
  return `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function hasFsCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && "code" in error && error.code === code;
}

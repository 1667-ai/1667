import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Story } from "../shared/types.js";
import { ProviderError } from "../server/errors.js";
import { createMutationCoordinator } from "../server/mutation-coordinator.js";
import { StoryCatalog } from "../server/story-catalog.js";
import { hashStoryV5ManifestBytes } from "../server/story-manifest-hash.js";
import { StoryMutationStore } from "../server/story-mutation-store.js";
import {
  STORY_REAP_RETENTION_MS,
  StoryReaper,
  type StoryReaperHooks
} from "../server/story-reaper.js";
import {
  storyResidueIdentityName,
  storyResidueNames
} from "../server/story-residue.js";
import { StoryStore } from "../server/stories.js";

const STORY_ID = "q-reap-story";
const MUTATION_ID = "m1.1767225600000.0123456789abcdef0123456789abcdef";
const PROVIDER_MUTATION_ID = "m1.1767225600000.1123456789abcdef0123456789abcdef";
const FINGERPRINT = "a".repeat(64);
const DELETED_AT = "2026-01-01T00:00:00.000Z";

test("Q reaper preserves a tombstone for 90 days then removes it physically", async (t) => {
  const fixture = await deletedFixture(t);
  const early = new StoryReaper(
    fixture.dataDir,
    createMutationCoordinator(),
    { now: () => new Date(Date.parse(DELETED_AT) + STORY_REAP_RETENTION_MS - 1) }
  );
  assert.equal(await early.reapIfEligible(STORY_ID), false);
  await access(fixture.canonical);

  const eligible = new StoryReaper(
    fixture.dataDir,
    createMutationCoordinator(),
    { now: () => new Date(Date.parse(DELETED_AT) + STORY_REAP_RETENTION_MS) }
  );
  assert.equal(await eligible.reapIfEligible(STORY_ID), true);
  await assert.rejects(access(fixture.canonical), hasFsCode("ENOENT"));
  await assert.rejects(access(fixture.residue), hasFsCode("ENOENT"));
  await assert.rejects(access(fixture.identity), hasFsCode("ENOENT"));
  assert.equal(await eligible.reapIfEligible(STORY_ID), false);
});

for (const point of ["identity", "rename", "residueRemove", "cleanup"] as const) {
  test(`Q reaper recovers a crash after ${point}`, async (t) => {
    const fixture = await deletedFixture(t);
    let injected = false;
    const hooks: StoryReaperHooks = {
      [`after${capitalize(point)}`]: () => {
        if (injected) return;
        injected = true;
        throw new Error(`crash:${point}`);
      }
    };
    const crashing = new StoryReaper(
      fixture.dataDir,
      createMutationCoordinator(),
      { now: eligibleClock, hooks }
    );
    await assert.rejects(
      crashing.reapIfEligible(STORY_ID),
      new RegExp(`crash:${point}`)
    );

    const recovered = new StoryReaper(
      fixture.dataDir,
      createMutationCoordinator(),
      { now: eligibleClock }
    );
    await recovered.reapIfEligible(STORY_ID);
    await assert.rejects(access(fixture.canonical), hasFsCode("ENOENT"));
    await assert.rejects(access(fixture.residue), hasFsCode("ENOENT"));
    await assert.rejects(access(fixture.identity), hasFsCode("ENOENT"));
  });
}

test("Q catalog recovery completes a physically committed reap residue", async (t) => {
  const fixture = await deletedFixture(t);
  let injected = false;
  const crashing = new StoryReaper(
    fixture.dataDir,
    createMutationCoordinator(),
    {
      now: eligibleClock,
      hooks: {
        afterRename: () => {
          if (injected) return;
          injected = true;
          throw new Error("crash:rename");
        }
      }
    }
  );
  await assert.rejects(
    crashing.reapIfEligible(STORY_ID),
    /crash:rename/
  );

  const recovery = new StoryReaper(
    fixture.dataDir,
    createMutationCoordinator(),
    { now: eligibleClock }
  );
  const catalog = new StoryCatalog(fixture.dataDir, {
    recoverResidue: async (kind, storyId) => {
      assert.equal(kind, "reap");
      await recovery.reapIfEligible(storyId);
    }
  });
  t.after(() => catalog.dispose());
  const page = await catalog.listPage({ cursor: null, maxEntries: 64 });
  assert.deepEqual(page.items, []);
  await assert.rejects(access(fixture.residue), hasFsCode("ENOENT"));
  await assert.rejects(access(fixture.identity), hasFsCode("ENOENT"));
});

test("Q catalog skips an unresolved deleted story without failing its page", async (t) => {
  const fixture = await deletedFixture(t, true);
  const reaper = new StoryReaper(
    fixture.dataDir,
    createMutationCoordinator(),
    { now: eligibleClock }
  );
  const catalog = new StoryCatalog(fixture.dataDir, {
    reapDeleted: async (storyId) => await reaper.reapIfEligible(storyId)
  });
  t.after(() => catalog.dispose());
  const page = await catalog.listPage({ cursor: null, maxEntries: 64 });
  assert.deepEqual(page.items, []);
  await access(fixture.canonical);
});

async function deletedFixture(
  t: Pick<import("node:test").TestContext, "after">,
  unresolvedProvider = false
) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-q-reap-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const storiesDir = path.join(dataDir, "stories");
  const stories = new StoryStore(storiesDir);
  await stories.init();
  await stories.save(storyFixture());
  const manifestFile = path.join(storiesDir, STORY_ID, "manifest.json");
  const v5Hash = hashStoryV5ManifestBytes(await readFile(manifestFile));
  const mutations = new StoryMutationStore(
    stories,
    createMutationCoordinator(),
    dataDir,
    { now: () => new Date(DELETED_AT) }
  );
  await mutations.init();
  let expectedAggregateVersion:
    | { kind: "v5"; manifestHash: string }
    | { kind: "v6"; revision: string } = {
      kind: "v5",
      manifestHash: v5Hash
    };
  if (unresolvedProvider) {
    await assert.rejects(
      mutations.runProvider(
        {
          transportOperationId: "operation-provider",
          mutationId: PROVIDER_MUTATION_ID,
          fingerprint: "b".repeat(64),
          scope: `story:${STORY_ID}`,
          expectedAggregateVersion
        },
        "autonameStory",
        async (_stories, providerStarted) => {
          await providerStarted();
          throw new ProviderError("Provider reply lost", 500);
        },
        () => null
      ),
      (error: unknown) => error instanceof ProviderError
    );
    expectedAggregateVersion = {
      kind: "v6",
      revision: "00000000000000000002"
    };
  }
  await mutations.runDelete({
    transportOperationId: "operation-delete",
    mutationId: MUTATION_ID,
    fingerprint: FINGERPRINT,
    scope: `story:${STORY_ID}`,
    expectedAggregateVersion
  });
  return {
    dataDir,
    canonical: path.join(storiesDir, STORY_ID),
    residue: path.join(storiesDir, storyResidueNames(STORY_ID).reap),
    identity: path.join(
      storiesDir,
      storyResidueIdentityName("reap", STORY_ID)
    )
  };
}

function storyFixture(): Story {
  return {
    id: STORY_ID,
    title: "Deleted",
    createdAt: DELETED_AT,
    updatedAt: DELETED_AT,
    nodes: [],
    activeRootId: null,
    bookmarks: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: []
  };
}

function eligibleClock(): Date {
  return new Date(Date.parse(DELETED_AT) + STORY_REAP_RETENTION_MS);
}

function capitalize(value: string): string {
  return `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function hasFsCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && "code" in error && error.code === code;
}

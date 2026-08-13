/**
 * Durable mutation-layer Aside behavior: cleanup, busy, idempotency, crash, predecessor.
 */
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ServiceError } from "../server/errors.js";
import { StoryStore } from "../server/stories.js";
import { LEAF_OBJECT_KINDS } from "../server/story-objects.js";
import { liveObjectIds } from "../server/story-format-nodes.js";
import { parseStoryManifestBytes, STORY_SCHEMA_VERSION_V10 } from "../server/story-v6-codec.js";
import { createMutationCoordinator } from "../server/mutation-coordinator.js";
import { MutationLedgerStore } from "../server/mutation-ledger-store.js";
import {
  FINGERPRINT,
  FIXED_NOW,
  FOURTH_MUTATION_ID,
  MUTATION_ID,
  OTHER_FINGERPRINT,
  OTHER_MUTATION_ID,
  THIRD_MUTATION_ID,
  requestFor,
  setup,
  STORY_ID,
  storyFixture
} from "./story-mutation-fixtures.js";
import {
  commitAsideDocument,
  crashOnce,
  ensureRootPart,
  hasCode,
  InjectedStoryMutationCrash,
  seedAsideNote,
  StoryMutationStore
} from "./aside-test-helpers.js";

test("predecessor with asideActivation false refuses V10 mutation", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-aside-pred-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const storiesDir = path.join(dataDir, "stories");
  const writer = new StoryStore(storiesDir, { asideActivation: true });
  await writer.init();
  await writer.save(storyFixture());
  const ledger = new MutationLedgerStore(dataDir);
  const mutations = new StoryMutationStore(
    writer,
    createMutationCoordinator(),
    dataDir,
    { ledger, now: () => FIXED_NOW }
  );
  await mutations.init();
  await writer.mutate(STORY_ID, (story) => {
    story.nodes = [{
      id: "root",
      parentId: null,
      instruction: "",
      text: "Line.",
      model: "m",
      createdAt: FIXED_NOW.toISOString(),
      activeChildId: null
    }];
    story.activeRootId = "root";
  });
  const version = (await writer.loadVersioned(STORY_ID)).aggregateVersion!;
  const document = {
    schemaVersion: 1 as const,
    notes: [{ question: "Q?", answer: "A." }]
  };
  await mutations.runProviderOperation(
    requestFor(MUTATION_ID, FINGERPRINT, version),
    "askAside",
    commitAsideDocument(document)
  );
  const parsed = parseStoryManifestBytes(
    await readFile(path.join(storiesDir, STORY_ID, "manifest.json")),
    STORY_ID
  );
  assert.equal(parsed.kind, "v10-live");
  if (parsed.kind === "v10-live") {
    assert.equal(parsed.manifest.schemaVersion, STORY_SCHEMA_VERSION_V10);
  }

  const predecessor = new StoryStore(storiesDir, { asideActivation: false });
  await predecessor.init();
  // The predecessor keeps V10 read support while its Aside entry points stay
  // closed. It must open the durable story and object leaf after the receipt
  // committed the answer, even though it must refuse a new aggregate session.
  const predecessorStory = await predecessor.load(STORY_ID);
  assert.equal(typeof predecessorStory.asideDocumentId, "string");
  const predecessorAside = await predecessor.loadAsideDocument(STORY_ID);
  assert.equal(predecessorAside?.notes[0]?.answer, "A.");
  await assert.rejects(
    predecessor.withAggregateSession(STORY_ID, async () => undefined),
    hasCode("story_manifest_requires_successor")
  );
});

test("closed cleanup sets include the aside leaf kind and live document id", async (t) => {
  assert.ok(LEAF_OBJECT_KINDS.includes("aside"));
  const fixture = await setup(t, "1667-aside-live-ids-", {}, undefined, { asideActivation: true });
  await ensureRootPart(fixture.stories);
  const version = (await fixture.stories.loadVersioned(STORY_ID)).aggregateVersion!;
  const document = {
    schemaVersion: 1 as const,
    notes: [{ question: "Live?", answer: "Yes." }]
  };
  await fixture.mutations.runProviderOperation(
    requestFor(MUTATION_ID, FINGERPRINT, version),
    "askAside",
    commitAsideDocument(document)
  );
  const parsed = parseStoryManifestBytes(await readFile(fixture.manifestFile), STORY_ID);
  assert.equal(parsed.kind, "v10-live");
  if (parsed.kind !== "v10-live") return;
  const live = liveObjectIds(parsed.manifest.content);
  assert.deepEqual(Object.keys(live.leaves).sort(), [...LEAF_OBJECT_KINDS].sort());
  assert.equal(live.leaves.aside.length, 1);
  assert.equal(live.leaves.aside[0], parsed.manifest.content.asideDocumentId);
});

test("clearAside recovers after afterStage crash on the local durability tier", async (t) => {
  const fixture = await setup(t, "1667-aside-clear-crash-", {}, undefined, { asideActivation: true });
  const afterAsk = await seedAsideNote(fixture);
  await fixture.mutations.runLocal(
    {
      ...requestFor(OTHER_MUTATION_ID, OTHER_FINGERPRINT, afterAsk),
      durability: "manifest-only" as const
    },
    "renameStory",
    (story) => { story.title = "After Aside"; }
  );
  const version = (await fixture.stories.loadVersioned(STORY_ID)).aggregateVersion!;
  const crashing = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    { ledger: fixture.ledger, now: () => FIXED_NOW, hooks: crashOnce("afterStage") }
  );
  await crashing.init();
  const clearId = "m1.1767225600000.6123456789abcdef0123456789abcdef";
  await assert.rejects(
    crashing.runLocal(
      {
        ...requestFor(clearId, "c".repeat(64), version),
        durability: "manifest-only" as const
      },
      "clearAside",
      (story) => { story.asideDocumentId = null; }
    ),
    (error: unknown) => error instanceof InjectedStoryMutationCrash
  );
  assert.equal((await fixture.stories.loadAsideDocument(STORY_ID))?.notes.length, 1);
  const recovered = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    { ledger: fixture.ledger, now: () => FIXED_NOW }
  );
  await recovered.init();
  const retryVersion = (await fixture.stories.loadVersioned(STORY_ID)).aggregateVersion!;
  await recovered.runLocal(
    {
      ...requestFor(
        "m1.1767225600000.7123456789abcdef0123456789abcdef",
        "d".repeat(64),
        retryVersion
      ),
      durability: "manifest-only" as const
    },
    "clearAside",
    (story) => { story.asideDocumentId = null; }
  );
  assert.equal(await fixture.stories.loadAsideDocument(STORY_ID), null);

  const predecessor = new StoryStore(
    path.join(fixture.dataDir, "stories"),
    { asideActivation: false }
  );
  await predecessor.init();
  await assert.rejects(
    predecessor.withAggregateSession(STORY_ID, async () => undefined),
    hasCode("story_manifest_requires_successor")
  );
  const parsed = parseStoryManifestBytes(await readFile(fixture.manifestFile), STORY_ID);
  assert.equal(parsed.kind, "v10-live");
});

test("clearAside removes a prepared receipt when staging never materializes", async (t) => {
  const fixture = await setup(
    t,
    "1667-aside-clear-before-stage-failure-",
    {},
    undefined,
    { asideActivation: true }
  );
  const version = await seedAsideNote(fixture);
  const clearId = THIRD_MUTATION_ID;
  const clearFingerprint = "c".repeat(64);
  const crashing = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    {
      ledger: fixture.ledger,
      now: () => FIXED_NOW,
      hooks: {
        afterPreparedBeforeStage: () => {
          throw new Error("stage was not attempted");
        }
      }
    }
  );
  await crashing.init();
  await assert.rejects(
    crashing.runLocal(
      {
        ...requestFor(clearId, clearFingerprint, version),
        durability: "manifest-only" as const
      },
      "clearAside",
      (story) => { story.asideDocumentId = null; }
    ),
    /stage was not attempted/
  );
  assert.deepEqual(
    await fixture.ledger.loadStoryReceipt(`story:${STORY_ID}`, clearId),
    { started: null, prepared: null, completed: null, acknowledged: null }
  );
  await assert.rejects(() => access(`${fixture.manifestFile}.next`));
});

test("clearAside exact retry after a crash before staging removes the orphan receipt", async (t) => {
  const fixture = await setup(
    t,
    "1667-aside-clear-before-stage-crash-",
    {},
    undefined,
    { asideActivation: true }
  );
  const version = await seedAsideNote(fixture);
  const clearId = THIRD_MUTATION_ID;
  const clearFingerprint = "c".repeat(64);
  const crashing = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    {
      ledger: fixture.ledger,
      now: () => FIXED_NOW,
      hooks: crashOnce("afterPreparedBeforeStage")
    }
  );
  await crashing.init();
  await assert.rejects(
    crashing.runLocal(
      {
        ...requestFor(clearId, clearFingerprint, version),
        durability: "manifest-only" as const
      },
      "clearAside",
      (story) => { story.asideDocumentId = null; }
    ),
    (error: unknown) => error instanceof InjectedStoryMutationCrash
  );
  assert.notEqual(
    (await fixture.ledger.loadStoryReceipt(`story:${STORY_ID}`, clearId)).prepared,
    null
  );
  await assert.rejects(() => access(`${fixture.manifestFile}.next`));

  const restartedStories = new StoryStore(
    path.join(fixture.dataDir, "stories"),
    { asideActivation: true }
  );
  await restartedStories.init();
  const restarted = new StoryMutationStore(
    restartedStories,
    createMutationCoordinator(),
    fixture.dataDir,
    { ledger: fixture.ledger, now: () => FIXED_NOW }
  );
  await restarted.init();
  await restarted.runLocal(
    {
      ...requestFor(clearId, clearFingerprint, version),
      durability: "manifest-only" as const
    },
    "clearAside",
    (story) => { story.asideDocumentId = null; }
  );
  const receipt = await fixture.ledger.loadStoryReceipt(
    `story:${STORY_ID}`,
    clearId
  );
  assert.equal(receipt.started, null);
  assert.notEqual(receipt.prepared, null);
  assert.notEqual(receipt.completed, null);
  await assert.rejects(() => access(`${fixture.manifestFile}.next`));
  assert.equal(await restartedStories.loadAsideDocument(STORY_ID), null);
});

test("a new Clear after restart removes a no-stage prepared receipt", async (t) => {
  const fixture = await setup(
    t,
    "1667-aside-clear-before-stage-restart-",
    {},
    undefined,
    { asideActivation: true }
  );
  const version = await seedAsideNote(fixture);
  const abandonedId = THIRD_MUTATION_ID;
  const abandonedFingerprint = "c".repeat(64);
  const crashing = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    {
      ledger: fixture.ledger,
      now: () => FIXED_NOW,
      hooks: crashOnce("afterPreparedBeforeStage")
    }
  );
  await crashing.init();
  await assert.rejects(
    crashing.runLocal(
      {
        ...requestFor(abandonedId, abandonedFingerprint, version),
        durability: "manifest-only" as const
      },
      "clearAside",
      (story) => { story.asideDocumentId = null; }
    ),
    (error: unknown) => error instanceof InjectedStoryMutationCrash
  );
  assert.notEqual(
    (await fixture.ledger.loadStoryReceipt(`story:${STORY_ID}`, abandonedId)).prepared,
    null
  );
  await assert.rejects(() => access(`${fixture.manifestFile}.next`));

  const restartedStories = new StoryStore(
    path.join(fixture.dataDir, "stories"),
    { asideActivation: true }
  );
  await restartedStories.init();
  const restarted = new StoryMutationStore(
    restartedStories,
    createMutationCoordinator(),
    fixture.dataDir,
    { ledger: fixture.ledger, now: () => FIXED_NOW }
  );
  await restarted.init();
  const successorId = FOURTH_MUTATION_ID;
  await restarted.runLocal(
    {
      ...requestFor(successorId, FINGERPRINT, version),
      durability: "manifest-only" as const
    },
    "clearAside",
    (story) => { story.asideDocumentId = null; }
  );
  assert.deepEqual(
    await fixture.ledger.loadStoryReceipt(`story:${STORY_ID}`, abandonedId),
    { started: null, prepared: null, completed: null, acknowledged: null }
  );
  const successorReceipt = await fixture.ledger.loadStoryReceipt(
    `story:${STORY_ID}`,
    successorId
  );
  assert.notEqual(successorReceipt.prepared, null);
  assert.notEqual(successorReceipt.completed, null);
  await assert.rejects(() => access(`${fixture.manifestFile}.next`));
  assert.equal(await restartedStories.loadAsideDocument(STORY_ID), null);
});

test("a later Clear removes the prepared receipt for its discarded exact Clear stage", async (t) => {
  const fixture = await setup(
    t,
    "1667-aside-clear-orphan-stage-",
    {},
    undefined,
    { asideActivation: true }
  );
  const version = await seedAsideNote(fixture);
  const abandonedId = THIRD_MUTATION_ID;
  const abandonedFingerprint = "c".repeat(64);
  const abandoned = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    {
      ledger: fixture.ledger,
      now: () => FIXED_NOW,
      hooks: crashOnce("afterStage")
    }
  );
  await abandoned.init();
  await assert.rejects(
    abandoned.runLocal(
      {
        ...requestFor(abandonedId, abandonedFingerprint, version),
        durability: "manifest-only" as const
      },
      "clearAside",
      (story) => { story.asideDocumentId = null; }
    ),
    (error: unknown) => error instanceof InjectedStoryMutationCrash
  );
  assert.notEqual(
    (await fixture.ledger.loadStoryReceipt(`story:${STORY_ID}`, abandonedId)).prepared,
    null
  );
  await access(`${fixture.manifestFile}.next`);

  const successorId = FOURTH_MUTATION_ID;
  const successorFingerprint = FINGERPRINT;
  await fixture.mutations.runLocal(
    {
      ...requestFor(successorId, successorFingerprint, version),
      durability: "manifest-only" as const
    },
    "clearAside",
    (story) => { story.asideDocumentId = null; }
  );
  assert.deepEqual(
    await fixture.ledger.loadStoryReceipt(`story:${STORY_ID}`, abandonedId),
    { started: null, prepared: null, completed: null, acknowledged: null }
  );
  const successorReceipt = await fixture.ledger.loadStoryReceipt(
    `story:${STORY_ID}`,
    successorId
  );
  assert.notEqual(successorReceipt.prepared, null);
  assert.notEqual(successorReceipt.completed, null);
  await assert.rejects(() => access(`${fixture.manifestFile}.next`));
  assert.equal(await fixture.stories.loadAsideDocument(STORY_ID), null);
});

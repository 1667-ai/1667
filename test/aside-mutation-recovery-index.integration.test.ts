/** Clear recovery stays bounded when one story retains heavy mutation history. */
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createMutationCoordinator } from "../server/mutation-coordinator.js";
import { hashPreparedMutationRecord } from "../server/mutation-ledger-codec.js";
import { MutationLedgerStore } from "../server/mutation-ledger-store.js";
import type {
  MutationId,
  MutationLedgerRecord,
  PreparedUserMutationRecord
} from "../server/mutation-ledger-types.js";
import { STORY_UNCHANGED, StoryStore } from "../server/stories.js";
import {
  FINGERPRINT,
  FIXED_NOW,
  FOURTH_MUTATION_ID,
  OTHER_FINGERPRINT,
  OTHER_MUTATION_ID,
  providerOperation,
  requestFor,
  setup,
  STORY_ID,
  THIRD_MUTATION_ID
} from "./story-mutation-fixtures.js";
import {
  crashOnce,
  InjectedStoryMutationCrash,
  seedAsideNote,
  StoryMutationStore
} from "./aside-test-helpers.js";

class CrashAfterClearCandidateLedger extends MutationLedgerStore {
  private crashed = false;

  override async writeStoryRecord(record: MutationLedgerRecord): Promise<void> {
    if (!this.crashed && record.kind === "prepared" && record.key === THIRD_MUTATION_ID) {
      this.crashed = true;
      throw new InjectedStoryMutationCrash("afterClearRecoveryCandidate");
    }
    await super.writeStoryRecord(record);
  }
}

test("clearAside exact retry removes a candidate with no prepared receipt", async (t) => {
  const fixture = await setup(
    t,
    "1667-aside-clear-candidate-only-",
    {},
    undefined,
    { asideActivation: true }
  );
  const version = await seedAsideNote(fixture);
  const crashingLedger = new CrashAfterClearCandidateLedger(fixture.dataDir);
  await crashingLedger.init();
  const crashing = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    { ledger: crashingLedger, now: () => FIXED_NOW }
  );
  await crashing.init();
  const request = {
    ...requestFor(THIRD_MUTATION_ID, "c".repeat(64), version),
    durability: "manifest-only" as const
  };
  await assert.rejects(
    crashing.runLocal(
      request,
      "clearAside",
      (story) => { story.asideDocumentId = null; }
    ),
    (error: unknown) => error instanceof InjectedStoryMutationCrash
  );
  assert.deepEqual(
    await fixture.ledger.loadStoryReceipt(`story:${STORY_ID}`, THIRD_MUTATION_ID),
    { started: null, prepared: null, completed: null, acknowledged: null }
  );

  const restarted = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    { ledger: fixture.ledger, now: () => FIXED_NOW }
  );
  await restarted.init();
  await restarted.runLocal(
    request,
    "clearAside",
    (story) => { story.asideDocumentId = null; }
  );
  assert.notEqual(
    (await fixture.ledger.loadStoryReceipt(`story:${STORY_ID}`, THIRD_MUTATION_ID)).completed,
    null
  );
  assert.equal(await fixture.stories.loadAsideDocument(STORY_ID), null);
});

test("repeated Clear on an empty Aside stores bounded replay evidence", async (t) => {
  const fixture = await setup(
    t,
    "1667-aside-clear-no-op-",
    {},
    undefined,
    { asideActivation: true }
  );
  const version = await seedAsideNote(fixture);
  const firstClear = await fixture.mutations.runLocal(
    {
      ...requestFor(OTHER_MUTATION_ID, OTHER_FINGERPRINT, version),
      durability: "manifest-only" as const
    },
    "clearAside",
    (story) => {
      if (story.asideDocumentId === null) return STORY_UNCHANGED;
      story.asideDocumentId = null;
    }
  );

  const repeated = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    {
      ledger: fixture.ledger,
      now: () => FIXED_NOW
    }
  );
  await repeated.init();
  const firstRepeat = await repeated.runLocal(
    {
      ...requestFor(THIRD_MUTATION_ID, "c".repeat(64), firstClear.aggregateVersion),
      durability: "manifest-only" as const
    },
    "clearAside",
    () => STORY_UNCHANGED
  );
  const secondRepeat = await repeated.runLocal(
    {
      ...requestFor(FOURTH_MUTATION_ID, FINGERPRINT, firstRepeat.aggregateVersion),
      durability: "manifest-only" as const
    },
    "clearAside",
    () => STORY_UNCHANGED
  );

  for (const mutationId of [THIRD_MUTATION_ID, FOURTH_MUTATION_ID] as const) {
    assert.notEqual(
      (await fixture.ledger.loadStoryReceipt(`story:${STORY_ID}`, mutationId)).completed,
      null
    );
  }
  assert.deepEqual(secondRepeat.aggregateVersion, firstRepeat.aggregateVersion);
  assert.equal(await fixture.stories.loadAsideDocument(STORY_ID), null);
});

test("no-op Clear replays after terminal crash and preserves a later Side Note", async (t) => {
  const fixture = await setup(
    t,
    "1667-aside-clear-no-op-replay-",
    {},
    undefined,
    { asideActivation: true }
  );
  const version = await seedAsideNote(fixture);
  const firstClear = await fixture.mutations.runLocal(
    {
      ...requestFor(OTHER_MUTATION_ID, OTHER_FINGERPRINT, version),
      durability: "manifest-only" as const
    },
    "clearAside",
    (story) => { story.asideDocumentId = null; }
  );
  const retryRequest = {
    ...requestFor(THIRD_MUTATION_ID, "c".repeat(64), firstClear.aggregateVersion),
    durability: "manifest-only" as const
  };
  const crashing = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    {
      ledger: fixture.ledger,
      now: () => FIXED_NOW,
      hooks: {
        afterPrepared: () => {
          throw new InjectedStoryMutationCrash("afterPrepared");
        }
      }
    }
  );
  await crashing.init();
  await assert.rejects(
    crashing.runLocal(
      retryRequest,
      "clearAside",
      () => STORY_UNCHANGED
    ),
    (error: unknown) => error instanceof InjectedStoryMutationCrash
  );
  assert.notEqual(
    (await fixture.ledger.loadStoryReceipt(`story:${STORY_ID}`, THIRD_MUTATION_ID)).prepared,
    null
  );
  assert.equal(
    (await fixture.ledger.loadStoryReceipt(`story:${STORY_ID}`, THIRD_MUTATION_ID)).completed,
    null
  );

  const laterDocument = {
    schemaVersion: 1 as const,
    notes: [{ question: "Later?", answer: "Still here." }]
  };
  const laterVersion = (await fixture.stories.loadVersioned(STORY_ID)).aggregateVersion!;
  await fixture.mutations.runProviderOperation(
    requestFor(FOURTH_MUTATION_ID, FINGERPRINT, laterVersion),
    "askAside",
    providerOperation(
      async (stories, start) => {
        await start();
        await stories.commitProviderEffect(STORY_ID, {
          kind: "aside",
          expectedAsideDocumentId: null,
          document: laterDocument
        });
        return laterDocument;
      },
      () => laterDocument
    )
  );
  assert.deepEqual(
    await fixture.stories.loadAsideDocument(STORY_ID),
    laterDocument
  );

  const restarted = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    { ledger: fixture.ledger, now: () => FIXED_NOW }
  );
  await restarted.init();
  const replay = await restarted.runLocal(
    retryRequest,
    "clearAside",
    () => { throw new Error("exact terminal replay must not run Clear"); }
  );
  assert.deepEqual(
    await fixture.stories.loadAsideDocument(STORY_ID),
    laterDocument
  );
  assert.equal(replay.story.asideDocumentId !== null, true);
});

test("Clear recovery ignores more than 256 unrelated retained story receipts", async (t) => {
  const fixture = await setup(
    t,
    "1667-aside-clear-index-",
    {},
    undefined,
    { asideActivation: true }
  );
  const version = await seedAsideNote(fixture);
  const snapshot = await fixture.stories.withAggregateSession(
    STORY_ID,
    async (session) => session.snapshot
  );
  const aggregateKey = `story:${STORY_ID}` as const;
  const summary = snapshot.manifest.kind === "live" ? snapshot.manifest.summary : null;

  for (let index = 0; index < 257; index += 1) {
    const mutationId = `m1.1767225600000.${index.toString(16).padStart(32, "0")}` as MutationId;
    const prepared: PreparedUserMutationRecord = {
      schema: 1,
      kind: "prepared",
      purpose: "mutation",
      aggregateKey,
      key: mutationId,
      fingerprintHash: index.toString(16).padStart(64, "0"),
      method: "renameStory",
      oldStateHash: snapshot.manifestHash,
      newStateHash: snapshot.manifestHash,
      startedRecordHash: null,
      result: {
        kind: "story",
        storyId: STORY_ID,
        storyRevision: snapshot.manifest.revision,
        summary
      },
      preparedAt: FIXED_NOW.toISOString()
    };
    await fixture.ledger.writeStoryRecord(prepared);
    await fixture.ledger.writeStoryRecord({
      schema: 1,
      kind: "completed",
      aggregateKey,
      key: mutationId,
      preparedRecordHash: hashPreparedMutationRecord(prepared),
      completedAt: FIXED_NOW.toISOString()
    });
  }

  const crashing = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    { ledger: fixture.ledger, now: () => FIXED_NOW, hooks: crashOnce("afterPreparedBeforeStage") }
  );
  await crashing.init();
  await assert.rejects(
    crashing.runLocal(
      { ...requestFor(THIRD_MUTATION_ID, "c".repeat(64), version), durability: "manifest-only" as const },
      "clearAside",
      (story) => { story.asideDocumentId = null; }
    ),
    (error: unknown) => error instanceof InjectedStoryMutationCrash
  );

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
  const retryVersion = (await restartedStories.loadVersioned(STORY_ID)).aggregateVersion!;
  await restarted.runLocal(
    { ...requestFor(FOURTH_MUTATION_ID, FINGERPRINT, retryVersion), durability: "manifest-only" as const },
    "clearAside",
    (story) => { story.asideDocumentId = null; }
  );

  assert.deepEqual(
    await fixture.ledger.loadStoryReceipt(aggregateKey, THIRD_MUTATION_ID),
    { started: null, prepared: null, completed: null, acknowledged: null }
  );
  const successor = await fixture.ledger.loadStoryReceipt(aggregateKey, FOURTH_MUTATION_ID);
  assert.notEqual(successor.completed, null);
  await assert.rejects(() => access(`${fixture.manifestFile}.next`));
  assert.equal(await restartedStories.loadAsideDocument(STORY_ID), null);
});

test("a completed Clear candidate survives a crash before index cleanup", async (t) => {
  const fixture = await setup(
    t,
    "1667-aside-clear-index-completed-",
    {},
    undefined,
    { asideActivation: true }
  );
  const version = await seedAsideNote(fixture);
  const crashing = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    {
      ledger: fixture.ledger,
      now: () => FIXED_NOW,
      hooks: {
        afterCompleted: () => {
          throw new InjectedStoryMutationCrash("afterCompleted");
        }
      }
    }
  );
  await crashing.init();
  await assert.rejects(
    crashing.runLocal(
      { ...requestFor(THIRD_MUTATION_ID, "c".repeat(64), version), durability: "manifest-only" as const },
      "clearAside",
      (story) => { story.asideDocumentId = null; }
    ),
    (error: unknown) => error instanceof InjectedStoryMutationCrash
  );
  assert.notEqual(
    (await fixture.ledger.loadStoryReceipt(`story:${STORY_ID}`, THIRD_MUTATION_ID)).completed,
    null
  );

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
  const retryVersion = (await restartedStories.loadVersioned(STORY_ID)).aggregateVersion!;
  await restarted.runLocal(
    { ...requestFor(FOURTH_MUTATION_ID, FINGERPRINT, retryVersion), durability: "manifest-only" as const },
    "clearAside",
    (story) => { story.asideDocumentId = null; }
  );
  assert.notEqual(
    (await fixture.ledger.loadStoryReceipt(`story:${STORY_ID}`, FOURTH_MUTATION_ID)).completed,
    null
  );
  assert.equal(await restartedStories.loadAsideDocument(STORY_ID), null);
});

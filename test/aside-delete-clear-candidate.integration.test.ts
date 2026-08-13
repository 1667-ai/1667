import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createMutationCoordinator } from "../server/mutation-coordinator.js";
import { MUTATION_LEDGER_DIRECTORY, storyLedgerToken } from "../server/mutation-ledger-paths.js";
import { StoryMutationStore } from "../server/story-mutation-store.js";
import {
  STORY_REAP_RETENTION_MS,
  StoryReaper
} from "../server/story-reaper.js";
import { StoryStore } from "../server/stories.js";
import {
  FIXED_NOW,
  FINGERPRINT,
  FOURTH_MUTATION_ID,
  requestFor,
  setup,
  STORY_ID,
  THIRD_MUTATION_ID
} from "./story-mutation-fixtures.js";
import {
  crashOnce,
  InjectedStoryMutationCrash,
  seedAsideNote
} from "./aside-test-helpers.js";

test("delete reconciles an orphan Clear candidate before reap", async (t) => {
  const fixture = await setup(
    t,
    "1667-aside-delete-clear-candidate-",
    {},
    undefined,
    { asideActivation: true }
  );
  const version = await seedAsideNote(fixture);
  const clearRequest = {
    ...requestFor(THIRD_MUTATION_ID, "c".repeat(64), version),
    durability: "manifest-only" as const
  };
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
      clearRequest,
      "clearAside",
      (story) => { story.asideDocumentId = null; }
    ),
    (error: unknown) => error instanceof InjectedStoryMutationCrash
  );

  const aggregateKey = `story:${STORY_ID}` as const;
  const candidatePath = path.join(
    fixture.dataDir,
    MUTATION_LEDGER_DIRECTORY,
    "stories",
    storyLedgerToken(STORY_ID),
    "clear-recovery",
    "candidate.json"
  );
  assert.notEqual(
    (await fixture.ledger.loadStoryReceipt(aggregateKey, THIRD_MUTATION_ID)).prepared,
    null
  );
  await access(candidatePath);

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
  const deleteVersion = (await restartedStories.loadVersioned(STORY_ID)).aggregateVersion;
  assert.ok(deleteVersion);
  await restarted.runDelete(
    requestFor(FOURTH_MUTATION_ID, FINGERPRINT, deleteVersion)
  );

  assert.deepEqual(
    await fixture.ledger.loadStoryReceipt(aggregateKey, THIRD_MUTATION_ID),
    { started: null, prepared: null, completed: null, acknowledged: null }
  );
  await assert.rejects(access(candidatePath));

  const reaper = new StoryReaper(
    fixture.dataDir,
    createMutationCoordinator(),
    { now: () => new Date(FIXED_NOW.getTime() + STORY_REAP_RETENTION_MS) }
  );
  assert.equal(await reaper.reapIfEligible(STORY_ID), true);
  await assert.rejects(access(candidatePath));
  assert.deepEqual(
    await fixture.ledger.loadStoryReceipt(aggregateKey, THIRD_MUTATION_ID),
    { started: null, prepared: null, completed: null, acknowledged: null }
  );
});

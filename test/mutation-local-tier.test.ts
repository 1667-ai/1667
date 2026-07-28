import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createMutationCoordinator } from "../server/mutation-coordinator.js";
import { ServiceError } from "../server/errors.js";
import {
  InjectedStoryMutationCrash,
  StoryMutationStore,
  type StoryMutationStoreHooks
} from "../server/story-mutation-store.js";
import { parseStoryManifestBytes } from "../server/story-v6-codec.js";
import { STORY_UNCHANGED } from "../server/stories.js";
import {
  ACK_MUTATION_ID,
  FIXED_NOW,
  FOURTH_MUTATION_ID,
  hasServiceError,
  MUTATION_ID,
  OTHER_FINGERPRINT,
  OTHER_MUTATION_ID,
  request,
  requestFor,
  setup,
  STORY_ID,
  THIRD_MUTATION_ID
} from "./story-mutation-fixtures.js";

const SCOPE = `story:${STORY_ID}` as const;
const EMPTY_RECEIPT = {
  started: null,
  prepared: null,
  completed: null,
  acknowledged: null
};

function manifestOnly<T extends object>(value: T): T & { durability: "manifest-only" } {
  return { ...value, durability: "manifest-only" };
}

async function assertNoLedgerEntries(dataDir: string): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await readdir(path.join(dataDir, "mutation-ledger"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  assert.deepEqual(entries, []);
}

function crashOnce(
  point: "afterStage" | "afterPrepared" | "afterPublish"
): StoryMutationStoreHooks {
  let injected = false;
  return {
    [point]: () => {
      if (injected) return;
      injected = true;
      throw new InjectedStoryMutationCrash(point);
    }
  };
}

test("local tier commits through one manifest publish without receipt or ledger artifacts", async (t) => {
  const fixture = await setup(t, "1667-local-tier-commit-");
  let calls = 0;
  const committed = await fixture.mutations.runLocal(
    manifestOnly(request(fixture.v5Hash)),
    "renameStory",
    (story) => {
      calls += 1;
      story.title = "Renamed locally";
    }
  );
  assert.equal(calls, 1);
  assert.equal(committed.story.title, "Renamed locally");
  assert.equal(committed.result.storyRevision, "00000000000000000002");
  assert.deepEqual(committed.aggregateVersion, {
    kind: "v6",
    revision: "00000000000000000002"
  });

  const parsed = parseStoryManifestBytes(
    await readFile(fixture.manifestFile),
    STORY_ID
  );
  assert.equal(parsed.kind, "v6-live");
  if (parsed.kind !== "v6-live") assert.fail("Expected live V6");
  assert.equal(parsed.manifest.revision, "00000000000000000002");
  assert.equal(parsed.manifest.previousManifestHash, fixture.v5Hash);
  // The publish is the only durable evidence: no transaction pointer remains.
  assert.equal(parsed.manifest.lastTransaction, null);

  assert.deepEqual(
    await fixture.ledger.loadStoryReceipt(SCOPE, MUTATION_ID),
    EMPTY_RECEIPT
  );
  await assertNoLedgerEntries(fixture.dataDir);
});

test("local tier keeps the aggregate-version conflict fence", async (t) => {
  const fixture = await setup(t, "1667-local-tier-conflict-");
  await fixture.mutations.runLocal(
    manifestOnly(request(fixture.v5Hash)),
    "renameStory",
    (story) => { story.title = "First"; }
  );
  let called = false;
  await assert.rejects(
    fixture.mutations.runLocal(
      manifestOnly(requestFor(OTHER_MUTATION_ID, OTHER_FINGERPRINT, {
        kind: "v5",
        manifestHash: fixture.v5Hash
      })),
      "renameStory",
      () => { called = true; }
    ),
    hasServiceError("revision_conflict")
  );
  assert.equal(called, false);
});

test("local tier returns unchanged state without publishing a revision or any record", async (t) => {
  const fixture = await setup(t, "1667-local-tier-unchanged-");
  const noop = await fixture.mutations.runLocal(
    manifestOnly(request(fixture.v5Hash)),
    "renameStory",
    () => STORY_UNCHANGED
  );
  assert.equal(noop.result.storyRevision, "00000000000000000001");
  assert.deepEqual(noop.aggregateVersion, {
    kind: "v5",
    manifestHash: fixture.v5Hash
  });
  assert.deepEqual(
    await fixture.ledger.loadStoryReceipt(SCOPE, MUTATION_ID),
    EMPTY_RECEIPT
  );
  await assertNoLedgerEntries(fixture.dataDir);
});

test("local tier torn publish loses only the mutation and leaves the store clean", async (t) => {
  const fixture = await setup(t, "1667-local-tier-torn-", crashOnce("afterStage"));
  await assert.rejects(
    fixture.mutations.runLocal(
      manifestOnly(request(fixture.v5Hash)),
      "renameStory",
      (story) => { story.title = "Lost keypress"; }
    ),
    (error: unknown) => error instanceof InjectedStoryMutationCrash
  );

  // The staged replacement is the only residue of the crash.
  await access(`${fixture.manifestFile}.next`);
  assert.equal(
    parseStoryManifestBytes(await readFile(fixture.manifestFile), STORY_ID).kind,
    "v5"
  );

  // A replacement process loads the story cleanly and the mutation is gone.
  const recovered = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    { ledger: fixture.ledger, now: () => FIXED_NOW }
  );
  await recovered.init();
  const loaded = await fixture.stories.loadVersioned(STORY_ID);
  assert.equal(loaded.story.title, "Original");

  // The next mutation discards the torn stage, then commits normally.
  const committed = await recovered.runLocal(
    manifestOnly(requestFor(OTHER_MUTATION_ID, OTHER_FINGERPRINT, loaded.aggregateVersion!)),
    "renameStory",
    (story) => { story.title = "After recovery"; }
  );
  assert.equal(committed.story.title, "After recovery");
  assert.equal(committed.result.storyRevision, "00000000000000000002");
  await assert.rejects(access(`${fixture.manifestFile}.next`), hasFsCode("ENOENT"));

  // Neither the lost mutation nor the retry left receipt or ledger artifacts.
  assert.deepEqual(await fixture.ledger.loadStoryReceipt(SCOPE, MUTATION_ID), EMPTY_RECEIPT);
  assert.deepEqual(await fixture.ledger.loadStoryReceipt(SCOPE, OTHER_MUTATION_ID), EMPTY_RECEIPT);
  await assertNoLedgerEntries(fixture.dataDir);
});

test("local tier crash after publish keeps the committed aggregate with no artifacts", async (t) => {
  const fixture = await setup(t, "1667-local-tier-post-publish-", crashOnce("afterPublish"));
  await assert.rejects(
    fixture.mutations.runLocal(
      manifestOnly(request(fixture.v5Hash)),
      "renameStory",
      (story) => { story.title = "Committed before crash"; }
    ),
    (error: unknown) => error instanceof InjectedStoryMutationCrash
  );
  const recovered = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    { ledger: fixture.ledger, now: () => FIXED_NOW }
  );
  await recovered.init();
  const loaded = await fixture.stories.loadVersioned(STORY_ID);
  assert.equal(loaded.story.title, "Committed before crash");
  assert.deepEqual(loaded.aggregateVersion, {
    kind: "v6",
    revision: "00000000000000000002"
  });
  await assert.rejects(access(`${fixture.manifestFile}.next`), hasFsCode("ENOENT"));
  assert.deepEqual(await fixture.ledger.loadStoryReceipt(SCOPE, MUTATION_ID), EMPTY_RECEIPT);
  await assertNoLedgerEntries(fixture.dataDir);
});

test("local tier finalizes a prior full-tier transaction before committing", async (t) => {
  // Full-tier mutation crashes between publish and its completed record.
  const fixture = await setup(t, "1667-local-tier-finalize-", crashOnce("afterPublish"));
  await assert.rejects(
    fixture.mutations.runLocal(
      request(fixture.v5Hash),
      "renameStory",
      (story) => { story.title = "Full tier committed"; }
    ),
    (error: unknown) => error instanceof InjectedStoryMutationCrash
  );
  assert.equal(
    (await fixture.ledger.loadStoryReceipt(SCOPE, MUTATION_ID)).completed,
    null
  );

  const recovered = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    { ledger: fixture.ledger, now: () => FIXED_NOW }
  );
  await recovered.init();
  const current = await fixture.stories.loadVersioned(STORY_ID);
  const committed = await recovered.runLocal(
    manifestOnly(requestFor(OTHER_MUTATION_ID, OTHER_FINGERPRINT, current.aggregateVersion!)),
    "renameStory",
    (story) => { story.title = "Local after full"; }
  );
  assert.equal(committed.story.title, "Local after full");

  // The interrupted full-tier receipt now has terminal evidence, and the
  // local-tier commit itself added none.
  const finalized = await fixture.ledger.loadStoryReceipt(SCOPE, MUTATION_ID);
  assert.notEqual(finalized.prepared, null);
  assert.notEqual(finalized.completed, null);
  assert.deepEqual(await fixture.ledger.loadStoryReceipt(SCOPE, OTHER_MUTATION_ID), EMPTY_RECEIPT);
  const parsed = parseStoryManifestBytes(await readFile(fixture.manifestFile), STORY_ID);
  if (parsed.kind !== "v6-live") assert.fail("Expected live V6");
  assert.equal(parsed.manifest.lastTransaction, null);
});

test("a marked request with full-tier evidence replays through the full tier after a post-publish crash", async (t) => {
  // Old-build shape: the full pipeline crashed between the publish and its
  // completed record. A cross-build replay may arrive carrying the marker;
  // evidence must win over the marker.
  const fixture = await setup(t, "1667-local-tier-marked-published-", crashOnce("afterPublish"));
  await assert.rejects(
    fixture.mutations.runLocal(
      request(fixture.v5Hash),
      "renameStory",
      (story) => { story.title = "Committed by the full tier"; }
    ),
    (error: unknown) => error instanceof InjectedStoryMutationCrash
  );

  const recovered = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    { ledger: fixture.ledger, now: () => FIXED_NOW }
  );
  await recovered.init();
  const replay = await recovered.runLocal(
    manifestOnly(request(fixture.v5Hash)),
    "renameStory",
    () => assert.fail("a recorded mutation must not re-execute on the local tier")
  );
  assert.equal(replay.story.title, "Committed by the full tier");
  const receipt = await fixture.ledger.loadStoryReceipt(SCOPE, MUTATION_ID);
  assert.notEqual(receipt.prepared, null);
  assert.notEqual(receipt.completed, null);
});

test("a marked request with full-tier evidence recovers through the full tier after a post-preparation crash", async (t) => {
  const fixture = await setup(t, "1667-local-tier-marked-prepared-", crashOnce("afterPrepared"));
  await assert.rejects(
    fixture.mutations.runLocal(
      request(fixture.v5Hash),
      "renameStory",
      (story) => { story.title = "Prepared but unpublished"; }
    ),
    (error: unknown) => error instanceof InjectedStoryMutationCrash
  );
  await access(`${fixture.manifestFile}.next`);
  assert.notEqual(
    (await fixture.ledger.loadStoryReceipt(SCOPE, MUTATION_ID)).prepared,
    null
  );

  const recovered = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    { ledger: fixture.ledger, now: () => FIXED_NOW }
  );
  await recovered.init();
  const replay = await recovered.runLocal(
    manifestOnly(request(fixture.v5Hash)),
    "renameStory",
    (story) => { story.title = "Prepared but unpublished"; }
  );
  assert.equal(replay.story.title, "Prepared but unpublished");
  assert.equal(replay.result.storyRevision, "00000000000000000002");

  // The staged manifest and its prepared record were retired together, then
  // the re-execution committed with complete full-tier evidence: no stranded
  // prepared record and no half-discarded transaction remain.
  await assert.rejects(access(`${fixture.manifestFile}.next`), hasFsCode("ENOENT"));
  const receipt = await fixture.ledger.loadStoryReceipt(SCOPE, MUTATION_ID);
  assert.notEqual(receipt.prepared, null);
  assert.notEqual(receipt.completed, null);
  const parsed = parseStoryManifestBytes(await readFile(fixture.manifestFile), STORY_ID);
  if (parsed.kind !== "v6-live") assert.fail("Expected live V6");
  assert.equal(parsed.manifest.lastTransaction?.mutationId, MUTATION_ID);
});

test("mixed local/provider sequence recovers at every crash boundary", async (t) => {
  const fixture = await setup(t, "1667-local-tier-mixed-");

  // Boundary 1: local mutation crashes mid-publish and is lost.
  const crashingFirst = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    { ledger: fixture.ledger, now: () => FIXED_NOW, hooks: crashOnce("afterStage") }
  );
  await crashingFirst.init();
  await assert.rejects(
    crashingFirst.runLocal(
      manifestOnly(request(fixture.v5Hash)),
      "renameStory",
      (story) => { story.title = "Lost local"; }
    ),
    (error: unknown) => error instanceof InjectedStoryMutationCrash
  );

  // Recovery: retry with a fresh identity commits.
  const afterFirst = await fixture.mutations.runLocal(
    manifestOnly(requestFor(OTHER_MUTATION_ID, OTHER_FINGERPRINT, {
      kind: "v5",
      manifestHash: fixture.v5Hash
    })),
    "renameStory",
    (story) => { story.title = "Local one"; }
  );
  assert.equal(afterFirst.result.storyRevision, "00000000000000000002");

  // Boundary 2: provider mutation loses its transport mid-generation. The
  // full pipeline retains the durable start and the unknown-outcome fence.
  await assert.rejects(
    fixture.mutations.runProvider(
      requestFor(THIRD_MUTATION_ID, "c".repeat(64), afterFirst.aggregateVersion),
      "autonameStory",
      async (_stories, providerStarted) => {
        await providerStarted();
        throw new ServiceError(503, "Provider reply was lost", "internal");
      },
      () => null
    ),
    hasServiceError("internal")
  );
  const fenced = await fixture.ledger.loadStoryReceipt(SCOPE, THIRD_MUTATION_ID);
  assert.notEqual(fenced.started, null);
  assert.deepEqual(
    await fixture.mutations.getUnknownOutcomeStatus(STORY_ID, THIRD_MUTATION_ID),
    {
      state: "pending",
      pendingProviderMutationId: THIRD_MUTATION_ID,
      deleted: false,
      aggregateVersion: { kind: "v6", revision: "00000000000000000003" }
    }
  );

  // Boundary 3: a local mutation crashes while the provider fence is up.
  const crashingThird = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    { ledger: fixture.ledger, now: () => FIXED_NOW, hooks: crashOnce("afterStage") }
  );
  await crashingThird.init();
  const beforeThird = await fixture.stories.loadVersioned(STORY_ID);
  await assert.rejects(
    crashingThird.runLocal(
      manifestOnly(requestFor(FOURTH_MUTATION_ID, "d".repeat(64), beforeThird.aggregateVersion!)),
      "renameStory",
      (story) => { story.title = "Lost behind fence"; }
    ),
    (error: unknown) => error instanceof InjectedStoryMutationCrash
  );

  // The fence and the aggregate survive the torn local publish.
  const recovered = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    { ledger: fixture.ledger, now: () => FIXED_NOW }
  );
  await recovered.init();
  assert.equal(
    (await fixture.mutations.getUnknownOutcomeStatus(STORY_ID, THIRD_MUTATION_ID)).state,
    "pending"
  );
  const afterCrash = await fixture.stories.loadVersioned(STORY_ID);
  assert.equal(afterCrash.story.title, "Local one");

  // Retry commits around the fence and preserves it.
  const localBehindFence = await recovered.runLocal(
    manifestOnly(requestFor(FOURTH_MUTATION_ID, "d".repeat(64), afterCrash.aggregateVersion!)),
    "renameStory",
    (story) => { story.title = "Local behind fence"; }
  );
  assert.equal(localBehindFence.result.storyRevision, "00000000000000000004");
  const persisted = parseStoryManifestBytes(await readFile(fixture.manifestFile), STORY_ID);
  if (persisted.kind !== "v6-live") assert.fail("Expected live V6");
  assert.equal(persisted.manifest.unresolvedProvider?.mutationId, THIRD_MUTATION_ID);
  assert.equal(persisted.manifest.lastTransaction, null);

  // Acknowledgement still terminalizes both provider receipts afterward.
  const acknowledged = await recovered.runAcknowledge(
    requestFor(ACK_MUTATION_ID, "e".repeat(64), localBehindFence.aggregateVersion),
    THIRD_MUTATION_ID
  );
  assert.equal(acknowledged.result.storyRevision, "00000000000000000005");
  const original = await fixture.ledger.loadStoryReceipt(SCOPE, THIRD_MUTATION_ID);
  assert.notEqual(original.acknowledged, null);
  const acknowledgement = await fixture.ledger.loadStoryReceipt(SCOPE, ACK_MUTATION_ID);
  assert.notEqual(acknowledgement.completed, null);
  assert.deepEqual(
    await fixture.mutations.getUnknownOutcomeStatus(STORY_ID, THIRD_MUTATION_ID),
    { state: "resolved", deleted: false }
  );

  // Local-tier mutations contributed no durable records at any boundary.
  assert.deepEqual(await fixture.ledger.loadStoryReceipt(SCOPE, MUTATION_ID), EMPTY_RECEIPT);
  assert.deepEqual(await fixture.ledger.loadStoryReceipt(SCOPE, OTHER_MUTATION_ID), EMPTY_RECEIPT);
  assert.deepEqual(await fixture.ledger.loadStoryReceipt(SCOPE, FOURTH_MUTATION_ID), EMPTY_RECEIPT);
});

function hasFsCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && "code" in error && error.code === code;
}

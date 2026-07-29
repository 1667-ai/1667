import { providerOperation } from "./story-mutation-fixtures.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  GenerationCancelledError,
  GenerationResultError,
  ServiceError
} from "../server/errors.js";
import { StoryProviderRaceResolver } from "../server/story-provider-race.js";
import { StoryMutationRecovery } from "../server/story-mutation-transaction.js";
import {
  FINGERPRINT,
  FIXED_NOW,
  hasServiceError,
  MUTATION_ID,
  OTHER_FINGERPRINT,
  OTHER_MUTATION_ID,
  request,
  requestFor,
  setup,
  STORY_ID,
  storyFixture
} from "./story-mutation-fixtures.js";

test("Q receipt-only terminal publication waits out a short story claim", async (t) => {
  const fixture = await setup(t, "1667-q-provider-receipt-claim-");
  let releaseClaim!: () => void;
  const claimGate = new Promise<void>((resolve) => {
    releaseClaim = resolve;
  });
  t.after(() => releaseClaim());
  let holder: Promise<void> | null = null;

  await assert.rejects(
    fixture.mutations.runProviderOperation(
      request(fixture.v5Hash),
      "autonameStory",
      providerOperation(
        async () => {
          let markClaimed!: () => void;
          const claimed = new Promise<void>((resolve) => {
            markClaimed = resolve;
          });
          holder = fixture.coordinator.runStory(
            requestFor(
              OTHER_MUTATION_ID,
              OTHER_FINGERPRINT,
              { kind: "v5", manifestHash: fixture.v5Hash }
            ),
            async () => {
              markClaimed();
              await claimGate;
            }
          );
          await claimed;
          setTimeout(releaseClaim, 25);
          throw new ServiceError(409, "Exact provider failure", "conflict");
        },
        storyFixture
      )
    ),
    hasServiceError("conflict")
  );

  await holder;
  const receipt = await fixture.ledger.loadStoryReceipt(
    `story:${STORY_ID}`,
    MUTATION_ID
  );
  assert.equal(
    receipt.prepared?.result.kind === "error"
      ? receipt.prepared.result.code
      : null,
    "conflict"
  );
  assert.notEqual(receipt.completed, null);
});

test("Q terminal success replay waits out a short story claim", async (t) => {
  const fixture = await setup(t, "1667-q-provider-replay-claim-");
  const canonicalRequest = await fixture.coordinator.runStory(
    request(fixture.v5Hash),
    (parsed) => parsed
  );
  const winner = await fixture.mutations.runProviderOperation(
    request(fixture.v5Hash),
    "autonameStory",
    providerOperation(
      async (stories, start) => {
        await start();
        return await stories.commitProviderEffect(STORY_ID, {
          kind: "autoname",
          expectedTitle: "Original",
          title: "Winner"
        });
      },
      storyFixture
    )
  );
  let releaseClaim!: () => void;
  const claimGate = new Promise<void>((resolve) => {
    releaseClaim = resolve;
  });
  t.after(() => releaseClaim());
  let markClaimed!: () => void;
  const claimed = new Promise<void>((resolve) => {
    markClaimed = resolve;
  });
  const holder = fixture.coordinator.runStory(
    requestFor(
      OTHER_MUTATION_ID,
      OTHER_FINGERPRINT,
      winner.aggregateVersion
    ),
    async () => {
      markClaimed();
      await claimGate;
    }
  );
  await claimed;
  setTimeout(releaseClaim, 25);
  const resolver = new StoryProviderRaceResolver(
    fixture.stories,
    fixture.coordinator,
    fixture.ledger,
    new StoryMutationRecovery(fixture.ledger, () => FIXED_NOW),
    () => FIXED_NOW,
    {}
  );

  const replayed = await resolver.replayTerminalSuccess(
    STORY_ID,
    canonicalRequest,
    "autonameStory",
    () => "replayed"
  );

  await holder;
  assert.equal(replayed.value, "replayed");
  assert.equal(replayed.story.title, "Winner");
  assert.deepEqual(replayed.result, winner.result);
  assert.deepEqual(replayed.aggregateVersion, winner.aggregateVersion);
});

test("Q cancellation at effect preparation terminalizes exactly", async (t) => {
  const fixture = await setup(t, "1667-q-provider-preparation-cancel-");
  const cancelled = new AbortController();
  const cancellation = new GenerationCancelledError();
  let workCalls = 0;
  const operation = () => fixture.mutations.runProviderOperation(
    request(fixture.v5Hash),
    "continueStory",
    {
      signal: cancelled.signal,
      work: async ({ stories, providerStarted, signal }) => {
        assert.equal(signal, cancelled.signal);
        workCalls += 1;
        await providerStarted();
        cancelled.abort(cancellation);
        return await stories.commitProviderEffect(STORY_ID, {
          kind: "continue",
          parentId: null,
          appendTo: null,
          expectedTextHash: null,
          instruction: "Continue",
          text: "Must not commit",
          model: "test",
          genId: "cancelled-at-preparation",
          expectedParentActiveChildId: null,
          expectedAppendActiveChildId: null,
          expectedActiveRootId: null,
          expectedActiveLeafId: null,
          cancelled: cancelled.signal
        });
      },
      replayValue: storyFixture
    }
  );

  await assert.rejects(
    operation(),
    (error: unknown) => error === cancellation
  );
  assert.equal(workCalls, 1);
  const receipt = await fixture.ledger.loadStoryReceipt(
    `story:${STORY_ID}`,
    MUTATION_ID
  );
  assert.equal(
    receipt.prepared?.result.kind === "error"
      ? receipt.prepared.result.code
      : null,
    "conflict"
  );
  assert.notEqual(receipt.completed, null);
  await assert.rejects(operation(), hasServiceError("conflict"));
  assert.equal(workCalls, 1);
});

test("Q preserves uncertain cancellation without a terminal receipt", async (t) => {
  const fixture = await setup(t, "1667-q-provider-uncertain-cancel-");
  const cancelled = new AbortController();
  const uncertainty = new ServiceError(
    503,
    "Provider outcome is unknown",
    "mutation_outcome_unknown"
  );
  const operation = fixture.mutations.runProviderOperation(
    request(fixture.v5Hash),
    "continueStory",
    {
      signal: cancelled.signal,
      work: async ({ stories, providerStarted }) => {
        await providerStarted();
        cancelled.abort(uncertainty);
        return await stories.commitProviderEffect(STORY_ID, {
          kind: "continue",
          parentId: null,
          appendTo: null,
          expectedTextHash: null,
          instruction: "Continue",
          text: "Uncertain text",
          model: "test",
          genId: "uncertain-at-preparation",
          expectedParentActiveChildId: null,
          expectedAppendActiveChildId: null,
          expectedActiveRootId: null,
          expectedActiveLeafId: null,
          cancelled: cancelled.signal
        });
      },
      replayValue: storyFixture
    }
  );

  await assert.rejects(operation, (error: unknown) => error === uncertainty);
  const receipt = await fixture.ledger.loadStoryReceipt(
    `story:${STORY_ID}`,
    MUTATION_ID
  );
  assert.notEqual(receipt.started, null);
  assert.equal(receipt.prepared, null);
  assert.equal(receipt.completed, null);
});

test("Q cancellation does not hide a concurrent provider failure", async (t) => {
  const fixture = await setup(t, "1667-q-provider-cancel-failure-race-");
  const cancelled = new AbortController();
  const cancellation = new GenerationCancelledError();
  const failure = new GenerationResultError(
    502,
    "Provider callback failed"
  );
  const operation = fixture.mutations.runProviderOperation(
    request(fixture.v5Hash),
    "continueStory",
    {
      signal: cancelled.signal,
      work: async ({ providerStarted }) => {
        await providerStarted();
        cancelled.abort(cancellation);
        throw failure;
      },
      replayValue: storyFixture
    }
  );

  await assert.rejects(operation, (error: unknown) => error === failure);
  const receipt = await fixture.ledger.loadStoryReceipt(
    `story:${STORY_ID}`,
    MUTATION_ID
  );
  assert.equal(
    receipt.prepared?.result.kind === "error"
      ? receipt.prepared.result.code
      : null,
    "provider_failure"
  );
});

test("Q delayed success replay returns the current story version", async (t) => {
  const fixture = await setup(t, "1667-q-provider-current-replay-");
  let markDuplicateAdmitted!: () => void;
  const duplicateAdmitted = new Promise<void>((resolve) => {
    markDuplicateAdmitted = resolve;
  });
  let releaseDuplicate!: () => void;
  const duplicateGate = new Promise<void>((resolve) => {
    releaseDuplicate = resolve;
  });
  t.after(() => releaseDuplicate());

  const duplicate = fixture.mutations.runProviderOperation(
    request(fixture.v5Hash),
    "autonameStory",
    providerOperation(
      async (_stories, start) => {
        markDuplicateAdmitted();
        await duplicateGate;
        await start();
        return "duplicate-work";
      },
      () => "replayed"
    )
  );
  await duplicateAdmitted;
  const winner = await fixture.mutations.runProviderOperation(
    request(fixture.v5Hash),
    "autonameStory",
    providerOperation(
      async (stories, start) => {
        await start();
        return await stories.commitProviderEffect(STORY_ID, {
          kind: "autoname",
          expectedTitle: "Original",
          title: "Winner"
        });
      },
      storyFixture
    )
  );
  const afterWinner = await fixture.stories.loadVersioned(STORY_ID);
  const local = await fixture.mutations.runLocal(
    requestFor(
      OTHER_MUTATION_ID,
      OTHER_FINGERPRINT,
      afterWinner.aggregateVersion!
    ),
    "renameStory",
    (story) => {
      story.title = "Locally newer";
    }
  );
  releaseDuplicate();

  const replayed = await duplicate;
  assert.equal(replayed.value, "replayed");
  assert.equal(replayed.story.title, "Locally newer");
  assert.deepEqual(replayed.result, winner.result);
  assert.deepEqual(replayed.aggregateVersion, local.aggregateVersion);

  const retried = await fixture.mutations.runProviderOperation(
    request(fixture.v5Hash),
    "autonameStory",
    providerOperation(
      async () => assert.fail("completed provider work must not repeat"),
      () => "retried"
    )
  );
  assert.equal(retried.story.title, "Locally newer");
  assert.deepEqual(retried.result, winner.result);
  assert.deepEqual(retried.aggregateVersion, local.aggregateVersion);
});

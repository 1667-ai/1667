import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ProviderError, ServiceError } from "../server/errors.js";
import { parseStoryManifestBytes } from "../server/story-v6-codec.js";
import { StoryStore } from "../server/stories.js";
import { summarySourceFingerprint } from "../server/summary-take.js";
import {
  DELETE_MUTATION_ID,
  FINGERPRINT,
  hasServiceError,
  MUTATION_ID,
  request,
  requestFor,
  setup,
  STORY_ID,
  storyFixture,
  THIRD_MUTATION_ID
} from "./story-mutation-fixtures.js";

test("Q a receipt-only duplicate terminalizes before another start", async (t) => {
  const fixture = await setup(t, "1667-q-provider-receipt-race-");
  let arrivals = 0;
  let releasePrepared!: () => void;
  const bothPrepared = new Promise<void>((resolve) => {
    releasePrepared = resolve;
  });
  const arrive = () => {
    arrivals += 1;
    if (arrivals === 2) releasePrepared();
  };
  let markWinnerPrepared!: () => void;
  const winnerPrepared = new Promise<void>((resolve) => {
    markWinnerPrepared = resolve;
  });
  let releaseLoserTerminal!: () => void;
  const loserTerminal = new Promise<void>((resolve) => {
    releaseLoserTerminal = resolve;
  });
  t.after(() => {
    releasePrepared();
    releaseLoserTerminal();
  });
  let providerStarts = 0;

  const winner = fixture.mutations.runProvider(
    requestFor(MUTATION_ID, FINGERPRINT, {
      kind: "v5",
      manifestHash: fixture.v5Hash
    }),
    "autonameStory",
    async (stories, start) => {
      arrive();
      markWinnerPrepared();
      await bothPrepared;
      await loserTerminal;
      await start();
      providerStarts += 1;
      return await stories.commitProviderEffect(STORY_ID, {
        kind: "autoname",
        expectedTitle: "Original",
        title: "Must not commit"
      });
    },
    storyFixture
  );
  await winnerPrepared;
  const loser = fixture.mutations.runProvider(
    requestFor(MUTATION_ID, FINGERPRINT, {
      kind: "v5",
      manifestHash: fixture.v5Hash
    }),
    "autonameStory",
    async () => {
      arrive();
      await bothPrepared;
      throw new ServiceError(409, "Duplicate rejected", "conflict");
    },
    storyFixture
  );

  await assert.rejects(loser, hasServiceError("conflict"));
  releaseLoserTerminal();
  await assert.rejects(winner, hasServiceError("conflict"));
  assert.equal(providerStarts, 0);
  const receipt = await fixture.ledger.loadStoryReceipt(
    `story:${STORY_ID}`,
    MUTATION_ID
  );
  assert.equal(receipt.started, null);
  assert.equal(
    receipt.prepared?.result.kind === "error"
      ? receipt.prepared.result.code
      : null,
    "conflict"
  );
  assert.notEqual(receipt.completed, null);
});

test("Q a delayed duplicate replays a winner completed before start", async (t) => {
  const fixture = await setup(t, "1667-q-provider-delayed-start-replay-");
  let markDuplicateAdmitted!: () => void;
  const duplicateAdmitted = new Promise<void>((resolve) => {
    markDuplicateAdmitted = resolve;
  });
  let releaseDuplicate!: () => void;
  const duplicateGate = new Promise<void>((resolve) => {
    releaseDuplicate = resolve;
  });
  t.after(() => releaseDuplicate());
  let continuedAfterStart = false;

  const duplicate = fixture.mutations.runProvider(
    request(fixture.v5Hash),
    "autonameStory",
    async (_stories, start) => {
      markDuplicateAdmitted();
      await duplicateGate;
      await start();
      continuedAfterStart = true;
      return "duplicate-work";
    },
    () => "replayed"
  );
  await duplicateAdmitted;
  const winner = await fixture.mutations.runProvider(
    request(fixture.v5Hash),
    "autonameStory",
    async (stories, start) => {
      await start();
      return await stories.commitProviderEffect(STORY_ID, {
        kind: "autoname",
        expectedTitle: "Original",
        title: "Winner"
      });
    },
    storyFixture
  );
  releaseDuplicate();

  const replayed = await duplicate;
  assert.equal(continuedAfterStart, false);
  assert.equal(replayed.value, "replayed");
  assert.equal(replayed.story.title, "Winner");
  assert.deepEqual(replayed.result, winner.result);
});

test("Q a pre-start failure observes a contender's durable start", async (t) => {
  const fixture = await setup(t, "1667-q-provider-failure-after-other-start-");
  let markLoserAdmitted!: () => void;
  const loserAdmitted = new Promise<void>((resolve) => {
    markLoserAdmitted = resolve;
  });
  let markWinnerStarted!: () => void;
  const winnerStarted = new Promise<void>((resolve) => {
    markWinnerStarted = resolve;
  });
  let releaseWinner!: () => void;
  const winnerGate = new Promise<void>((resolve) => {
    releaseWinner = resolve;
  });
  t.after(() => releaseWinner());

  const loser = fixture.mutations.runProvider(
    request(fixture.v5Hash),
    "autonameStory",
    async () => {
      markLoserAdmitted();
      await winnerStarted;
      throw new ServiceError(409, "Loser failed before start", "conflict");
    },
    storyFixture
  );
  await loserAdmitted;
  const winner = fixture.mutations.runProvider(
    request(fixture.v5Hash),
    "autonameStory",
    async (stories, start) => {
      await start();
      markWinnerStarted();
      await winnerGate;
      return await stories.commitProviderEffect(STORY_ID, {
        kind: "autoname",
        expectedTitle: "Original",
        title: "Winner"
      });
    },
    storyFixture
  );

  await assert.rejects(
    loser,
    hasServiceError("generation_outcome_unknown")
  );
  releaseWinner();
  assert.equal((await winner).story.title, "Winner");
});

test("Q a prepared no-op provider effect still terminalizes", async (t) => {
  const fixture = await setup(t, "1667-q-provider-no-op-terminal-");
  const seeded = await fixture.stories.createNode(
    STORY_ID,
    null,
    "Already committed summary",
    "Summarize"
  );
  const existing = seeded.nodes.at(-1)!;
  const admitted = await fixture.stories.loadVersioned(STORY_ID);

  const committed = await fixture.mutations.runProvider(
    requestFor(MUTATION_ID, FINGERPRINT, admitted.aggregateVersion!),
    "createSummaryTake",
    async (stories) => await stories.commitProviderEffect(STORY_ID, {
      kind: "summary-take",
      point: { nodeId: existing.id, offset: null },
      expected: null,
      sourceFingerprint: "unused-for-existing-commit",
      summary: "Must not be duplicated",
      model: "test",
      instruction: "Summarize",
      commitIds: { summaryNodeId: existing.id }
    }),
    () => existing
  );

  assert.equal(committed.value.id, existing.id);
  assert.equal(
    committed.story.nodes.filter((node) => node.id === existing.id).length,
    1
  );
  const receipt = await fixture.ledger.loadStoryReceipt(
    `story:${STORY_ID}`,
    MUTATION_ID
  );
  assert.notEqual(receipt.started, null);
  assert.equal(receipt.prepared?.result.kind, "story");
  assert.notEqual(receipt.completed, null);
  assert.deepEqual(
    (await fixture.stories.loadVersioned(STORY_ID)).story,
    committed.story
  );
  await fixture.stories.waitForMaintenance();
});

test("Q freezes provider effect allocators before terminal publication", async (t) => {
  const fixture = await setup(t, "1667-q-provider-effect-allocation-");
  const seeded = await fixture.stories.createNode(
    STORY_ID,
    null,
    "Source to summarize",
    "Begin"
  );
  const source = seeded.nodes.at(-1)!;
  const point = { nodeId: source.id, offset: null };
  const admitted = await fixture.stories.loadVersioned(STORY_ID);
  const cancelledAfterPreparation = new AbortController();

  const committed = await fixture.mutations.runProvider(
    requestFor(MUTATION_ID, FINGERPRINT, admitted.aggregateVersion!),
    "createSummaryTake",
    async (stories) => {
      const node = await stories.commitProviderEffect(STORY_ID, {
        kind: "summary-take",
        point,
        expected: null,
        sourceFingerprint: summarySourceFingerprint(
          seeded.title,
          seeded.nodes,
          point
        ),
        summary: "Stable allocated result",
        model: "test",
        instruction: "Summarize",
        commitIds: {},
        cancelled: cancelledAfterPreparation.signal
      });
      cancelledAfterPreparation.abort();
      return node;
    },
    () => source
  );

  const stored = committed.story.nodes.find(
    (node) => node.id === committed.value.id
  );
  assert.notEqual(stored, undefined);
  assert.equal(stored?.text, "Stable allocated result");
  assert.equal(stored?.createdAt, committed.value.createdAt);
  assert.equal(
    committed.story.nodes.filter(
      (node) => node.text === "Stable allocated result"
    ).length,
    1
  );
  await fixture.stories.waitForMaintenance();
});

for (const cachedKind of ["v5", "v6"] as const) {
  test(`Q provider failure terminalizes after cached ${cachedKind.toUpperCase()} deletion`, async (t) => {
    const fixture = await setup(
      t,
      `1667-q-provider-failure-after-${cachedKind}-delete-`
    );
    let cachedVersion = {
      kind: "v5",
      manifestHash: fixture.v5Hash
    } as NonNullable<
      Awaited<ReturnType<StoryStore["loadVersioned"]>>["aggregateVersion"]
    >;
    if (cachedKind === "v6") {
      const upgraded = await fixture.mutations.runLocal(
        requestFor(THIRD_MUTATION_ID, "c".repeat(64), cachedVersion),
        "renameStory",
        (story) => { story.title = "Original V6"; }
      );
      cachedVersion = upgraded.aggregateVersion;
    }
    const operation = () => fixture.mutations.runProvider(
      requestFor(MUTATION_ID, FINGERPRINT, cachedVersion),
      "autonameStory",
      async (_stories, providerStarted) => {
        await providerStarted();
        await fixture.mutations.runDelete(requestFor(
          DELETE_MUTATION_ID,
          "d".repeat(64),
          cachedVersion
        ));
        throw new ProviderError("Rejected after deletion", 400);
      },
      storyFixture
    );

    await assert.rejects(operation(), ProviderError);
    const stored = await fixture.ledger.loadStoryReceipt(
      `story:${STORY_ID}`,
      MUTATION_ID
    );
    assert.equal(
      stored.prepared?.result.kind === "error"
        ? stored.prepared.result.code
        : null,
      "provider_failure"
    );
    const manifest = parseStoryManifestBytes(
      await readFile(fixture.manifestFile),
      STORY_ID
    );
    assert.equal(manifest.kind, "v6-deleted");
    if (manifest.kind !== "v6-deleted") assert.fail("Expected deleted V6");
    assert.equal(manifest.manifest.unresolvedProvider, null);
    await assert.rejects(operation(), hasServiceError("provider_failure"));
  });
}

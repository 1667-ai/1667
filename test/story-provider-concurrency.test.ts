import { providerOperation } from "./story-mutation-fixtures.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ServiceError } from "../server/errors.js";
import { parseStoryManifestBytes } from "../server/story-v6-codec.js";
import { StoryStore } from "../server/stories.js";
import { firstFactText } from "../shared/fact-state.js";
import {
  ACK_MUTATION_ID,
  DELETE_MUTATION_ID,
  FINGERPRINT,
  FIXED_NOW,
  FOURTH_MUTATION_ID,
  hasServiceError,
  MUTATION_ID,
  OTHER_FINGERPRINT,
  OTHER_MUTATION_ID,
  PinObservingStoryStore,
  request,
  requestFor,
  setup,
  STORY_ID,
  storyFixture,
  THIRD_MUTATION_ID
} from "./story-mutation-fixtures.js";

for (const cachedKind of ["v5", "v6"] as const) {
  test(`Q provider work admits a cached ${cachedKind.toUpperCase()} local edit`, async (t) => {
    const fixture = await setup(t, `1667-q-provider-cached-${cachedKind}-`);
    let cachedVersion = {
      kind: "v5",
      manifestHash: fixture.v5Hash
    } as NonNullable<
      Awaited<ReturnType<StoryStore["loadVersioned"]>>["aggregateVersion"]
    >;
    let expectedTitle = "Original";
    if (cachedKind === "v6") {
      expectedTitle = "Original V6";
      const upgraded = await fixture.mutations.runLocal(
        requestFor(THIRD_MUTATION_ID, "c".repeat(64), cachedVersion),
        "renameStory",
        (story) => { story.title = expectedTitle; }
      );
      cachedVersion = upgraded.aggregateVersion;
    }
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    t.after(() => releaseProvider());

    const provider = fixture.mutations.runProviderOperation(
      requestFor(MUTATION_ID, FINGERPRINT, cachedVersion),
      "autonameStory",
      providerOperation(
        async (stories, start) => {
          await start();
          providerStarted();
          await providerGate;
          return await stories.commitProviderEffect(STORY_ID, {
            kind: "autoname",
            expectedTitle,
            title: "Generated title",
            autonameId: "autoname-1"
          });
        },
        () => storyFixture()
      )
    );
    await started;
    const startedManifest = parseStoryManifestBytes(
      await readFile(fixture.manifestFile),
      STORY_ID
    );
    assert.equal(startedManifest.kind, "v6-live");
    if (startedManifest.kind !== "v6-live") {
      assert.fail("Expected live V6");
    }
    const crossKindVersion = cachedKind === "v5"
      ? { kind: "v6", revision: "00000000000000000001" } as const
      : {
          kind: "v5",
          manifestHash: startedManifest.manifest.previousManifestHash!
        } as const;
    let crossKindMutationRan = false;
    await assert.rejects(
      fixture.mutations.runLocal(
        requestFor(
          FOURTH_MUTATION_ID,
          "f".repeat(64),
          crossKindVersion
        ),
        "createFact",
        () => { crossKindMutationRan = true; }
      ),
      hasServiceError("revision_conflict")
    );
    assert.equal(crossKindMutationRan, false);

    const local = await fixture.mutations.runLocal(
      requestFor(OTHER_MUTATION_ID, OTHER_FINGERPRINT, cachedVersion),
      "createFact",
      (story) => {
        story.facts.push({
          id: "fact-1",
          tag: null,
          states: [{ id: "fact-1-state", text: "Written while the provider streamed", createdAt: FIXED_NOW.toISOString(), updatedAt: FIXED_NOW.toISOString() }],
          activation: "always",
          keys: [],
          createdAt: FIXED_NOW.toISOString(),
          updatedAt: FIXED_NOW.toISOString()
        });
      }
    );
    assert.equal(local.story.facts.length, 1);
    let staleMutationRan = false;
    await assert.rejects(
      fixture.mutations.runLocal(
        requestFor(DELETE_MUTATION_ID, "d".repeat(64), cachedVersion),
        "createFact",
        () => { staleMutationRan = true; }
      ),
      hasServiceError("revision_conflict")
    );
    assert.equal(staleMutationRan, false);
    await assert.rejects(
      fixture.mutations.runDelete(
        requestFor(ACK_MUTATION_ID, "e".repeat(64), cachedVersion)
      ),
      hasServiceError("revision_conflict")
    );
    assert.equal((await fixture.stories.loadVersioned(STORY_ID)).story.id, STORY_ID);

    releaseProvider();
    const committed = await provider;
    const reloaded = await fixture.stories.loadVersioned(STORY_ID);
    assert.deepEqual(committed.story, reloaded.story);
    assert.equal(committed.story.title, "Generated title");
    assert.equal(
      firstFactText(committed.story.facts[0]!),
      "Written while the provider streamed"
    );
    assert.deepEqual(reloaded.aggregateVersion, {
      kind: "v6",
      revision: committed.result.storyRevision
    });
    await fixture.stories.waitForMaintenance();
    assert.deepEqual(
      (await fixture.stories.loadVersioned(STORY_ID)).story,
      committed.story
    );
  });
}

test("Q provider snapshot hydration survives concurrent deletion cleanup", async (t) => {
  const fixture = await setup(t, "1667-q-provider-snapshot-pin-");
  let story = await fixture.stories.createNode(
    STORY_ID,
    null,
    "Inactive source text",
    "Old line"
  );
  const inactiveId = story.activeRootId!;
  story = await fixture.stories.createNode(
    STORY_ID,
    null,
    "Current source text",
    "Current line"
  );
  assert.notEqual(story.activeRootId, inactiveId);
  const admitted = await fixture.stories.loadVersioned(STORY_ID);
  let hydratedText = "";

  await fixture.mutations.runProviderOperation(
    requestFor(MUTATION_ID, FINGERPRINT, admitted.aggregateVersion!),
    "continueStory",
    providerOperation(
      async (stories) => {
        const snapshot = await stories.loadForMutation(STORY_ID);
        await fixture.stories.deleteNode(STORY_ID, inactiveId, 1);
        await fixture.stories.waitForMaintenance();
        await stories.hydratePath(snapshot, inactiveId);
        hydratedText = snapshot.nodes.find(
          (node) => node.id === inactiveId
        )?.text ?? "";
        return hydratedText;
      },
      () => ""
    )
  );

  assert.equal(hydratedText, "Inactive source text");
  assert.equal(
    (await fixture.stories.loadVersioned(STORY_ID)).story.nodes.some(
      (node) => node.id === inactiveId
    ),
    false
  );
  await fixture.stories.waitForMaintenance();
});

test("Q provider admission releases its snapshot pin when finalization fails", async (t) => {
  let observed!: PinObservingStoryStore;
  const fixture = await setup(
    t,
    "1667-q-provider-pin-release-",
    {},
    (storiesDir) => {
      observed = new PinObservingStoryStore(storiesDir);
      return observed;
    }
  );
  observed.failNextCleanupSchedule = true;
  let workRan = false;

  await assert.rejects(
    fixture.mutations.runProviderOperation(
      request(fixture.v5Hash),
      "autonameStory",
      providerOperation(
        async () => {
          workRan = true;
          return storyFixture();
        },
        storyFixture
      )
    ),
    /Injected cleanup scheduling failure/
  );
  assert.equal(workRan, false);
  assert.equal(observed.activeProviderPins, 0);
  await observed.waitForMaintenance();
});

test("Q terminal publication waits out a short competing story claim", async (t) => {
  const fixture = await setup(t, "1667-q-provider-terminal-claim-");
  let releaseClaim!: () => void;
  const claimGate = new Promise<void>((resolve) => {
    releaseClaim = resolve;
  });
  t.after(() => releaseClaim());
  let holder: Promise<void> | null = null;

  const committed = await fixture.mutations.runProviderOperation(
    request(fixture.v5Hash),
    "autonameStory",
    providerOperation(
      async (stories, start) => {
        await start();
        const draft = await stories.commitProviderEffect(STORY_ID, {
          kind: "autoname",
          expectedTitle: "Original",
          title: "Generated after contention"
        });
        let claimStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          claimStarted = resolve;
        });
        holder = fixture.coordinator.runStory(
          requestFor(
            OTHER_MUTATION_ID,
            OTHER_FINGERPRINT,
            { kind: "v5", manifestHash: fixture.v5Hash }
          ),
          async () => {
            claimStarted();
            await claimGate;
          }
        );
        await started;
        setTimeout(releaseClaim, 25);
        return draft;
      },
      storyFixture
    )
  );

  await holder;
  assert.equal(committed.story.title, "Generated after contention");
  assert.deepEqual(
    committed.story,
    (await fixture.stories.loadVersioned(STORY_ID)).story
  );
});

test("Q terminal effect conflicts retain their durable conflict result", async (t) => {
  const fixture = await setup(t, "1667-q-provider-terminal-conflict-");
  let workCalls = 0;
  const operation = () => fixture.mutations.runProviderOperation(
    request(fixture.v5Hash),
    "autonameStory",
    providerOperation(
      async (stories, start) => {
        workCalls += 1;
        await start();
        const draft = await stories.commitProviderEffect(STORY_ID, {
          kind: "autoname",
          expectedTitle: "Original",
          title: "Generated title"
        });
        const current = await fixture.stories.loadVersioned(STORY_ID);
        await fixture.mutations.runLocal(
          requestFor(
            OTHER_MUTATION_ID,
            OTHER_FINGERPRINT,
            current.aggregateVersion!
          ),
          "renameStory",
          (story) => {
            story.title = "Writer title";
          }
        );
        return draft;
      },
      storyFixture
    )
  );

  await assert.rejects(operation(), hasServiceError("conflict"));
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
  await assert.rejects(operation(), hasServiceError("conflict"));
  assert.equal(workCalls, 1);
  assert.equal(
    (await fixture.stories.loadVersioned(STORY_ID)).story.title,
    "Writer title"
  );
});

test("Q lets two providers prepare but only one publish start before network", async (t) => {
  const fixture = await setup(t, "1667-q-provider-start-race-");
  let ready = 0;
  let firstPrepared!: () => void;
  const firstReady = new Promise<void>((resolve) => {
    firstPrepared = resolve;
  });
  let releaseBoth!: () => void;
  const bothReady = new Promise<void>((resolve) => {
    releaseBoth = resolve;
  });
  let networkStarts = 0;

  const contender = (mutationId: string, fingerprint: string, title: string) =>
    fixture.mutations.runProviderOperation(
      requestFor(
        mutationId,
        fingerprint,
        { kind: "v5", manifestHash: fixture.v5Hash }
      ),
      "autonameStory",
      providerOperation(
        async (stories, start) => {
          ready += 1;
          if (ready === 1) firstPrepared();
          if (ready === 2) releaseBoth();
          await bothReady;
          await start();
          networkStarts += 1;
          return await stories.commitProviderEffect(STORY_ID, {
            kind: "autoname",
            expectedTitle: "Original",
            title
          });
        },
        storyFixture
      )
    );

  const first = contender(MUTATION_ID, FINGERPRINT, "First");
  await firstReady;
  const second = contender(
    THIRD_MUTATION_ID,
    "e".repeat(64),
    "Second"
  );
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(networkStarts, 1);
  assert.equal(
    outcomes.filter(({ status }) => status === "fulfilled").length,
    1
  );
  const rejected = outcomes.find(
    (outcome): outcome is PromiseRejectedResult =>
      outcome.status === "rejected"
  );
  assert.ok(rejected);
  assert.equal(rejected.reason instanceof ServiceError, true);
  assert.equal(
    ["resource_busy", "generation_outcome_unknown"].includes(
      (rejected.reason as ServiceError).code
    ),
    true
  );
});

test("Q a duplicate loser cannot revoke the active provider predecessor", async (t) => {
  const fixture = await setup(t, "1667-q-provider-duplicate-start-race-");
  const cachedVersion = {
    kind: "v5",
    manifestHash: fixture.v5Hash
  } as const;
  let prepared = 0;
  let releasePrepared!: () => void;
  const bothPrepared = new Promise<void>((resolve) => {
    releasePrepared = resolve;
  });
  const arrive = () => {
    prepared += 1;
    if (prepared === 2) releasePrepared();
  };
  let markWinnerPrepared!: () => void;
  const winnerPrepared = new Promise<void>((resolve) => {
    markWinnerPrepared = resolve;
  });
  let markWinnerStarted!: () => void;
  const winnerStarted = new Promise<void>((resolve) => {
    markWinnerStarted = resolve;
  });
  let releaseWinner!: () => void;
  const winnerGate = new Promise<void>((resolve) => {
    releaseWinner = resolve;
  });

  const winner = fixture.mutations.runProviderOperation(
    requestFor(MUTATION_ID, FINGERPRINT, cachedVersion),
    "autonameStory",
    providerOperation(
      async (stories, start) => {
        arrive();
        markWinnerPrepared();
        await bothPrepared;
        await start();
        markWinnerStarted();
        await winnerGate;
        return await stories.commitProviderEffect(STORY_ID, {
          kind: "autoname",
          expectedTitle: "Original",
          title: "Generated title"
        });
      },
      storyFixture
    )
  );
  await winnerPrepared;
  const duplicate = fixture.mutations.runProviderOperation(
    requestFor(MUTATION_ID, FINGERPRINT, cachedVersion),
    "autonameStory",
    providerOperation(
      async (_stories, start) => {
        arrive();
        await bothPrepared;
        await winnerStarted;
        await start();
        assert.fail("The duplicate provider start must be rejected");
      },
      storyFixture
    )
  );

  try {
    await winnerStarted;
    await assert.rejects(
      duplicate,
      hasServiceError("generation_outcome_unknown")
    );
    const local = await fixture.mutations.runLocal(
      requestFor(OTHER_MUTATION_ID, OTHER_FINGERPRINT, cachedVersion),
      "createFact",
      (story) => {
        story.facts.push({
          id: "fact-after-duplicate",
          tag: null,
          states: [{ id: "fact-after-duplicate-state", text: "The winner still owns its predecessor proof", createdAt: FIXED_NOW.toISOString(), updatedAt: FIXED_NOW.toISOString() }],
          activation: "always",
          keys: [],
          createdAt: FIXED_NOW.toISOString(),
          updatedAt: FIXED_NOW.toISOString()
        });
      }
    );
    assert.equal(local.story.facts.length, 1);
  } finally {
    releaseWinner();
  }
  const committed = await winner;
  assert.equal(committed.story.title, "Generated title");
  assert.equal(committed.story.facts.length, 1);
  await fixture.stories.waitForMaintenance();
});

/**
 * Durable mutation-layer Aside behavior: cleanup, busy, idempotency, crash, predecessor.
 */
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { StoryStore } from "../server/stories.js";
import { parseStoryManifestBytes, STORY_SCHEMA_VERSION_V10 } from "../server/story-v6-codec.js";
import { reduceStoryV6 } from "../server/story-v6-reducer.js";
import { createMutationCoordinator } from "../server/mutation-coordinator.js";
import {
  FINGERPRINT,
  FIXED_NOW,
  FOURTH_MUTATION_ID,
  MUTATION_ID,
  OTHER_FINGERPRINT,
  OTHER_MUTATION_ID,
  THIRD_MUTATION_ID,
  providerOperation,
  requestFor,
  setup,
  STORY_ID,
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

test("askAside recovers after afterPublish crash without a duplicate Side Note", async (t) => {
  const fixture = await setup(
    t,
    "1667-aside-ask-crash-",
    crashOnce("afterPublish"),
    undefined,
    { asideActivation: true }
  );
  await ensureRootPart(fixture.stories);
  const version = (await fixture.stories.loadVersioned(STORY_ID)).aggregateVersion!;
  const document = {
    schemaVersion: 1 as const,
    notes: [{ question: "Once?", answer: "Published." }]
  };
  await assert.rejects(
    fixture.mutations.runProviderOperation(
      requestFor(MUTATION_ID, FINGERPRINT, version),
      "askAside",
      commitAsideDocument(document)
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
  const doc = await fixture.stories.loadAsideDocument(STORY_ID);
  assert.equal(doc?.notes.length, 1);
  assert.equal(doc?.notes[0]?.answer, "Published.");
  await recovered.runProviderOperation(
    requestFor(MUTATION_ID, FINGERPRINT, version),
    "askAside",
    providerOperation(
      async () => {
        throw new Error("provider must not re-run after terminal commit");
      },
      () => document
    )
  );
  assert.equal((await fixture.stories.loadAsideDocument(STORY_ID))?.notes.length, 1);
});

for (const method of ["renameStory", "deleteStory"] as const) {
  for (const point of ["afterPrepared", "afterPublish"] as const) {
    test(`inactive predecessor recovers exact ${method} after ${point} on V10`, async (t) => {
      const fixture = await setup(
        t,
        `1667-aside-predecessor-${method}-${point}-`,
        {},
        undefined,
        { asideActivation: true }
      );
      const version = await seedAsideNote(fixture);
      const mutationId = method === "renameStory"
        ? OTHER_MUTATION_ID
        : THIRD_MUTATION_ID;
      const fingerprint = method === "renameStory"
        ? OTHER_FINGERPRINT
        : "c".repeat(64);
      const request = requestFor(mutationId, fingerprint, version);
      const crashing = new StoryMutationStore(
        fixture.stories,
        createMutationCoordinator(),
        fixture.dataDir,
        {
          ledger: fixture.ledger,
          now: () => FIXED_NOW,
          hooks: crashOnce(point)
        }
      );
      await crashing.init();
      if (method === "renameStory") {
        await assert.rejects(
          crashing.runLocal(
            request,
            method,
            (story) => { story.title = "Recovered title"; }
          ),
          (error: unknown) => error instanceof InjectedStoryMutationCrash
        );
      } else {
        await assert.rejects(
          crashing.runDelete(request),
          (error: unknown) => error instanceof InjectedStoryMutationCrash
        );
      }
      if (point === "afterPrepared") {
        await access(`${fixture.manifestFile}.next`);
      }

      const predecessor = new StoryStore(
        path.join(fixture.dataDir, "stories"),
        { asideActivation: false }
      );
      await predecessor.init();
      const recovered = new StoryMutationStore(
        predecessor,
        createMutationCoordinator(),
        fixture.dataDir,
        { ledger: fixture.ledger, now: () => FIXED_NOW }
      );
      await recovered.init();

      let freshMutationRan = false;
      const freshRequest = requestFor(
        FOURTH_MUTATION_ID,
        FINGERPRINT,
        version
      );
      if (method === "renameStory") {
        await assert.rejects(
          recovered.runLocal(
            freshRequest,
            method,
            (story) => {
              freshMutationRan = true;
              story.title = "Must not run";
            }
          ),
          hasCode("story_manifest_requires_successor")
        );
      } else {
        await assert.rejects(
          recovered.runDelete(freshRequest),
          hasCode("story_manifest_requires_successor")
        );
      }
      assert.equal(freshMutationRan, false);

      if (method === "renameStory") {
        const retry = await recovered.runLocal(
          request,
          method,
          (story) => { story.title = "Recovered title"; }
        );
        assert.equal(retry.story.title, "Recovered title");
      } else {
        await recovered.runDelete(request);
        await assert.rejects(
          predecessor.load(STORY_ID),
          hasCode("not_found")
        );
      }
      await assert.rejects(() => access(`${fixture.manifestFile}.next`));
      const manifest = parseStoryManifestBytes(
        await readFile(fixture.manifestFile),
        STORY_ID
      );
      if (method === "renameStory") {
        assert.equal(manifest.kind, "v10-live");
        if (manifest.kind === "v10-live") {
          assert.equal(manifest.manifest.schemaVersion, STORY_SCHEMA_VERSION_V10);
        }
      } else {
        assert.equal(manifest.kind, "v10-deleted");
        if (manifest.kind === "v10-deleted") {
          assert.equal(manifest.manifest.schemaVersion, STORY_SCHEMA_VERSION_V10);
        }
      }
    });
  }
}

for (const point of ["afterStage", "afterPrepared", "afterPublish"] as const) {
  test(`inactive predecessor recovers askAside after ${point} without provider redispatch`, async (t) => {
    const fixture = await setup(
      t,
      `1667-aside-predecessor-ask-${point}-`,
      crashOnce(point),
      undefined,
      { asideActivation: true }
    );
    await ensureRootPart(fixture.stories);
    const version = (await fixture.stories.loadVersioned(STORY_ID)).aggregateVersion!;
    const document = {
      schemaVersion: 1 as const,
      notes: [{ question: "Recover?", answer: `Recovered after ${point}.` }]
    };
    await assert.rejects(
      fixture.mutations.runProviderOperation(
        requestFor(MUTATION_ID, FINGERPRINT, version),
        "askAside",
        commitAsideDocument(document)
      ),
      (error: unknown) => error instanceof InjectedStoryMutationCrash
    );

    const predecessor = new StoryStore(
      path.join(fixture.dataDir, "stories"),
      { asideActivation: false }
    );
    await predecessor.init();
    const recovered = new StoryMutationStore(
      predecessor,
      createMutationCoordinator(),
      fixture.dataDir,
      { ledger: fixture.ledger, now: () => FIXED_NOW }
    );
    await recovered.init();
    let providerCalls = 0;
    const retry = recovered.runProviderOperation(
      requestFor(MUTATION_ID, FINGERPRINT, version),
      "askAside",
      providerOperation(
        async () => {
          providerCalls += 1;
          throw new Error("predecessor recovery must not redispatch the provider");
        },
        () => document
      )
    );
    if (point === "afterPublish") {
      const replay = await retry;
      assert.equal(replay.value.notes[0]?.answer, document.notes[0]?.answer);
    } else {
      await assert.rejects(retry, hasCode("generation_outcome_unknown"));
    }
    assert.equal(providerCalls, 0);

    const current = (await predecessor.loadVersioned(STORY_ID)).aggregateVersion!;
    await assert.rejects(
      recovered.runProviderOperation(
        requestFor(OTHER_MUTATION_ID, OTHER_FINGERPRINT, current),
        "askAside",
        providerOperation(
          async () => {
            providerCalls += 1;
            throw new Error("new predecessor Aside request must not reach provider");
          },
          () => document
        )
      ),
      hasCode("aside_not_supported")
    );
    assert.equal(providerCalls, 0);
  });
}

for (const point of ["afterStage", "afterPublish"] as const) {
  test(`inactive predecessor recovers receipt-backed clearAside after ${point} without a new write`, async (t) => {
    const fixture = await setup(
      t,
      `1667-aside-predecessor-clear-${point}-`,
      {},
      undefined,
      { asideActivation: true }
    );
    const version = await seedAsideNote(fixture);
    const clearId = point === "afterStage"
      ? OTHER_MUTATION_ID
      : THIRD_MUTATION_ID;
    const clearFingerprint = point === "afterStage"
      ? OTHER_FINGERPRINT
      : "c".repeat(64);
    const crashing = new StoryMutationStore(
      fixture.stories,
      createMutationCoordinator(),
      fixture.dataDir,
      {
        ledger: fixture.ledger,
        now: () => FIXED_NOW,
        hooks: crashOnce(point)
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

    const predecessor = new StoryStore(
      path.join(fixture.dataDir, "stories"),
      { asideActivation: false }
    );
    await predecessor.init();
    const recovered = new StoryMutationStore(
      predecessor,
      createMutationCoordinator(),
      fixture.dataDir,
      { ledger: fixture.ledger, now: () => FIXED_NOW }
    );
    await recovered.init();
    let freshAskProviderCalls = 0;
    await assert.rejects(
      recovered.runProviderOperation(
        requestFor(FOURTH_MUTATION_ID, FINGERPRINT, version),
        "askAside",
        providerOperation(
          async () => {
            freshAskProviderCalls += 1;
            throw new Error("fresh predecessor ask must not reach provider");
          },
          () => ({})
        )
      ),
      hasCode("aside_not_supported")
    );
    assert.equal(freshAskProviderCalls, 0);
    await recovered.runLocal(
      {
        ...requestFor(clearId, clearFingerprint, version),
        durability: "manifest-only" as const
      },
      "clearAside",
      (story) => { story.asideDocumentId = null; }
    );
    assert.equal(await predecessor.loadAsideDocument(STORY_ID), null);
    const recoveredManifest = parseStoryManifestBytes(
      await readFile(path.join(fixture.dataDir, "stories", STORY_ID, "manifest.json")),
      STORY_ID
    );
    assert.equal(recoveredManifest.kind, "v10-live");
    if (recoveredManifest.kind === "v10-live") {
      assert.equal(recoveredManifest.manifest.schemaVersion, STORY_SCHEMA_VERSION_V10);
    }
    const receipt = await fixture.ledger.loadStoryReceipt(
      `story:${STORY_ID}`,
      clearId
    );
    assert.notEqual(receipt.prepared, null);
    assert.notEqual(receipt.completed, null);

    const current = (await predecessor.loadVersioned(STORY_ID)).aggregateVersion!;
    let newMutationRan = false;
    await assert.rejects(
      recovered.runLocal(
        {
          ...requestFor(FOURTH_MUTATION_ID, FINGERPRINT, current),
          durability: "manifest-only" as const
        },
        "clearAside",
        (story) => {
          newMutationRan = true;
          story.asideDocumentId = null;
        }
      ),
      hasCode("aside_not_supported")
    );
    assert.equal(newMutationRan, false);
  });
}

test("inactive predecessor rejects a fresh clear and preserves a foreign V10-null stage", async (t) => {
  const fixture = await setup(
    t,
    "1667-aside-foreign-clear-stage-",
    {},
    undefined,
    { asideActivation: true }
  );
  const clearedVersion = await seedAsideNote(fixture);
  await fixture.mutations.runLocal(
    requestFor(OTHER_MUTATION_ID, OTHER_FINGERPRINT, clearedVersion),
    "clearAside",
    (story) => { story.asideDocumentId = null; }
  );
  const current = (await fixture.stories.loadVersioned(STORY_ID)).aggregateVersion!;
  await fixture.stories.withAggregateSession(STORY_ID, async (session) => {
    const foreign = reduceStoryV6(
      {
        kind: "present",
        manifest: session.snapshot.manifest,
        manifestHash: session.snapshot.manifestHash
      },
      {
        kind: "provider-started",
        expectedManifestHash: session.snapshot.manifestHash,
        provider: {
          mutationId: FOURTH_MUTATION_ID,
          fingerprintHash: FINGERPRINT
        }
      }
    );
    assert.ok(foreign !== null);
    await session.stageManifest(foreign);
  });
  const stagedPath = path.join(
    fixture.dataDir,
    "stories",
    STORY_ID,
    "manifest.json.next"
  );
  const stagedBefore = await readFile(stagedPath, "utf8");
  const parsedStaged = parseStoryManifestBytes(Buffer.from(stagedBefore), STORY_ID);
  assert.equal(parsedStaged.kind, "v10-live");
  if (parsedStaged.kind === "v10-live") {
    assert.equal(parsedStaged.manifest.content.asideDocumentId, null);
  }

  const predecessor = new StoryStore(
    path.join(fixture.dataDir, "stories"),
    { asideActivation: false }
  );
  await predecessor.init();
  const recovered = new StoryMutationStore(
    predecessor,
    createMutationCoordinator(),
    fixture.dataDir,
    { ledger: fixture.ledger, now: () => FIXED_NOW }
  );
  await recovered.init();
  await assert.rejects(
    recovered.runLocal(
      requestFor(THIRD_MUTATION_ID, "c".repeat(64), current),
      "clearAside",
      (story) => { story.asideDocumentId = null; }
    ),
    hasCode("aside_not_supported")
  );
  assert.equal(await readFile(stagedPath, "utf8"), stagedBefore);
});

test("inactive predecessor rejects a fresh clear with a stale revision after a published V10 clear", async (t) => {
  const fixture = await setup(
    t,
    "1667-aside-stale-clear-revision-",
    {},
    undefined,
    { asideActivation: true }
  );
  const staleVersion = await seedAsideNote(fixture);
  await fixture.mutations.runLocal(
    requestFor(OTHER_MUTATION_ID, OTHER_FINGERPRINT, staleVersion),
    "clearAside",
    (story) => { story.asideDocumentId = null; }
  );
  assert.equal(await fixture.stories.loadAsideDocument(STORY_ID), null);
  const predecessor = new StoryStore(
    path.join(fixture.dataDir, "stories"),
    { asideActivation: false }
  );
  await predecessor.init();
  const recovered = new StoryMutationStore(
    predecessor,
    createMutationCoordinator(),
    fixture.dataDir,
    { ledger: fixture.ledger, now: () => FIXED_NOW }
  );
  await recovered.init();
  await assert.rejects(
    recovered.runLocal(
      requestFor(THIRD_MUTATION_ID, "c".repeat(64), staleVersion),
      "clearAside",
      (story) => { story.asideDocumentId = null; }
    ),
    hasCode("aside_not_supported")
  );
  await assert.rejects(
    readFile(path.join(fixture.dataDir, "stories", STORY_ID, "manifest.json.next")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT"
  );
});

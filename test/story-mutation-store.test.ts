import assert from "node:assert/strict";
import {
  access,
  readFile,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  GenerationResultError,
  ProviderError,
  ServiceError
} from "../server/errors.js";
import { createMutationCoordinator } from "../server/mutation-coordinator.js";
import { hashStartedMutationRecord } from "../server/mutation-ledger-codec.js";
import { MutationLedgerStore } from "../server/mutation-ledger-store.js";
import { privatePublicationScratchPath } from "../server/private-file-publication.js";
import { CLEANUP_MARKER_FILENAME } from "../server/story-cleanup.js";
import { hashStoryV5ManifestBytes } from "../server/story-manifest-hash.js";
import {
  STORY_REAP_RETENTION_MS,
  StoryReaper
} from "../server/story-reaper.js";
import {
  InjectedStoryMutationCrash,
  StoryMutationStore,
  type StoryMutationStoreHooks
} from "../server/story-mutation-store.js";
import { parseStoryManifestBytes } from "../server/story-v6-codec.js";
import { STORY_UNCHANGED } from "../server/stories.js";
import { StoryDurabilityError } from "../server/story-lifecycle.js";
import {
  ACK_MUTATION_ID,
  DELETE_MUTATION_ID,
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

test("Q local mutation upgrades exact V5 to receipt-backed V6 and retries by receipt first", async (t) => {
  const fixture = await setup(t, "1667-q-local-");
  let calls = 0;
  const first = await fixture.mutations.runLocal(
    request(fixture.v5Hash),
    "renameStory",
    (story) => {
      calls += 1;
      story.title = "Renamed";
    }
  );
  assert.equal(first.story.title, "Renamed");
  assert.equal(first.result.storyRevision, "00000000000000000002");
  assert.equal(first.result.summary?.title, "Renamed");

  const parsed = parseStoryManifestBytes(
    await readFile(fixture.manifestFile),
    STORY_ID
  );
  assert.equal(parsed.kind, "v6-live");
  if (parsed.kind !== "v6-live") assert.fail("Expected live V6");
  assert.equal(parsed.manifest.revision, "00000000000000000002");
  assert.equal(parsed.manifest.previousManifestHash, fixture.v5Hash);
  assert.equal(parsed.manifest.lastTransaction?.mutationId, MUTATION_ID);

  const receipt = await fixture.ledger.loadStoryReceipt(`story:${STORY_ID}`, MUTATION_ID);
  assert.equal(receipt.prepared?.method, "renameStory");
  assert.equal(receipt.prepared?.oldStateHash, fixture.v5Hash);
  assert.equal(receipt.completed?.preparedRecordHash.length, 64);

  const replay = await fixture.mutations.runLocal(
    request(fixture.v5Hash),
    "renameStory",
    () => {
      calls += 1;
      throw new Error("replay must not execute");
    }
  );
  assert.equal(calls, 1);
  assert.equal(replay.story.title, "Renamed");
  assert.deepEqual(replay.result, first.result);

  await assert.rejects(
    fixture.mutations.runLocal({
      ...request(fixture.v5Hash),
      mutationId: OTHER_MUTATION_ID
    }, "renameStory", () => undefined),
    hasServiceError("revision_conflict")
  );
});

test("Q local terminal replay reconstructs its method side result", async (t) => {
  const fixture = await setup(t, "1667-q-local-side-result-");
  const first = await fixture.mutations.runLocal(
    request(fixture.v5Hash),
    "renameStory",
    (story) => {
      story.title = "With side result";
      return "durable-side-result";
    },
    () => "durable-side-result"
  );
  const replay = await fixture.mutations.runLocal(
    request(fixture.v5Hash),
    "renameStory",
    () => assert.fail("terminal replay must not execute the mutation"),
    () => "durable-side-result"
  );
  assert.equal(first.value, "durable-side-result");
  assert.equal(replay.value, "durable-side-result");
});

test("Q records an unchanged local command without publishing an aggregate revision", async (t) => {
  const fixture = await setup(t, "1667-q-local-unchanged-");
  const unchanged = await fixture.mutations.runLocal(
    request(fixture.v5Hash),
    "renameStory",
    () => STORY_UNCHANGED
  );
  assert.equal(unchanged.result.storyRevision, "00000000000000000001");
  assert.deepEqual(unchanged.aggregateVersion, {
    kind: "v5",
    manifestHash: fixture.v5Hash
  });
  const receipt = await fixture.ledger.loadStoryReceipt(
    `story:${STORY_ID}`,
    MUTATION_ID
  );
  assert.equal(receipt.started, null);
  assert.equal(receipt.prepared?.oldStateHash, fixture.v5Hash);
  assert.equal(receipt.prepared?.newStateHash, fixture.v5Hash);
  assert.equal(receipt.prepared?.result.kind, "story");
  assert.ok(receipt.completed !== null);
  assert.equal(
    hashStoryV5ManifestBytes(await readFile(fixture.manifestFile)),
    fixture.v5Hash
  );

  let calls = 0;
  const replay = await fixture.mutations.runLocal(
    request(fixture.v5Hash),
    "renameStory",
    () => { calls += 1; }
  );
  assert.equal(calls, 0);
  assert.deepEqual(replay.result, unchanged.result);
  await assert.rejects(
    fixture.mutations.runLocal(
      { ...request(fixture.v5Hash), fingerprint: OTHER_FINGERPRINT },
      "renameStory",
      () => undefined
    ),
    hasServiceError("idempotency_conflict")
  );
});

test("Q surfaces incomplete terminal evidence as post-commit uncertainty", async (t) => {
  const fixture = await setup(t, "1667-q-post-commit-");
  const failing = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    {
      ledger: fixture.ledger,
      now: () => FIXED_NOW,
      hooks: { afterPublish: () => { throw new Error("terminal disk offline"); } }
    }
  );
  await failing.init();
  await assert.rejects(
    failing.runLocal(
      request(fixture.v5Hash),
      "renameStory",
      (story) => { story.title = "Committed"; }
    ),
    (error: unknown) => error instanceof StoryDurabilityError
  );
  const recovered = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    { ledger: fixture.ledger, now: () => FIXED_NOW }
  );
  await recovered.init();
  const replay = await recovered.runLocal(
    request(fixture.v5Hash),
    "renameStory",
    () => assert.fail("published mutation must recover without re-execution")
  );
  assert.equal(replay.story.title, "Committed");
});

test("Q discards a torn unprepared manifest scratch before retry", async (t) => {
  const fixture = await setup(t, "1667-q-torn-next-");
  const next = `${fixture.manifestFile}.next`;
  await writeFile(
    privatePublicationScratchPath(next),
    "{\"schemaVersion\":6",
    { mode: 0o600 }
  );
  const committed = await fixture.mutations.runLocal(
    request(fixture.v5Hash),
    "renameStory",
    (story) => { story.title = "Recovered from torn stage"; }
  );
  assert.equal(committed.story.title, "Recovered from torn stage");
  await assert.rejects(
    access(privatePublicationScratchPath(next)),
    hasFsCode("ENOENT")
  );
});

test("Q receipt-only domain errors remain terminal across later state", async (t) => {
  const fixture = await setup(t, "1667-q-receipt-only-error-");
  await assert.rejects(
    fixture.mutations.runLocal(
      request(fixture.v5Hash),
      "renameStory",
      () => {
        throw new ServiceError(409, "Deterministic rejection", "conflict");
      }
    ),
    hasServiceError("conflict")
  );
  const receipt = await fixture.ledger.loadStoryReceipt(
    `story:${STORY_ID}`,
    MUTATION_ID
  );
  assert.equal(receipt.prepared?.result.kind, "error");
  assert.equal(receipt.prepared?.oldStateHash, receipt.prepared?.newStateHash);
  assert.notEqual(receipt.completed, null);
  await assert.rejects(
    fixture.mutations.runLocal(
      request(fixture.v5Hash),
      "renameStory",
      () => assert.fail("terminal domain error must not re-execute")
    ),
    hasServiceError("conflict")
  );
});

for (const point of ["stage", "prepared", "publish", "completed"] as const) {
  test(`Q local mutation recovers a crash after ${point}`, async (t) => {
    let injected = false;
    const hooks: StoryMutationStoreHooks = {
      [`after${capitalize(point)}`]: () => {
        if (injected) return;
        injected = true;
        throw new InjectedStoryMutationCrash(point);
      }
    };
    const fixture = await setup(t, `1667-q-crash-${point}-`, hooks);
    await assert.rejects(
      fixture.mutations.runLocal(
        request(fixture.v5Hash),
        "renameStory",
        (story) => { story.title = `Recovered ${point}`; }
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
    const result = await recovered.runLocal(
      request(fixture.v5Hash),
      "renameStory",
      (story) => { story.title = `Recovered ${point}`; }
    );
    assert.equal(result.story.title, `Recovered ${point}`);
    assert.equal(result.result.storyRevision, "00000000000000000002");
    await assert.rejects(access(`${fixture.manifestFile}.next`), hasFsCode("ENOENT"));
    const receipt = await fixture.ledger.loadStoryReceipt(`story:${STORY_ID}`, MUTATION_ID);
    assert.notEqual(receipt.prepared, null);
    assert.notEqual(receipt.completed, null);
  });
}

test("Q finalizes a prior published transaction before admitting a new mutation", async (t) => {
  let injected = false;
  const fixture = await setup(t, "1667-q-prior-recovery-", {
    afterPublish: () => {
      if (injected) return;
      injected = true;
      throw new InjectedStoryMutationCrash("publish");
    }
  });
  await assert.rejects(
    fixture.mutations.runLocal(
      request(fixture.v5Hash),
      "renameStory",
      (story) => { story.title = "First committed title"; }
    ),
    (error: unknown) => error instanceof InjectedStoryMutationCrash
  );
  const current = await fixture.stories.loadVersioned(STORY_ID);
  const next = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    { ledger: fixture.ledger, now: () => FIXED_NOW }
  );
  await next.init();
  const committed = await next.runLocal(
    requestFor(OTHER_MUTATION_ID, OTHER_FINGERPRINT, current.aggregateVersion!),
    "renameStory",
    (story) => { story.title = "Second committed title"; }
  );
  assert.equal(committed.story.title, "Second committed title");
  assert.equal(
    (await fixture.ledger.loadStoryReceipt(`story:${STORY_ID}`, MUTATION_ID))
      .completed !== null,
    true
  );
});

test("Q local edits preserve an earlier unresolved provider fence", async (t) => {
  const fixture = await setup(t, "1667-q-local-with-provider-fence-");
  await makeProviderOutcomeUnknown(fixture);
  const current = await fixture.stories.loadVersioned(STORY_ID);
  const committed = await fixture.mutations.runLocal(
    requestFor(OTHER_MUTATION_ID, OTHER_FINGERPRINT, current.aggregateVersion!),
    "renameStory",
    (story) => { story.title = "Edited around unknown generation"; }
  );
  assert.equal(committed.story.title, "Edited around unknown generation");
  const persisted = parseStoryManifestBytes(
    await readFile(fixture.manifestFile),
    STORY_ID
  );
  assert.equal(persisted.kind, "v6-live");
  if (persisted.kind !== "v6-live") assert.fail("Expected live V6");
  assert.equal(persisted.manifest.unresolvedProvider?.mutationId, MUTATION_ID);
});

test("Q blocks a different provider mutation before creating phantom ambiguity", async (t) => {
  const fixture = await setup(t, "1667-q-provider-fence-other-id-");
  await makeProviderOutcomeUnknown(fixture);
  const current = await fixture.stories.loadVersioned(STORY_ID);
  let called = false;
  await assert.rejects(
    fixture.mutations.runProvider(
      requestFor(
        OTHER_MUTATION_ID,
        OTHER_FINGERPRINT,
        current.aggregateVersion!
      ),
      "rewriteNode",
      async () => {
        called = true;
        return true;
      },
      () => true
    ),
    hasServiceError("generation_outcome_unknown")
  );
  assert.equal(called, false);
  assert.deepEqual(
    await fixture.ledger.loadStoryReceipt(
      `story:${STORY_ID}`,
      OTHER_MUTATION_ID
    ),
    { started: null, prepared: null, completed: null, acknowledged: null }
  );
});

test("Q acknowledgement clears an unknown provider outcome and terminalizes both receipts", async (t) => {
  const fixture = await setup(t, "1667-q-ack-");
  await makeProviderOutcomeUnknown(fixture);
  const startedVersion = await fixture.stories.loadVersioned(STORY_ID);
  assert.deepEqual(startedVersion.aggregateVersion, {
    kind: "v6",
    revision: "00000000000000000002"
  });

  const committed = await fixture.mutations.runAcknowledge(
    requestFor(OTHER_MUTATION_ID, OTHER_FINGERPRINT, startedVersion.aggregateVersion!),
    MUTATION_ID
  );
  assert.equal(committed.story?.title, "Original");
  assert.equal(committed.result.storyRevision, "00000000000000000003");

  const original = await fixture.ledger.loadStoryReceipt(`story:${STORY_ID}`, MUTATION_ID);
  assert.equal(original.acknowledged?.acknowledgementMutationId, OTHER_MUTATION_ID);
  const acknowledgement = await fixture.ledger.loadStoryReceipt(
    `story:${STORY_ID}`,
    OTHER_MUTATION_ID
  );
  assert.equal(acknowledgement.prepared?.purpose, "provider-acknowledgement");
  assert.notEqual(acknowledgement.completed, null);

  await assert.rejects(
    fixture.mutations.runProvider(
      request(fixture.v5Hash),
      "autonameStory",
      async () => assert.fail("acknowledged provider work must not repeat"),
      () => null
    ),
    hasServiceError("generation_outcome_unknown_acknowledged")
  );

  const replay = await fixture.mutations.runAcknowledge(
    requestFor(OTHER_MUTATION_ID, OTHER_FINGERPRINT, startedVersion.aggregateVersion!),
    MUTATION_ID
  );
  assert.deepEqual(replay.result, committed.result);
});

for (const status of [null, 408, 500] as const) {
  test(`Q terminalizes local state after ${status ?? "transport"} provider failure`, async (t) => {
    const fixture = await setup(t, `1667-q-provider-terminal-${status ?? "transport"}-`);
    await assert.rejects(
      fixture.mutations.runProvider(
        request(fixture.v5Hash),
        "autonameStory",
        async (_stories, providerStarted) => {
          await providerStarted();
          throw new ProviderError("Provider reply was not definitive", status);
        },
        () => null
      ),
      (error: unknown) => error instanceof ProviderError
    );
    let retried = false;
    await assert.rejects(
      fixture.mutations.runProvider(
        request(fixture.v5Hash),
        "autonameStory",
        async () => {
          retried = true;
          return null;
        },
        () => null
      ),
      hasServiceError("provider_failure")
    );
    assert.equal(retried, false);
    const current = await fixture.stories.loadVersioned(STORY_ID);
    const committed = await fixture.mutations.runLocal(
      requestFor(
        OTHER_MUTATION_ID,
        OTHER_FINGERPRINT,
        current.aggregateVersion!
      ),
      "renameStory",
      (story) => { story.title = "Provider failure did not fence local work"; }
    );
    assert.equal(
      committed.story.title,
      "Provider failure did not fence local work"
    );
  });
}

test("Q unknown-outcome status fails closed without exact started evidence", async (t) => {
  const fixture = await setup(t, "1667-q-status-started-");
  await makeProviderOutcomeUnknown(fixture);
  const receipt = await fixture.ledger.loadStoryReceipt(
    `story:${STORY_ID}`,
    MUTATION_ID
  );
  assert.notEqual(receipt.started, null);
  await fixture.ledger.removeOrphanStartedStoryReceipt(
    `story:${STORY_ID}`,
    MUTATION_ID,
    hashStartedMutationRecord(receipt.started!)
  );
  await assert.rejects(
    fixture.mutations.getUnknownOutcomeStatus(STORY_ID, MUTATION_ID),
    hasServiceError("internal")
  );
});

test("Q status retains a warning while provider terminal publication is incomplete", async (t) => {
  let injected = false;
  const fixture = await setup(
    t,
    "1667-q-status-prepared-",
    {
      afterPrepared: () => {
        if (injected) return;
        injected = true;
        throw new InjectedStoryMutationCrash("prepared");
      }
    }
  );
  await assert.rejects(
    fixture.mutations.runProvider(
      request(fixture.v5Hash),
      "autonameStory",
      async (_stories, providerStarted) => {
        await providerStarted();
        throw new ProviderError("Rejected", 400);
      },
      () => null
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
  await assert.rejects(
    recovered.getUnknownOutcomeStatus(STORY_ID, MUTATION_ID),
    hasServiceError("internal")
  );
});

for (const failure of [
  new ProviderError("Request rejected", 400),
  new GenerationResultError(502, "Response completed without an admissible result")
]) {
  test(`Q terminalizes definitive provider failure: ${failure.name}`, async (t) => {
    const fixture = await setup(t, `1667-q-provider-terminal-${failure.name}-`);
    await assert.rejects(
      fixture.mutations.runProvider(
        request(fixture.v5Hash),
        "autonameStory",
        async (_stories, providerStarted) => {
          await providerStarted();
          throw failure;
        },
        () => null
      )
    );
    const stored = await fixture.ledger.loadStoryReceipt(
      `story:${STORY_ID}`,
      MUTATION_ID
    );
    assert.equal(stored.prepared?.result.kind, "error");
    assert.notEqual(stored.completed, null);
    const persisted = parseStoryManifestBytes(
      await readFile(fixture.manifestFile),
      STORY_ID
    );
    assert.equal(persisted.kind, "v6-live");
    if (persisted.kind !== "v6-live") assert.fail("Expected live V6");
    assert.equal(persisted.manifest.unresolvedProvider, null);
    await assert.rejects(
      fixture.mutations.runProvider(
        request(fixture.v5Hash),
        "autonameStory",
        async () => assert.fail("terminal provider failure must not repeat"),
        () => null
      ),
      hasServiceError("provider_failure")
    );
  });
}

test("Q deletion preserves an unknown provider pointer until deleted acknowledgement", async (t) => {
  const fixture = await setup(t, "1667-q-deleted-ack-");
  await makeProviderOutcomeUnknown(fixture);
  await fixture.mutations.runDelete(requestFor(
    DELETE_MUTATION_ID,
    "c".repeat(64),
    { kind: "v6", revision: "00000000000000000002" }
  ));
  let parsed = parseStoryManifestBytes(
    await readFile(fixture.manifestFile),
    STORY_ID
  );
  assert.equal(parsed.kind, "v6-deleted");
  if (parsed.kind !== "v6-deleted") assert.fail("Expected deleted V6");
  assert.equal(parsed.manifest.unresolvedProvider?.mutationId, MUTATION_ID);
  assert.deepEqual(
    await fixture.mutations.getUnknownOutcomeStatus(STORY_ID, MUTATION_ID),
    {
      state: "pending",
      deleted: true,
      aggregateVersion: {
        kind: "v6",
        revision: "00000000000000000003"
      }
    }
  );

  const acknowledged = await fixture.mutations.runAcknowledge(
    requestFor(
      ACK_MUTATION_ID,
      "d".repeat(64),
      { kind: "v6", revision: "00000000000000000003" }
    ),
    MUTATION_ID
  );
  assert.equal(acknowledged.story, null);
  assert.equal(acknowledged.result.storyRevision, "00000000000000000004");
  parsed = parseStoryManifestBytes(
    await readFile(fixture.manifestFile),
    STORY_ID
  );
  assert.equal(parsed.kind, "v6-deleted");
  if (parsed.kind !== "v6-deleted") assert.fail("Expected deleted V6");
  assert.equal(parsed.manifest.unresolvedProvider, null);
  assert.deepEqual(
    await fixture.mutations.getUnknownOutcomeStatus(STORY_ID, MUTATION_ID),
    { state: "resolved", deleted: true }
  );
  const reaper = new StoryReaper(
    fixture.dataDir,
    createMutationCoordinator(),
    {
      now: () => new Date(
        FIXED_NOW.getTime() + STORY_REAP_RETENTION_MS
      )
    }
  );
  assert.equal(await reaper.reapIfEligible(STORY_ID), true);
  assert.deepEqual(
    await fixture.mutations.getUnknownOutcomeStatus(STORY_ID, MUTATION_ID),
    { state: "resolved", deleted: true }
  );
});

test("Q deletion publishes cleanup intent before its tombstone", async (t) => {
  const fixture = await setup(t, "1667-q-delete-cleanup-");
  const crashing = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    {
      ledger: fixture.ledger,
      now: () => FIXED_NOW,
      hooks: {
        afterPublish: () => {
          throw new InjectedStoryMutationCrash("publish");
        }
      }
    }
  );
  await crashing.init();
  await assert.rejects(
    crashing.runDelete(requestFor(
      DELETE_MUTATION_ID,
      OTHER_FINGERPRINT,
      { kind: "v5", manifestHash: fixture.v5Hash }
    )),
    (error: unknown) => error instanceof InjectedStoryMutationCrash
  );
  await access(path.join(
    path.dirname(fixture.manifestFile),
    CLEANUP_MARKER_FILENAME
  ));
});

for (const point of ["stage", "prepared", "publish", "acknowledged", "completed"] as const) {
  test(`Q acknowledgement recovers a crash after ${point}`, async (t) => {
    const fixture = await setup(t, `1667-q-ack-crash-${point}-`);
    await makeProviderOutcomeUnknown(fixture);
    const started = await fixture.stories.loadVersioned(STORY_ID);
    let injected = false;
    const hooks: StoryMutationStoreHooks = {
      [`after${capitalize(point)}`]: () => {
        if (injected) return;
        injected = true;
        throw new InjectedStoryMutationCrash(point);
      }
    };
    const crashing = new StoryMutationStore(
      fixture.stories,
      createMutationCoordinator(),
      fixture.dataDir,
      { ledger: fixture.ledger, hooks, now: () => FIXED_NOW }
    );
    await crashing.init();
    const acknowledgementRequest = requestFor(
      OTHER_MUTATION_ID,
      OTHER_FINGERPRINT,
      started.aggregateVersion!
    );
    await assert.rejects(
      crashing.runAcknowledge(acknowledgementRequest, MUTATION_ID),
      (error: unknown) => error instanceof InjectedStoryMutationCrash
    );

    const recovered = new StoryMutationStore(
      fixture.stories,
      createMutationCoordinator(),
      fixture.dataDir,
      { ledger: fixture.ledger, now: () => FIXED_NOW }
    );
    await recovered.init();
    const result = await recovered.runAcknowledge(
      acknowledgementRequest,
      MUTATION_ID
    );
    assert.equal(result.result.storyRevision, "00000000000000000003");
    const original = await fixture.ledger.loadStoryReceipt(
      `story:${STORY_ID}`,
      MUTATION_ID
    );
    const acknowledgement = await fixture.ledger.loadStoryReceipt(
      `story:${STORY_ID}`,
      OTHER_MUTATION_ID
    );
    assert.notEqual(original.acknowledged, null);
    assert.notEqual(acknowledgement.completed, null);
  });
}

async function makeProviderOutcomeUnknown(
  fixture: Awaited<ReturnType<typeof setup>>
): Promise<void> {
  await assert.rejects(
    fixture.mutations.runProvider(
      request(fixture.v5Hash),
      "autonameStory",
      async (_stories, providerStarted) => {
        await providerStarted();
        throw new ServiceError(503, "Provider reply was lost", "internal");
      },
      () => null
    ),
    hasServiceError("internal")
  );
}

function capitalize(value: string): string {
  return `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function hasFsCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && "code" in error && error.code === code;
}

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_FACT_CONSISTENCY_PART_CHARS,
  hashFactConsistencyRun,
  type FactConsistencyRun
} from "../shared/fact-consistency-types.js";
import { createDurableMutationId } from "../shared/durable-mutation-id.js";
import type { StoryPayload } from "../shared/types.js";
import { MUTATION_RECEIPT_DIRECTORY } from "../server/chapter-break-undo-liveness.js";
import { createMutationCoordinator } from "../server/mutation-coordinator.js";
import { MutationLedgerStore } from "../server/mutation-ledger-store.js";
import { MutationReceiptStore } from "../server/mutation-receipts.js";
import { mutationFingerprint } from "../server/mutation-receipts.js";
import { ProviderRecoveryRequiredError } from "../server/errors.js";
import { LEGACY_PROMPT_CACHE_CONTEXT, PromptCacheRuntime } from "../server/provider-cache-policy.js";
import { buildStoryPayload } from "../server/story-payload.js";
import { StoryServiceFactConsistency } from "../server/story-service-fact-consistency.js";
import { StoryObjectStore } from "../server/story-objects.js";
import { StoryMutationStore } from "../server/story-mutation-store.js";
import { reduceStoryV6 } from "../server/story-v6-reducer.js";
import { StoryStore } from "../server/stories.js";
import { executeWorkerMutation, parseWorkerMutation } from "../server/worker-mutations.js";
import type { SettingsStore } from "../server/settings.js";
import type { StoryService } from "../server/story-service.js";
import type { GenerationSettings, Story } from "../shared/types.js";
import {
  FINGERPRINT,
  OTHER_FINGERPRINT,
  providerOperation,
  requestFor,
  STORY_ID,
  storyFixture
} from "./story-mutation-fixtures.js";

test("a completed Fact consistency receipt replays its run after a newer run replaces the pointer", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-fact-consistency-receipt-replay-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const storyDir = path.join(dir, "stories");
  let receipts!: MutationReceiptStore;
  const stories = new StoryStore(storyDir, {
    liveFactConsistencyRunIds: (storyId) => receipts.liveFactConsistencyRunIds(storyId)
  });
  await stories.init();
  await stories.save(storyFixture());
  const ledger = new MutationLedgerStore(dir);
  const mutations = new StoryMutationStore(
    stories,
    createMutationCoordinator(),
    dir,
    { ledger }
  );
  await mutations.init();

  receipts = new MutationReceiptStore(
    path.join(dir, MUTATION_RECEIPT_DIRECTORY),
    async (storyId) => buildStoryPayload(await stories.load(storyId)),
    undefined,
    undefined,
    undefined,
    async (storyId, runId, runHash) => {
      const run = await stories.loadFactConsistencyRun(storyId, runHash);
      if (run === null || run.runId !== runId) {
        throw new Error("Fact consistency run is no longer available");
      }
      return {
        run,
        payload: buildStoryPayload(await stories.load(storyId))
      };
    }
  );
  await receipts.init();

  const runA = factConsistencyRun("run-a", "The first report.");
  const runB = factConsistencyRun("run-b", "The replacement report.");
  const mutationIdA = createDurableMutationId();
  const mutationIdB = createDurableMutationId();
  const input = {
    storyId: storyFixture().id,
    focusedPartId: "part",
    scope: "chapter" as const
  };
  const commit = async (
    mutationId: string,
    fingerprint: string,
    expectedAggregateVersion: Parameters<typeof requestFor>[2],
    run: FactConsistencyRun
  ) =>
    await receipts.run(
      mutationId,
      "checkFactConsistency",
      input,
      async () => {
        const committed = await mutations.runProviderOperation(
          requestFor(mutationId, fingerprint, expectedAggregateVersion),
          "checkFactConsistency",
          providerOperation(
            async (providerStories, providerStarted) => {
              await providerStarted();
              await providerStories.commitProviderEffect(input.storyId, {
                kind: "fact-consistency",
                run
              });
              return run.runId;
            },
            () => run.runId
          )
        );
        return {
          run,
          payload: buildStoryPayload(committed.story, committed.aggregateVersion)
        };
      },
      undefined,
      () => undefined
    );

  const initialVersion = (await stories.loadVersioned(STORY_ID)).aggregateVersion!;
  await commit(mutationIdA, FINGERPRINT, initialVersion, runA);
  const runAHash = hashFactConsistencyRun(runA);
  const runBVersion = (await stories.loadVersioned(STORY_ID)).aggregateVersion!;
  await commit(mutationIdB, OTHER_FINGERPRINT, runBVersion, runB);
  await stories.waitForMaintenance();

  const objects = new StoryObjectStore(path.join(storyDir, input.storyId));
  await objects.init();
  assert.deepEqual(await objects.readFactConsistencyRun(runAHash), runA);
  assert.deepEqual(
    (await stories.loadFactConsistencyRun(input.storyId)),
    runB
  );

  const replayed = await receipts.run(
    mutationIdA,
    "checkFactConsistency",
    input,
    async (): Promise<{ run: FactConsistencyRun; payload: StoryPayload }> => {
      throw new Error("completed check must not execute again");
    },
    undefined,
    () => undefined
  );
  assert.deepEqual(replayed.run, runA);
  assert.equal((replayed.payload as StoryPayload).id, input.storyId);
});

test("Fact consistency receipts store and replay only the matching run pointer", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-fact-consistency-receipt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const payload = { ...storyFixturePayload(), hasFactConsistencyRun: true as const };
  const run = factConsistencyRun("fact-run-1", "private contradiction text");
  let latestRunId = run.runId;
  const store = new MutationReceiptStore(
    dir,
    async () => payload,
    undefined,
    undefined,
    undefined,
    async (storyId, runId) => {
      assert.equal(storyId, payload.id);
      if (runId !== latestRunId) throw new Error("Fact consistency run is no longer available");
      return { run, payload };
    }
  );
  await store.init();
  const mutationId = createDurableMutationId();
  const input = { storyId: payload.id, focusedPartId: "part", scope: "chapter" as const };
  const result = { run, payload };
  assert.deepEqual(
    await store.run(
      mutationId,
      "checkFactConsistency",
      input,
      async () => result,
      undefined,
      () => undefined
    ),
    result
  );
  const receipt = await readFile(path.join(dir, `${mutationId}.json`), "utf8");
  assert.equal(receipt.includes("private contradiction text"), false);
  assert.deepEqual(JSON.parse(receipt).result, {
    type: "fact-consistency",
    id: payload.id,
    runId: run.runId,
    runHash: hashFactConsistencyRun(run)
  });
  assert.deepEqual(
    await store.run(
      mutationId,
      "checkFactConsistency",
      input,
      async () => { throw new Error("completed check must not execute again"); },
      undefined,
      () => undefined
    ),
    result
  );

  latestRunId = "fact-run-2";
  await assert.rejects(
    store.run(
      mutationId,
      "checkFactConsistency",
      input,
      async () => result,
      undefined,
      () => undefined
    ),
    /no longer available/u
  );
});

test("worker retry publishes a leased Fact run after a terminal-publication crash cut", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-fact-consistency-worker-recovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storyDir = path.join(dir, "stories");
  const story = storyWithFact();
  let receipts!: MutationReceiptStore;
  const stories = new StoryStore(storyDir, {
    liveFactConsistencyRunIds: (storyId) => receipts.liveFactConsistencyRunIds(storyId)
  });
  await stories.init();
  await stories.save(storyFixture());
  await stories.save(story);
  const ledger = new MutationLedgerStore(dir);
  const mutations = new StoryMutationStore(
    stories,
    createMutationCoordinator(),
    dir,
    { ledger }
  );
  await mutations.init();
  const settings = dryRunSettings();
  const factService = createFactService(stories, mutations, settings);
  const input = {
    storyId: story.id,
    focusedPartId: "part",
    scope: "story-line" as const
  };
  const plan = await factService.plan(input);
  const checkedInput = { ...input, planToken: plan.planToken };
  const parsed = parseWorkerMutation("checkFactConsistency", checkedInput);
  const mutationId = createDurableMutationId();
  const expectedAggregateVersion = (await stories.loadVersioned(story.id)).aggregateVersion!;
  const storyMutationRequest = {
    transportOperationId: "fact-consistency-crash-cut",
    mutationId,
    fingerprint: mutationFingerprint("checkFactConsistency", checkedInput),
    scope: `story:${story.id}` as const,
    expectedAggregateVersion
  };
  const receiptDir = path.join(dir, MUTATION_RECEIPT_DIRECTORY);
  const resolveFact = async (storyId: string, runId: string, runHash?: string) => {
    const run = await stories.loadFactConsistencyRun(storyId, runHash);
    if (run === null || run.runId !== runId) throw new Error("Fact run is missing");
    return { run, payload: buildStoryPayload(await stories.load(storyId)) };
  };
  receipts = new MutationReceiptStore(
    receiptDir,
    async (storyId) => buildStoryPayload(await stories.load(storyId)),
    undefined,
    undefined,
    undefined,
    resolveFact
  );
  await receipts.init();

  let cut = true;
  const faultedService = workerPort(factService, stories);
  const originalCheck = faultedService.checkFactConsistency;
  faultedService.checkFactConsistency = async (value, signal, options) =>
    await originalCheck(value, signal, {
      ...options,
      recordRun: async (run) => {
        await options?.recordRun?.(run);
        if (cut) {
          cut = false;
          throw new Error("crash after Fact run lease");
        }
      }
    });

  await assert.rejects(
    receipts.run(
      mutationId,
      "checkFactConsistency",
      checkedInput,
      async (plan) => await executeWorkerMutation(
        faultedService as unknown as StoryService,
        parsed,
        plan,
        {
          onDelta: () => undefined,
          signal: new AbortController().signal,
          storyMutationRequest
        }
      ),
      undefined,
      () => undefined
    ),
    (error: unknown) => error instanceof ProviderRecoveryRequiredError
  );
  assert.equal(cut, false);
  assert.equal((await receipts.inspect(mutationId))?.state, "provider_started");
  await stories.waitForMaintenance();
  // Simulate a later local prune deleting the checked take while the outer
  // receipt still owns the materialized run. Recovery must use that run leaf,
  // not re-plan against the changed current story.
  await stories.withAggregateSession(story.id, async (session) => {
    const current = await session.loadLive();
    current.nodes = [];
    current.activeRootId = null;
    current.facts = [];
    const replacement = await session.prepareContent(current, {
      asideActivation: false
    });
    const manifest = reduceStoryV6({
      kind: "present",
      manifest: session.snapshot.manifest,
      manifestHash: session.snapshot.manifestHash
    }, {
      kind: "local-committed",
      expectedManifestHash: session.snapshot.manifestHash,
      content: replacement.content,
      summary: replacement.summary
    });
    assert.ok(manifest);
    await session.stageManifest(manifest);
    await session.publishStagedManifest();
  });
  await stories.waitForMaintenance();

  let restartedReceipts!: MutationReceiptStore;
  const restartedStories = new StoryStore(storyDir, {
    liveFactConsistencyRunIds: (storyId) => restartedReceipts.liveFactConsistencyRunIds(storyId)
  });
  await restartedStories.init();
  const restartedLedger = new MutationLedgerStore(dir);
  const restartedMutations = new StoryMutationStore(
    restartedStories,
    createMutationCoordinator(),
    dir,
    { ledger: restartedLedger }
  );
  await restartedMutations.init();
  const restartedFactService = createFactService(
    restartedStories,
    restartedMutations,
    settings
  );
  const restartedService = workerPort(restartedFactService, restartedStories);
  restartedReceipts = new MutationReceiptStore(
    receiptDir,
    async (storyId) => buildStoryPayload(await restartedStories.load(storyId)),
    undefined,
    undefined,
    undefined,
    async (storyId, runId, runHash) => {
      const run = await restartedStories.loadFactConsistencyRun(storyId, runHash);
      if (run === null || run.runId !== runId) throw new Error("Fact run is missing");
      return {
        run,
        payload: buildStoryPayload(await restartedStories.load(storyId))
      };
    }
  );
  await restartedReceipts.init();
  let recovered;
  recovered = await restartedReceipts.run(
    mutationId,
    "checkFactConsistency",
    checkedInput,
    async (plan) => await executeWorkerMutation(
      restartedService as unknown as StoryService,
      parsed,
      plan,
      {
        onDelta: () => undefined,
        signal: new AbortController().signal,
        storyMutationRequest
      }
    ),
    undefined,
    () => undefined
  ) as { run: FactConsistencyRun; payload: StoryPayload };

  assert.equal(recovered.run.format, "1667-fact-consistency-run");
  assert.equal((await restartedReceipts.inspect(mutationId))?.state, "completed");
  assert.deepEqual(await restartedFactService.getRun(story.id), recovered.run);
  const innerReceipt = await restartedLedger.loadStoryReceipt(`story:${story.id}`, mutationId);
  assert.ok(innerReceipt.completed);
  assert.equal(innerReceipt.started?.method, "checkFactConsistency");
});

test("worker recovery reuses an all-unchecked run leased before terminal publication", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-fact-consistency-zero-request-recovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storyDir = path.join(dir, "stories");
  const story = storyWithFact();
  story.nodes[0]!.text = "x".repeat(MAX_FACT_CONSISTENCY_PART_CHARS + 1);
  let receipts!: MutationReceiptStore;
  const stories = new StoryStore(storyDir, {
    liveFactConsistencyRunIds: (storyId) => receipts.liveFactConsistencyRunIds(storyId)
  });
  await stories.init();
  await stories.save(story);
  const ledger = new MutationLedgerStore(dir);
  const mutations = new StoryMutationStore(
    stories,
    createMutationCoordinator(),
    dir,
    { ledger }
  );
  await mutations.init();
  const settings = dryRunSettings();
  const factService = createFactService(stories, mutations, settings);
  const input = {
    storyId: story.id,
    focusedPartId: "part",
    scope: "story-line" as const
  };
  const plan = await factService.plan(input);
  assert.equal(plan.requestCount, 0);
  const checkedInput = { ...input, planToken: plan.planToken };
  const parsed = parseWorkerMutation("checkFactConsistency", checkedInput);
  const mutationId = createDurableMutationId();
  const expectedAggregateVersion = (await stories.loadVersioned(story.id)).aggregateVersion!;
  const storyMutationRequest = {
    transportOperationId: "fact-consistency-zero-request-crash-cut",
    mutationId,
    fingerprint: mutationFingerprint("checkFactConsistency", checkedInput),
    scope: `story:${story.id}` as const,
    expectedAggregateVersion
  };
  const receiptDir = path.join(dir, MUTATION_RECEIPT_DIRECTORY);
  const resolveFact = async (storyId: string, runId: string, runHash?: string) => {
    const run = await stories.loadFactConsistencyRun(storyId, runHash);
    if (run === null || run.runId !== runId) throw new Error("Fact run is missing");
    return { run, payload: buildStoryPayload(await stories.load(storyId)) };
  };
  receipts = new MutationReceiptStore(
    receiptDir,
    async (storyId) => buildStoryPayload(await stories.load(storyId)),
    undefined,
    undefined,
    undefined,
    resolveFact
  );
  await receipts.init();

  let cut = true;
  const faultedService = workerPort(factService, stories);
  const originalCheck = faultedService.checkFactConsistency;
  faultedService.checkFactConsistency = async (value, signal, options) =>
    await originalCheck(value, signal, {
      ...options,
      recordRun: async (run) => {
        await options?.recordRun?.(run);
        if (cut) {
          cut = false;
          throw new Error("crash after zero-request Fact run lease");
        }
      }
    });

  await assert.rejects(
    receipts.run(
      mutationId,
      "checkFactConsistency",
      checkedInput,
      async (plan) => await executeWorkerMutation(
        faultedService as unknown as StoryService,
        parsed,
        plan,
        {
          onDelta: () => undefined,
          signal: new AbortController().signal,
          storyMutationRequest
        }
      ),
      undefined,
      () => undefined
    ),
    (error: unknown) => error instanceof ProviderRecoveryRequiredError
  );
  assert.equal((await receipts.inspect(mutationId))?.state, "provider_started");

  let restartedReceipts!: MutationReceiptStore;
  const restartedStories = new StoryStore(storyDir, {
    liveFactConsistencyRunIds: (storyId) => restartedReceipts.liveFactConsistencyRunIds(storyId)
  });
  await restartedStories.init();
  const restartedLedger = new MutationLedgerStore(dir);
  const restartedMutations = new StoryMutationStore(
    restartedStories,
    createMutationCoordinator(),
    dir,
    { ledger: restartedLedger }
  );
  await restartedMutations.init();
  const restartedService = workerPort(
    createFactService(restartedStories, restartedMutations, settings),
    restartedStories
  );
  restartedReceipts = new MutationReceiptStore(
    receiptDir,
    async (storyId) => buildStoryPayload(await restartedStories.load(storyId)),
    undefined,
    undefined,
    undefined,
    async (storyId, runId, runHash) => {
      const run = await restartedStories.loadFactConsistencyRun(storyId, runHash);
      if (run === null || run.runId !== runId) throw new Error("Fact run is missing");
      return {
        run,
        payload: buildStoryPayload(await restartedStories.load(storyId))
      };
    }
  );
  await restartedReceipts.init();
  const recovered = await restartedReceipts.run(
    mutationId,
    "checkFactConsistency",
    checkedInput,
    async (plan) => await executeWorkerMutation(
      restartedService as unknown as StoryService,
      parsed,
      plan,
      {
        onDelta: () => undefined,
        signal: new AbortController().signal,
        storyMutationRequest
      }
    ),
    undefined,
    () => undefined
  ) as { run: FactConsistencyRun; payload: StoryPayload };

  assert.equal(recovered.run.parts[0]!.findings.length, 0);
  assert.match(recovered.run.parts[0]!.uncheckedReason ?? "", /size limit/u);
  assert.equal((await restartedReceipts.inspect(mutationId))?.state, "completed");
});

test("Fact consistency check requires an unchanged confirmed plan", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-fact-consistency-plan-binding-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(path.join(dir, "stories"));
  await stories.init();
  const story = storyWithFact();
  await stories.save(story);
  const ledger = new MutationLedgerStore(dir);
  const mutations = new StoryMutationStore(
    stories,
    createMutationCoordinator(),
    dir,
    { ledger }
  );
  await mutations.init();
  const service = createFactService(stories, mutations, dryRunSettings());
  const input = {
    storyId: story.id,
    focusedPartId: "part",
    scope: "story-line" as const
  };

  await assert.rejects(
    service.check(input, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 400);
      assert.match(error.message, /requires the current plan token/u);
      return true;
    }
  );
  const plan = await service.plan(input);
  await stories.mutate(story.id, (current) => {
    current.nodes[0]!.text = "Changed after planning.";
  });
  await assert.rejects(
    service.check({ ...input, planToken: plan.planToken }, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 409);
      assert.match(error.message, /plan is stale/u);
      return true;
    }
  );
  assert.equal(await service.getRun(story.id), null);
});

test("Fact consistency materializes its run before leasing the receipt", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-fact-consistency-receipt-pin-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const payload = { ...storyFixturePayload(), id: STORY_ID };
  const run = factConsistencyRun("pinned-run", "Pinned report.");
  const runHash = hashFactConsistencyRun(run);
  const receiptStore = new MutationReceiptStore(
    path.join(dir, MUTATION_RECEIPT_DIRECTORY),
    async () => payload
  );
  const stories = new StoryStore(path.join(dir, "stories"), {
    liveFactConsistencyRunIds: (storyId) => receiptStore.liveFactConsistencyRunIds(storyId)
  });
  await stories.init();
  await stories.save(storyFixture());
  await receiptStore.init();

  let leafVisibleBeforeLease = false;
  await receiptStore.run(
    createDurableMutationId(),
    "checkFactConsistency",
    { storyId: payload.id, focusedPartId: "part", scope: "chapter" },
    async (plan) => {
      await stories.materializeFactConsistencyRun(payload.id, run, async () => {
        const objects = new StoryObjectStore(path.join(dir, "stories", payload.id));
        await objects.init();
        assert.deepEqual(await objects.readFactConsistencyRun(runHash), run);
        leafVisibleBeforeLease = true;
        await plan.recordFactConsistencyRun(payload.id, run);
      });
      return { run, payload };
    },
    undefined,
    () => undefined
  );
  assert.equal(leafVisibleBeforeLease, true);
  assert.equal(receiptStore.liveFactConsistencyRunIds(payload.id).includes(runHash), true);
  await stories.waitForMaintenance();
  const objects = new StoryObjectStore(path.join(dir, "stories", payload.id));
  await objects.init();
  assert.deepEqual(await objects.readFactConsistencyRun(runHash), run);
});

test("a leased Fact consistency leaf survives a pre-manifest crash cut", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-fact-consistency-receipt-crash-cut-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const payload = { ...storyFixturePayload(), id: STORY_ID };
  const run = factConsistencyRun("crash-cut-run", "Crash-cut report.");
  const runHash = hashFactConsistencyRun(run);
  const receiptStore = new MutationReceiptStore(
    path.join(dir, MUTATION_RECEIPT_DIRECTORY),
    async () => payload
  );
  const stories = new StoryStore(path.join(dir, "stories"), {
    liveFactConsistencyRunIds: (storyId) => receiptStore.liveFactConsistencyRunIds(storyId)
  });
  await stories.init();
  await stories.save(storyFixture());
  await receiptStore.init();

  await assert.rejects(
    receiptStore.run(
      createDurableMutationId(),
      "checkFactConsistency",
      { storyId: payload.id, focusedPartId: "part", scope: "chapter" },
      async (plan) => {
        await stories.materializeFactConsistencyRun(payload.id, run, async () => {
          await plan.recordFactConsistencyRun(payload.id, run);
        });
        throw new Error("cut before manifest publication");
      },
      undefined,
      () => undefined
    ),
    /cut before manifest publication/u
  );

  assert.equal(receiptStore.liveFactConsistencyRunIds(payload.id).includes(runHash), true);
  await stories.waitForMaintenance();
  const objects = new StoryObjectStore(path.join(dir, "stories", payload.id));
  await objects.init();
  assert.deepEqual(await objects.readFactConsistencyRun(runHash), run);
});

test("Fact consistency receipt run liveness preserves every replayable receipt", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-fact-consistency-receipt-bound-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const story = storyFixture();
  const payload = { ...storyFixturePayload(), id: story.id };
  const input = { storyId: payload.id, focusedPartId: "part", scope: "chapter" };
  const runById = new Map<string, FactConsistencyRun>();
  let store!: MutationReceiptStore;
  const stories = new StoryStore(path.join(dir, "stories"), {
    liveFactConsistencyRunIds: (storyId) => store.liveFactConsistencyRunIds(storyId)
  });
  await stories.init();
  await stories.save(story);
  store = new MutationReceiptStore(
    path.join(dir, MUTATION_RECEIPT_DIRECTORY),
    async () => payload,
    undefined,
    undefined,
    undefined,
    async (_storyId, runId) => {
      const run = runById.get(runId);
      if (run === undefined) throw new Error("run was collected");
      return { run, payload };
    }
  );
  await store.init();

  const runs: FactConsistencyRun[] = [];
  const receiptCount = 37;
  const mutationIds: string[] = [];
  for (let index = 0; index < receiptCount; index += 1) {
    const run = factConsistencyRun(`bounded-run-${index}`, `Report ${index}.`);
    runs.push(run);
    runById.set(run.runId, run);
    const mutationId = createDurableMutationId();
    mutationIds.push(mutationId);
    await store.run(
      mutationId,
      "checkFactConsistency",
      input,
      async (plan) => {
        await stories.materializeFactConsistencyRun(payload.id, run, async () => {
          await plan.recordFactConsistencyRun(payload.id, run);
        });
        return { run, payload };
      },
      undefined,
      () => undefined
    );
  }
  assert.equal(store.liveFactConsistencyRunIds(payload.id).length, receiptCount);
  await stories.waitForMaintenance();
  const objects = new StoryObjectStore(path.join(dir, "stories", payload.id));
  await objects.init();
  assert.deepEqual(
    await objects.readFactConsistencyRun(hashFactConsistencyRun(runs[0]!)),
    runs[0]
  );
  assert.deepEqual(
    await objects.readFactConsistencyRun(hashFactConsistencyRun(runs[runs.length - 1]!)),
    runs[runs.length - 1]
  );

  const rehydrated = new MutationReceiptStore(
    path.join(dir, MUTATION_RECEIPT_DIRECTORY),
    async () => payload,
    undefined,
    undefined,
    undefined,
    async (_storyId, runId) => {
      const run = runById.get(runId);
      if (run === undefined) throw new Error("run was collected");
      return { run, payload };
    }
  );
  await rehydrated.init();
  const retained = rehydrated.liveFactConsistencyRunIds(payload.id);
  assert.equal(retained.length, receiptCount);
  assert.equal(retained.includes(hashFactConsistencyRun(runs[0]!)), true);
  assert.equal(retained.includes(hashFactConsistencyRun(runs[runs.length - 1]!)), true);
  const replayed = await rehydrated.run(
    mutationIds[0]!,
    "checkFactConsistency",
    input,
    async () => { throw new Error("completed check must not execute again"); },
    undefined,
    () => undefined
  );
  assert.deepEqual((replayed as { run: FactConsistencyRun }).run, runs[0]);
});

function storyFixturePayload(): StoryPayload {
  return {
    id: "story",
    title: "Story",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nodes: [],
    path: [],
    activeRootId: null,
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: []
  };
}

function storyWithFact(): Story {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    ...storyFixture(),
    nodes: [{
      id: "part",
      parentId: null,
      instruction: "",
      text: "Mira crossed the square.",
      model: "human",
      createdAt: now,
      activeChildId: null
    }],
    activeRootId: "part",
    facts: [{
      id: "fact",
      tag: null,
      states: [{
        id: "fact",
        text: "Mira is in the square.",
        createdAt: now,
        updatedAt: now
      }],
      activation: "always",
      keys: [],
      createdAt: now,
      updatedAt: now
    }]
  };
}

function dryRunSettings(): GenerationSettings {
  return {
    provider: "dry-run",
    baseUrl: "",
    model: "dry-run",
    apiKeyEnv: null,
    temperature: 0.9,
    maxTokens: 128,
    systemPrompt: "",
    contextWindow: null
  };
}

function createFactService(
  stories: StoryStore,
  mutations: StoryMutationStore,
  settings: GenerationSettings
): StoryServiceFactConsistency {
  const settingsStore = {
    loadGeneration: async () => ({
      settings,
      promptCache: LEGACY_PROMPT_CACHE_CONTEXT,
      imageInputCapability: null,
      writing: null
    }),
    assertProviderRequestSupported: () => {}
  } as unknown as SettingsStore;
  return new StoryServiceFactConsistency({
    stories,
    settings: settingsStore,
    storyMutations: mutations,
    promptCache: new PromptCacheRuntime(),
    cancellable: async (signal, work) => await work(signal)
  });
}

function workerPort(
  service: StoryServiceFactConsistency,
  stories: StoryStore
): {
  readonly stories: StoryStore;
  getFactConsistencyRun: StoryServiceFactConsistency["getRun"];
  checkFactConsistency: StoryServiceFactConsistency["check"];
} {
  return {
    stories,
    getFactConsistencyRun: service.getRun.bind(service),
    checkFactConsistency: service.check.bind(service)
  };
}

function factConsistencyRun(runId: string, statement: string): FactConsistencyRun {
  return {
    format: "1667-fact-consistency-run",
    schemaVersion: 1,
    runId,
    scope: "chapter",
    anchor: { partId: "part", takeId: "part" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    provider: { profile: "utility", preset: "dry-run", model: "dry-run" },
    storyLineTakeIds: ["part"],
    parts: [{
      partId: "part",
      takeId: "part",
      findings: [{ fact_id: "fact", quote: "text", statement }],
      droppedFindings: 0
    }],
    droppedFindings: 0
  };
}

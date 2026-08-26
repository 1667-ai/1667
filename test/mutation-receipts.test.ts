import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LEGACY_WORKER_PROTOCOL_VERSION,
  MUTATION_INPUT_PROTOCOL_VERSION,
  MUTATION_ID_RETRY_WINDOW_MS,
  PRE_DIAGNOSTIC_WORKER_PROTOCOL_VERSION,
  PRE_PROVIDER_RECOVERY_WORKER_PROTOCOL_VERSION,
  PRE_Q_WORKER_PROTOCOL_VERSION,
  PREDECESSOR_WORKER_PROTOCOL_VERSION,
  WORKER_PROTOCOL_VERSION,
  type MutatingWorkerMethod
} from "../shared/worker-protocol.js";
import type { StoryPayload } from "../shared/types.js";
import {
  DurableMutationResultError,
  GenerationResultError,
  ProviderError,
  ProviderRecoveryRequiredError,
  ServiceError
} from "../server/errors.js";
import { chapterBreakRemovalFingerprint } from "../server/chapter-breaks.js";
import { StoryDurabilityError } from "../server/story-lifecycle.js";
import {
  MutationReceiptStore as ProductionMutationReceiptStore,
  MutationReceiptPersistenceError,
  mutationFingerprint,
  validateUnseenMutationId
} from "../server/mutation-receipts.js";
import { parseMutationReceipt } from "../server/mutation-receipt-codec.js";
import type { MutationPlan, MutationPreflightPlan } from "../server/mutation-plan.js";
import type { StoryService } from "../server/story-service.js";
import { parseWorkerMutation, preflightWorkerMutation } from "../server/worker-mutations.js";

const GENERATION_SETTINGS = {
  provider: "dry-run" as const,
  baseUrl: "",
  model: "fixture",
  apiKeyEnv: null,
  temperature: 0.5,
  maxTokens: 128,
  systemPrompt: "fixture",
  contextWindow: null
};

function completedReceipt(
  method: MutatingWorkerMethod,
  result: unknown
): Record<string, unknown> {
  return {
    format: "1667-mutation",
    schemaVersion: 1,
    mutationId: currentMutationId("a"),
    protocolVersion: WORKER_PROTOCOL_VERSION,
    fingerprint: "a".repeat(64),
    method,
    state: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    result
  };
}

test("Aside receipt result shapes are bound to their methods", () => {
  const mutationId = currentMutationId("a");
  const pointer = {
    ...completedReceipt("askAside", { type: "aside", id: "story" }),
    mutationId
  };
  assert.doesNotThrow(() => parseMutationReceipt(pointer, mutationId));
  const canceled = {
    ...completedReceipt("askAside", { type: "value", value: null }),
    mutationId
  };
  assert.doesNotThrow(() => parseMutationReceipt(canceled, mutationId));
  for (const method of ["askAside", "retakeAside", "asideSessionMutation"] as const) {
    const sessionPointer = {
      ...completedReceipt(method, {
        type: "aside-session",
        storyId: "story",
        sessionId: "session"
      }),
      mutationId
    };
    assert.doesNotThrow(() => parseMutationReceipt(sessionPointer, mutationId));
  }
  for (const result of [
    { type: "value", value: { notes: [] } },
    { type: "story", id: "story" }
  ]) {
    const invalid = {
      ...completedReceipt("askAside", result),
      mutationId
    };
    assert.throws(() => parseMutationReceipt(invalid, mutationId), /corrupt/);
  }
  const wrongMethod = {
    ...completedReceipt("deleteStory", { type: "aside", id: "story" }),
    mutationId
  };
  assert.throws(() => parseMutationReceipt(wrongMethod, mutationId), /corrupt/);
  const wrongSessionPointerMethod = {
    ...completedReceipt("deleteStory", {
      type: "aside-session",
      storyId: "story",
      sessionId: "session"
    }),
    mutationId
  };
  assert.throws(
    () => parseMutationReceipt(wrongSessionPointerMethod, mutationId),
    /corrupt/
  );
});

/** Receipt-mechanics tests opt into admission-neutral execution explicitly;
 * compatibility tests below pass their own preflight. */
class MutationReceiptStore extends ProductionMutationReceiptStore {
  override async run<M extends MutatingWorkerMethod, T>(
    mutationId: string,
    method: M,
    input: unknown,
    work: (plan: MutationPlan<M>) => Promise<T>,
    inputProtocolVersion?: number,
    preflight: (plan: MutationPreflightPlan<M>) => void | Promise<void> = () => undefined
  ): Promise<T> {
    return await super.run(mutationId, method, input, work, inputProtocolVersion, preflight);
  }
}

test("provider recovery starts a new mutation input identity", () => {
  const input = { id: "story", title: "Stable" };

  assert.equal(
    mutationFingerprint(
      "renameStory",
      input,
      PRE_PROVIDER_RECOVERY_WORKER_PROTOCOL_VERSION
    ),
    mutationFingerprint(
      "renameStory",
      input,
      PRE_DIAGNOSTIC_WORKER_PROTOCOL_VERSION
    )
  );
  assert.notEqual(
    mutationFingerprint("renameStory", input, WORKER_PROTOCOL_VERSION),
    mutationFingerprint(
      "renameStory",
      input,
      PRE_PROVIDER_RECOVERY_WORKER_PROTOCOL_VERSION
    )
  );
  assert.equal(MUTATION_INPUT_PROTOCOL_VERSION, WORKER_PROTOCOL_VERSION);
});

test("predecessor chapter removal intents retain their receipt identity", () => {
  assert.deepEqual(
    parseWorkerMutation(
      "removeChapterBreak",
      { storyId: "story", breakId: "break" },
      PRE_Q_WORKER_PROTOCOL_VERSION
    ),
    {
      lane: "pre-q",
      storyId: "story",
      breakId: "break"
    }
  );
});

test("mutation preflight can refuse a new aggregate without creating a legacy receipt", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-mutation-preflight-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new MutationReceiptStore(dir, async () => { throw new Error("unused"); });
  await store.init();
  let calls = 0;
  const input = { id: "future", title: "No write" };
  const parsed = parseWorkerMutation("renameStory", input);
  const service = {
    stories: {
      assertMutationSupported: async (storyId: string) => {
        assert.equal(storyId, "future");
        throw new ServiceError(409, "Requires a successor", "story_manifest_requires_successor");
      }
    }
  } as unknown as StoryService;

  await assert.rejects(
    store.run(
      currentMutationId("30"),
      "renameStory",
      input,
      async () => { calls += 1; return "must not run"; },
      undefined,
      (plan) => preflightWorkerMutation(service, parsed, plan)
    ),
    hasCode("story_manifest_requires_successor")
  );

  assert.equal(calls, 0);
  assert.deepEqual(await readdir(dir), []);
});

test("mutation preflight uses planned aggregate IDs", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-mutation-preflight-targets-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new MutationReceiptStore(dir, async () => { throw new Error("unused"); });
  await store.init();
  const checked: string[] = [];
  const service = {
    stories: {
      assertMutationSupported: async (storyId: string) => { checked.push(storyId); }
    }
  } as unknown as StoryService;

  const createInput = { title: "Fresh" };
  const createParsed = parseWorkerMutation("createStory", createInput);
  await store.run(
    currentMutationId("31"),
    "createStory",
    createInput,
    async (plan) => {
      assert.deepEqual(checked.splice(0), [plan.entityId("story")]);
      return "created";
    },
    undefined,
    (plan) => preflightWorkerMutation(service, createParsed, plan)
  );

  const importInput = { jsonl: "{}" };
  const importParsed = parseWorkerMutation("importSillyTavern", importInput);
  await store.run(
    currentMutationId("32"),
    "importSillyTavern",
    importInput,
    async (plan) => {
      assert.deepEqual(checked.splice(0), [plan.entityId("story")]);
      return "imported";
    },
    undefined,
    (plan) => preflightWorkerMutation(service, importParsed, plan)
  );

  assert.deepEqual(checked, []);
});

test("completed mutation receipts survive restart and reject changed input", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-mutations-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mutationId = currentMutationId("1");
  const payload = storyPayload("story", "Renamed");
  const input = { id: "story", title: "Renamed" };
  let calls = 0;
  const first = new MutationReceiptStore(dir, async () => payload);
  await first.init();
  assert.deepEqual(await first.run(mutationId, "renameStory", input, async () => {
    calls += 1;
    return payload;
  }, PRE_DIAGNOSTIC_WORKER_PROTOCOL_VERSION, () => undefined), payload);

  const restarted = new MutationReceiptStore(dir, async () => payload);
  await restarted.init();
  let preflights = 0;
  assert.deepEqual(await restarted.run(mutationId, "renameStory", input, async () => {
    calls += 1;
    return storyPayload("story", "Wrong");
  }, PRE_DIAGNOSTIC_WORKER_PROTOCOL_VERSION, () => {
    preflights += 1;
    throw new Error("completed receipts resolve before compatibility preflight");
  }), payload);
  assert.equal(calls, 1);
  assert.equal(preflights, 0);
  await assert.rejects(
    restarted.run(
      mutationId,
      "renameStory",
      { id: "story", title: "Different" },
      async () => storyPayload("story", "Different"),
      PRE_DIAGNOSTIC_WORKER_PROTOCOL_VERSION
    ),
    hasCode("idempotency_conflict")
  );
});

test("compound chapter receipts reload current stories without storing full payloads", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-chapter-receipts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const original = storyPayload("story", "Original payload must not persist");
  const current = storyPayload("story", "Current authoritative story");
  let resolutions = 0;
  const store = new MutationReceiptStore(dir, async () => {
    resolutions += 1;
    return current;
  });
  await store.init();

  const createId = currentMutationId("21");
  const createInput = { storyId: "story", parentPartId: "part", title: "Two" };
  await store.run(createId, "createChapterBreak", createInput, async () => ({
    payload: original,
    breakId: "break"
  }));
  const createReceipt = await readFile(path.join(dir, `${createId}.json`), "utf8");
  assert.equal(createReceipt.includes(original.title), false);
  assert.equal(JSON.parse(createReceipt).result.type, "chapter-break-created");
  assert.deepEqual(await store.run(createId, "createChapterBreak", createInput, async () => {
    throw new Error("completed create must not execute again");
  }), { payload: current, breakId: "break" });

  const removed = {
    break: { id: "break", parentPartId: "part", title: "Two", createdAt: "2026-01-01T00:00:00.000Z" },
    summaries: []
  };
  const removeId = currentMutationId("22");
  const removeInput = { storyId: "story", breakId: "break" };
  await store.run(removeId, "removeChapterBreak", removeInput, async () => ({ payload: original, removed }));
  const removeReceipt = await readFile(path.join(dir, `${removeId}.json`), "utf8");
  assert.equal(removeReceipt.includes(original.title), false);
  assert.equal(JSON.parse(removeReceipt).result.type, "chapter-break-removed");
  assert.deepEqual(await store.run(removeId, "removeChapterBreak", removeInput, async () => {
    throw new Error("completed remove must not execute again");
  }), { payload: current, removed });
  assert.equal(resolutions, 2);
});

test("chapter removal artifacts survive pending recovery without entering the request", async (t) => {
  const dir = await mkdtemp(path.join(
    tmpdir(),
    "1667-mutation-removal-artifact-"
  ));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const payload = storyPayload("story", "Current");
  const removed = {
    break: {
      id: "break",
      parentPartId: "part",
      title: "Large undo",
      createdAt: "2026-01-01T00:00:00.000Z"
    },
    summaries: [{
      id: "summary",
      parentId: "part",
      instruction: "Summarize",
      text: "Summary",
      model: "fixture",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      human: true as const,
      genId: "generation",
      role: "summary" as const,
      chapterBreakId: "break",
      coveredExtent: {
        fromPartId: "part",
        toPartId: "part"
      },
      madeAt: "2026-01-01T00:00:00.000Z",
      activeChildId: null
    }]
  };
  const removedFingerprint = chapterBreakRemovalFingerprint(removed);
  const input = { storyId: "story", breakId: "break", removedFingerprint };
  const mutationId = currentMutationId("23");
  let loads = 0;
  let store = new MutationReceiptStore(dir, async () => payload);
  await store.init();
  await assert.rejects(
    store.run(
      mutationId,
      "removeChapterBreak",
      input,
      async (plan) => {
        await plan.preserveChapterBreakRemoval(
          removedFingerprint,
          async () => {
            loads += 1;
            return removed;
          }
        );
        throw new StoryDurabilityError(
          "aggregate committed before outer receipt",
          { cause: new Error("crash") }
        );
      }
    ),
    hasCode("mutation_outcome_unknown")
  );

  store = new MutationReceiptStore(dir, async () => payload);
  await store.init();
  const recovered = await store.run(
    mutationId,
    "removeChapterBreak",
    input,
    async (plan) => ({
      payload,
      removed: await plan.preserveChapterBreakRemoval(
        removedFingerprint,
        async () => {
          loads += 1;
          throw new Error("persisted artifact must win");
        }
      )
    })
  );
  assert.deepEqual(recovered.removed, removed);
  assert.equal(loads, 1);
  const receipt = JSON.parse(
    await readFile(path.join(dir, `${mutationId}.json`), "utf8")
  );
  assert.equal(receipt.result.type, "chapter-break-removed");
  assert.equal("removed" in receipt.result, false);
  assert.deepEqual(
    await store.run(
      mutationId,
      "removeChapterBreak",
      input,
      async () => assert.fail("terminal receipt must replay")
    ),
    recovered
  );
});

test("protocol-v5 removal recovers a pending outer receipt from its exact undo input", async (t) => {
  const dir = await mkdtemp(path.join(
    tmpdir(),
    "1667-mutation-v5-removal-upgrade-"
  ));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const payload = storyPayload("story", "Recovered");
  const removed = {
    break: {
      id: "break",
      parentPartId: "part",
      title: "Chapter",
      createdAt: "2026-01-01T00:00:00.000Z"
    },
    summaries: [{
      id: "summary",
      parentId: "part",
      instruction: "Summarize",
      text: "Exact predecessor undo",
      model: "fixture",
      createdAt: "2026-01-01T00:00:00.000Z",
      human: true as const,
      genId: "generation",
      role: "summary" as const,
      chapterBreakId: "break",
      coveredExtent: {
        fromPartId: "part",
        toPartId: "part"
      },
      madeAt: "2026-01-01T00:00:00.000Z",
      activeChildId: null
    }]
  };
  const input = { storyId: "story", breakId: "break", removed };
  const mutationId = currentMutationId("25");
  await writeReceipt(
    dir,
    mutationId,
    "removeChapterBreak",
    input,
    "pending",
    PREDECESSOR_WORKER_PROTOCOL_VERSION
  );
  const parsed = parseWorkerMutation(
    "removeChapterBreak",
    input,
    PREDECESSOR_WORKER_PROTOCOL_VERSION
  );
  assert.equal(parsed.lane, "q");
  if (parsed.lane !== "q") assert.fail("expected Q removal lane");
  const predecessorRemoved = parsed.predecessorRemoved;
  assert.ok(predecessorRemoved);
  assert.deepEqual(predecessorRemoved, removed);
  assert.equal(
    parsed.removedFingerprint,
    chapterBreakRemovalFingerprint(removed)
  );

  const store = new MutationReceiptStore(dir, async () => payload);
  await store.init();
  const recovered = await store.run(
    mutationId,
    "removeChapterBreak",
    input,
    async (plan) => ({
      payload,
      removed: await plan.preserveChapterBreakRemoval(
        parsed.removedFingerprint,
        async () => predecessorRemoved
      )
    }),
    PREDECESSOR_WORKER_PROTOCOL_VERSION
  );
  assert.deepEqual(recovered, { payload, removed });
  assert.deepEqual(
    await store.run(
      mutationId,
      "removeChapterBreak",
      input,
      async () => assert.fail("upgraded terminal receipt must replay"),
      PREDECESSOR_WORKER_PROTOCOL_VERSION
    ),
    recovered
  );
});

test("same-ID concurrent calls execute once", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-mutation-race-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new MutationReceiptStore(dir, async () => { throw new Error("unused"); });
  await store.init();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const mutationId = currentMutationId("2");
  const first = store.run(mutationId, "deleteStory", { id: "story" }, async () => {
    calls += 1;
    await gate;
    return { ok: true };
  });
  const second = store.run(mutationId, "deleteStory", { id: "story" }, async () => {
    calls += 1;
    return { ok: false };
  });
  release();
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: true }]);
  assert.equal(calls, 1);
});

test("provider admission stays ambiguous while pre-provider work resumes idempotently", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-mutation-ambiguous-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new MutationReceiptStore(dir, async () => { throw new Error("unused"); });
  await store.init();
  const providerId = currentMutationId("3");
  await writeReceipt(dir, providerId, "autonameStory", { id: "story" }, "provider_started");
  await assert.rejects(
    store.run(providerId, "autonameStory", { id: "story" }, async (execution) => {
      await execution.providerStarted();
      return "not reached";
    }, LEGACY_WORKER_PROTOCOL_VERSION),
    hasProviderRecoveryTarget(providerId)
  );

  const pendingId = currentMutationId("4");
  await writeReceipt(dir, pendingId, "renameStory", { id: "story", title: "New" }, "pending");
  let recovered = false;
  assert.equal(await store.run(pendingId, "renameStory", { id: "story", title: "New" }, async (execution) => {
    recovered = execution.recoveryMode !== "new";
    return "recovered";
  }, LEGACY_WORKER_PROTOCOL_VERSION), "recovered");
  assert.equal(recovered, true);
});

test("provider ambiguity survives a worker protocol upgrade", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-mutation-protocol-upgrade-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new MutationReceiptStore(dir, async () => { throw new Error("unused"); });
  await store.init();
  const mutationId = currentMutationId("31");
  const input = { id: "story" };
  await writeReceipt(dir, mutationId, "autonameStory", input, "provider_started", 2);

  await assert.rejects(
    store.run(mutationId, "autonameStory", input, async (execution) => {
      await execution.providerStarted();
      return "must not call provider";
    }),
    hasProviderRecoveryTarget(mutationId)
  );
  await assert.rejects(
    store.run(mutationId, "autonameStory", { id: "changed" }, async () => "must not run"),
    hasProviderRecoveryTarget(mutationId)
  );
});

test("unknown post-provider failures retain their recovery target", async (t) => {
  const dir = await mkdtemp(path.join(
    tmpdir(),
    "1667-mutation-provider-unknown-"
  ));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new MutationReceiptStore(
    dir,
    async () => { throw new Error("unused"); }
  );
  await store.init();
  const mutationId = currentMutationId("32");
  let calls = 0;
  const work = async (execution: { providerStarted(): Promise<void> }) => {
    await execution.providerStarted();
    calls += 1;
    throw new Error("Injected failure after provider admission");
  };

  await assert.rejects(
    store.run(mutationId, "autonameStory", { id: "story" }, work),
    hasProviderRecoveryTarget(mutationId)
  );
  await assert.rejects(
    store.run(mutationId, "autonameStory", { id: "story" }, work),
    hasProviderRecoveryTarget(mutationId)
  );
  assert.equal(calls, 1);
});

test("provider-started receipts can reconcile a known committed result", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-mutation-provider-reconcile-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new MutationReceiptStore(dir, async () => { throw new Error("unused"); });
  await store.init();
  const mutationId = currentMutationId("f");
  const input = { id: "story" };
  await writeReceipt(dir, mutationId, "autonameStory", input, "provider_started");

  let recovery = false;
  assert.equal(await store.run(mutationId, "autonameStory", input, async (execution) => {
    recovery = execution.recoveryMode !== "new";
    return "already committed";
  }, LEGACY_WORKER_PROTOCOL_VERSION), "already committed");
  assert.equal(recovery, true);
  assert.equal(await store.run(
    mutationId, "autonameStory", input, async () => "not called", LEGACY_WORKER_PROTOCOL_VERSION
  ), "already committed");
});

test("post-admission transport failures become terminal local failures", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-mutation-provider-failure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new MutationReceiptStore(dir, async () => { throw new Error("unused"); });
  await store.init();
  const mutationId = currentMutationId("9");
  let calls = 0;
  let requests = 0;
  const work = async (execution: { providerStarted(): Promise<void> }) => {
    calls += 1;
    await execution.providerStarted();
    requests += 1;
    throw new ProviderError("connection reset after admission");
  };

  await assert.rejects(
    store.run(mutationId, "autonameStory", { id: "story" }, work),
    ProviderError
  );
  await assert.rejects(store.run(mutationId, "autonameStory", { id: "story" }, work),
    hasCode("provider_failure"));
  assert.equal(calls, 1);
  assert.equal(requests, 1);
});

test("definitive provider rejections become terminal failures", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-mutation-provider-rejection-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new MutationReceiptStore(dir, async () => { throw new Error("unused"); });
  await store.init();
  const mutationId = currentMutationId("a");
  let calls = 0;
  const work = async (execution: { providerStarted(): Promise<void> }) => {
    calls += 1;
    await execution.providerStarted();
    throw new ProviderError("invalid request", 400);
  };

  await assert.rejects(store.run(mutationId, "autonameStory", { id: "story" }, work), ProviderError);
  await assert.rejects(store.run(mutationId, "autonameStory", { id: "story" }, work), hasCode("provider_failure"));
  assert.equal(calls, 1);
});

test("durably recovered provider failures remain terminal in the outer receipt", async (t) => {
  const dir = await mkdtemp(path.join(
    tmpdir(),
    "1667-mutation-durable-provider-failure-"
  ));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new MutationReceiptStore(
    dir,
    async () => { throw new Error("unused"); }
  );
  await store.init();
  const mutationId = currentMutationId("24");
  const input = { id: "story", expectedTitle: "Original" };
  await assert.rejects(
    store.run(
      mutationId,
      "autonameStory",
      input,
      async (plan) => {
        await plan.providerStarted();
        throw new DurableMutationResultError(
          409,
          "Story mutation previously completed with provider_failure.",
          "provider_failure"
        );
      }
    ),
    hasCode("provider_failure")
  );
  await assert.rejects(
    store.run(
      mutationId,
      "autonameStory",
      input,
      async () => assert.fail("terminal failure must replay")
    ),
    hasCode("provider_failure")
  );
});

test("provider 5xx responses become terminal local failures", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-mutation-provider-5xx-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new MutationReceiptStore(dir, async () => { throw new Error("unused"); });
  await store.init();
  const mutationId = currentMutationId("b");
  let admitted = 0;
  const work = async (execution: { providerStarted(): Promise<void> }) => {
    await execution.providerStarted();
    admitted += 1;
    throw new ProviderError("upstream timed out", 503);
  };

  await assert.rejects(
    store.run(mutationId, "autonameStory", { id: "story" }, work),
    ProviderError
  );
  await assert.rejects(
    store.run(mutationId, "autonameStory", { id: "story" }, work),
    hasCode("provider_failure")
  );
  assert.equal(admitted, 1);
});

test("post-provider validation failures become terminal receipts", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-mutation-generation-result-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new MutationReceiptStore(dir, async () => { throw new Error("unused"); });
  await store.init();
  const mutationId = currentMutationId("c");
  let calls = 0;
  const work = async (execution: { providerStarted(): Promise<void> }) => {
    calls += 1;
    await execution.providerStarted();
    throw new GenerationResultError(502, "model output failed validation");
  };

  await assert.rejects(store.run(mutationId, "autonameStory", { id: "story" }, work), GenerationResultError);
  await assert.rejects(
    store.run(mutationId, "autonameStory", { id: "story" }, work),
    hasCode("provider_failure")
  );
  assert.equal(calls, 1);
});

test("terminal domain failures replay instead of becoming recovery successes", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-mutation-failure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new MutationReceiptStore(dir, async () => { throw new Error("unused"); });
  await store.init();
  const mutationId = currentMutationId("6");
  await assert.rejects(store.run(mutationId, "patchFact", { storyId: "story", factId: "missing" }, async () => {
    throw new ServiceError(404, "Fact not found");
  }), hasCode("not_found"));
  let preflights = 0;
  await assert.rejects(store.run(
    mutationId,
    "patchFact",
    { storyId: "story", factId: "missing" },
    async () => "must not run",
    undefined,
    () => {
      preflights += 1;
      throw new Error("failed receipts resolve before compatibility preflight");
    }
  ), hasCode("not_found"));
  assert.equal(preflights, 0);
});

test("visible but unconfirmed commits retain a pending receipt for reconciliation", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-mutation-durability-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new MutationReceiptStore(dir, async () => { throw new Error("unused"); });
  await store.init();
  const mutationId = currentMutationId("e");
  const input = { id: "story", title: "Possibly committed" };
  await assert.rejects(store.run(mutationId, "renameStory", input, async () => {
    throw new StoryDurabilityError("visible but not confirmed", { cause: new Error("sync failed") });
  }), hasCode("mutation_outcome_unknown"));

  let recovery = false;
  assert.equal(await store.run(mutationId, "renameStory", input, async (execution) => {
    recovery = execution.recoveryMode !== "new";
    return "reconciled";
  }), "reconciled");
  assert.equal(recovery, true);
});

test("pending generation intent rejects a changed recovery context", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-mutation-context-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new MutationReceiptStore(dir, async () => { throw new Error("unused"); });
  await store.init();
  const mutationId = currentMutationId("d");
  const input = { storyId: "story", instruction: "Continue" };
  await assert.rejects(store.run(mutationId, "continueStory", input, async (execution) => {
    await execution.bindGenerationIntent(GENERATION_SETTINGS, { source: "original" });
    throw new MutationReceiptPersistenceError(new Error("simulated worker stop"));
  }), hasCode("mutation_outcome_unknown"));

  await assert.rejects(store.run(mutationId, "continueStory", input, async (execution) => {
    await execution.bindGenerationIntent({ ...GENERATION_SETTINGS, model: "changed" }, { source: "original" });
    return "must not run";
  }), hasCode("idempotency_conflict"));
  await assert.rejects(store.run(mutationId, "continueStory", input, async () => "must not run"),
    hasCode("idempotency_conflict"));
});

test("generation intent receipts never bind provider secret values", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-mutation-secret-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new MutationReceiptStore(dir, async () => { throw new Error("unused"); });
  await store.init();
  const mutationId = currentMutationId("f");
  const input = { storyId: "story", instruction: "Continue" };
  const keyName = "AI_1667_RECEIPT_SECRET_TEST";
  const previous = process.env[keyName];
  const settings = { ...GENERATION_SETTINGS, apiKeyEnv: keyName };
  try {
    process.env[keyName] = "low-entropy-secret";
    await assert.rejects(store.run(mutationId, "continueStory", input, async (execution) => {
      await execution.bindGenerationIntent(settings, { source: "stable" });
      throw new MutationReceiptPersistenceError(new Error("simulated worker stop"));
    }), hasCode("mutation_outcome_unknown"));

    process.env[keyName] = "rotated-secret";
    assert.equal(await store.run(mutationId, "continueStory", input, async (execution) => {
      await execution.bindGenerationIntent(settings, { source: "stable" });
      return "recovered";
    }), "recovered");
  } finally {
    if (previous === undefined) delete process.env[keyName];
    else process.env[keyName] = previous;
  }
});

test("malformed terminal receipts cannot replay an undefined success", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-mutation-corrupt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mutationId = currentMutationId("7");
  const input = { id: "story" };
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${mutationId}.json`), `${JSON.stringify({
    format: "1667-mutation",
    schemaVersion: 1,
    mutationId,
    fingerprint: mutationFingerprint("deleteStory", input),
    method: "deleteStory",
    state: "completed",
    createdAt: new Date().toISOString(),
    result: { type: "value" }
  })}\n`);

  const store = new MutationReceiptStore(dir, async () => { throw new Error("unused"); });
  await assert.rejects(store.run(mutationId, "deleteStory", input, async () => ({ ok: true })), /corrupt/);
});

test("unseen old IDs expire while retained completed receipts still replay", async (t) => {
  const now = Date.now();
  const oldId = mutationIdAt(now - MUTATION_ID_RETRY_WINDOW_MS - 1, "5");
  assert.throws(() => validateUnseenMutationId(oldId, now), hasCode("mutation_expired"));

  const dir = await mkdtemp(path.join(tmpdir(), "1667-mutation-retained-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${oldId}.json`), `${JSON.stringify({
    format: "1667-mutation",
    schemaVersion: 1,
    mutationId: oldId,
    fingerprint: mutationFingerprint("deleteStory", { id: "story" }, LEGACY_WORKER_PROTOCOL_VERSION),
    method: "deleteStory",
    state: "completed",
    createdAt: new Date(now - MUTATION_ID_RETRY_WINDOW_MS - 1).toISOString(),
    result: { type: "value", value: { ok: true } }
  })}\n`);
  const store = new MutationReceiptStore(dir, async () => { throw new Error("unused"); });
  assert.deepEqual(await store.run(
    oldId, "deleteStory", { id: "story" }, async () => ({ ok: false }), LEGACY_WORKER_PROTOCOL_VERSION
  ), { ok: true });
});

function currentMutationId(suffix: string): string {
  return mutationIdAt(Date.now(), suffix);
}

function storyPayload(id: string, title: string): StoryPayload {
  return {
    id,
    title,
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

function mutationIdAt(timestamp: number, suffix: string): string {
  return `m1-${timestamp.toString(36)}-${suffix.padStart(32, "0")}`;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ServiceError && error.code === code;
}

function hasProviderRecoveryTarget(
  providerMutationId: string
): (error: unknown) => boolean {
  return (error) =>
    error instanceof ProviderRecoveryRequiredError
    && error.providerMutationId === providerMutationId;
}

async function writeReceipt(
  dir: string,
  mutationId: string,
  method: "autonameStory" | "renameStory" | "removeChapterBreak",
  input: unknown,
  state: "provider_started" | "pending",
  protocolVersion?: number
): Promise<void> {
  await writeFile(path.join(dir, `${mutationId}.json`), `${JSON.stringify({
    format: "1667-mutation",
    schemaVersion: 1,
    mutationId,
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
    fingerprint: mutationFingerprint(method, input, protocolVersion ?? LEGACY_WORKER_PROTOCOL_VERSION),
    method,
    state,
    createdAt: new Date().toISOString()
  })}\n`);
}

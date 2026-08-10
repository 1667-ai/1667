import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDurableMutationId } from "../shared/durable-mutation-id.js";
import type { StoryPayload } from "../shared/types.js";
import type { MutatingWorkerMethod } from "../shared/worker-protocol.js";
import { chapterBreakRemovalFingerprint, type RemovedChapterBreak } from "../server/chapter-breaks.js";
import { ChapterBreakLivenessIndex, MUTATION_RECEIPT_DIRECTORY } from "../server/chapter-break-undo-liveness.js";
import type { MutationPlan, MutationPreflightPlan } from "../server/mutation-plan.js";
import { MutationReceiptStore as ProductionMutationReceiptStore } from "../server/mutation-receipts.js";
import { prepareServiceFailure } from "../server/service-error-policy.js";
import { buildStoryPayload } from "../server/story-payload.js";
import { StoryStore } from "../server/stories.js";
import { readUnsealedFile } from "../server/vault-file-read.js";

/** Runs receipt mechanics without aggregate admission, same convenience as
 *  test/mutation-receipts.test.ts's own local subclass. */
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

const RECORD_ID = "a".repeat(64);

test("chapter-break undo liveness survives a restart without re-deriving it from a story", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-chapter-liveness-restart-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const payload = storyPayload("story");
  const removed = removedChapterBreak();
  const removedFingerprint = chapterBreakRemovalFingerprint(removed);
  const mutationId = createDurableMutationId();
  const input = { storyId: "story", breakId: "break", removedFingerprint };

  let store = new MutationReceiptStore(dir, async () => payload);
  await store.init();
  await store.run(mutationId, "removeChapterBreak", input, async (plan) => ({
    payload,
    removed: await plan.preserveChapterBreakRemoval(removedFingerprint, async () => removed)
  }));
  assert.deepEqual(store.liveGenerationRecordIds("story"), [RECORD_ID]);

  // A fresh instance over the same directory stands in for a process
  // restart: nothing but the durable receipt file taught it this.
  store = new MutationReceiptStore(dir, async () => payload);
  assert.deepEqual(store.liveGenerationRecordIds("story"), []);
  await store.init();
  assert.deepEqual(store.liveGenerationRecordIds("story"), [RECORD_ID]);
});

test("a pre-commit artifact lease is live before its mutation completes", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-chapter-liveness-precommit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const payload = storyPayload("story");
  const removed = removedChapterBreak();
  const removedFingerprint = chapterBreakRemovalFingerprint(removed);
  const mutationId = createDurableMutationId();
  const input = { storyId: "story", breakId: "break", removedFingerprint };

  const store = new MutationReceiptStore(dir, async () => payload);
  await store.init();
  let sawLiveDuringWork = false;
  await store.run(mutationId, "removeChapterBreak", input, async (plan) => {
    const preserved = await plan.preserveChapterBreakRemoval(removedFingerprint, async () => removed);
    // The artifact lease is durable at this point, but the outer receipt is
    // still "pending" — liveness must already reflect it, because a story
    // cleanup racing this exact window has nothing else protecting these ids.
    sawLiveDuringWork = store.liveGenerationRecordIds("story").includes(RECORD_ID);
    return { payload, removed: preserved };
  });
  assert.equal(sawLiveDuringWork, true);
});

test("an unrelated malformed receipt is reported but does not block liveness for other stories", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-chapter-liveness-malformed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const payload = storyPayload("story-a");
  const removed = removedChapterBreak();
  const removedFingerprint = chapterBreakRemovalFingerprint(removed);
  const mutationId = createDurableMutationId();
  const input = { storyId: "story-a", breakId: "break", removedFingerprint };

  let store = new MutationReceiptStore(dir, async () => payload);
  await store.init();
  await store.run(mutationId, "removeChapterBreak", input, async (plan) => ({
    payload,
    removed: await plan.preserveChapterBreakRemoval(removedFingerprint, async () => removed)
  }));

  const malformedId = createDurableMutationId();
  await writeFile(path.join(dir, `${malformedId}.json`), "not json\n", "utf8");

  const diagnosed: unknown[] = [];
  store = new MutationReceiptStore(
    dir,
    async () => payload,
    async (error) => {
      diagnosed.push(error);
      return prepareServiceFailure(error);
    }
  );
  await store.init();

  assert.deepEqual(store.liveGenerationRecordIds("story-a"), [RECORD_ID]);
  assert.equal(diagnosed.length, 1);
});

test("story cleanup consults chapter-break undo liveness without rescanning the receipt directory", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-chapter-liveness-no-rescan-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storyDir = path.join(dir, "stories");
  const receiptDir = path.join(dir, MUTATION_RECEIPT_DIRECTORY);

  let hydrateCalls = 0;
  const originalHydrate = ChapterBreakLivenessIndex.prototype.hydrate;
  t.mock.method(
    ChapterBreakLivenessIndex.prototype,
    "hydrate",
    async function (this: ChapterBreakLivenessIndex, ...args: Parameters<typeof originalHydrate>) {
      hydrateCalls += 1;
      return await originalHydrate.apply(this, args);
    }
  );

  let receipts: MutationReceiptStore | undefined;
  const stories = new StoryStore(
    storyDir,
    undefined,
    undefined,
    undefined,
    (storyId) => receipts!.liveGenerationRecordIds(storyId)
  );
  await stories.init();
  receipts = new MutationReceiptStore(receiptDir, async (id) => buildStoryPayload(await stories.load(id)));
  await receipts.init();
  assert.equal(hydrateCalls, 1);

  const storyA = await stories.create("Story A");
  const storyB = await stories.create("Story B");
  for (const story of [storyA, storyB, storyA, storyB]) {
    await stories.createNode(story.id, null, "A take.", "");
    await stories.waitForMaintenance();
  }

  assert.equal(hydrateCalls, 1);
});

/**
 * Regression for hydrate's original serial scan: with receipts persisting
 * indefinitely, startup latency grew as the sum of every read. Proves the
 * fix by observing real concurrent-call counts through the narrow `readFile`
 * injection seam, rather than asserting anything about the implementation.
 */
test("hydrate bounds concurrent receipt reads without dropping or racing any story's liveness", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-chapter-liveness-hydrate-bound-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const RECEIPT_COUNT = 20;
  const setup = new MutationReceiptStore(dir, async (id) => storyPayload(id));
  await setup.init();
  for (let index = 0; index < RECEIPT_COUNT; index += 1) {
    const storyId = `story-${index}`;
    const removed = removedChapterBreak();
    const removedFingerprint = chapterBreakRemovalFingerprint(removed);
    const mutationId = createDurableMutationId();
    const input = { storyId, breakId: "break", removedFingerprint };
    await setup.run(mutationId, "removeChapterBreak", input, async (plan) => ({
      payload: storyPayload(storyId),
      removed: await plan.preserveChapterBreakRemoval(removedFingerprint, async () => removed)
    }));
  }

  let active = 0;
  let maxActive = 0;
  let totalCalls = 0;
  const trackedRead = async (file: string) => {
    totalCalls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    // Holds each read open long enough for the next-in-line reads to start,
    // so a sustained (not just initial-burst) concurrency ceiling is observable.
    await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      return await readUnsealedFile(file);
    } finally {
      active -= 1;
    }
  };

  const index = new ChapterBreakLivenessIndex();
  const diagnosed: unknown[] = [];
  await index.hydrate(dir, (mutationId, error) => {
    diagnosed.push({ mutationId, error });
  }, trackedRead);

  assert.equal(diagnosed.length, 0);
  assert.equal(totalCalls, RECEIPT_COUNT, "every receipt file must still be hydrated, none skipped");
  assert.ok(maxActive > 1, `expected observable overlap between reads, got a peak of ${maxActive}`);
  assert.ok(maxActive <= 8, `expected concurrent receipt reads to stay bounded, got a peak of ${maxActive}`);
  for (let index2 = 0; index2 < RECEIPT_COUNT; index2 += 1) {
    assert.deepEqual(index.liveGenerationRecordIds(`story-${index2}`), [RECORD_ID]);
  }
});

function storyPayload(id: string): StoryPayload {
  return {
    id,
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

function removedChapterBreak(): RemovedChapterBreak {
  return {
    break: {
      id: "break",
      parentPartId: "part",
      title: "Chapter one",
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
      activeChildId: null,
      generationRecordIds: [RECORD_ID]
    }]
  };
}

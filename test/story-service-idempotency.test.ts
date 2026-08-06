import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MUTATION_INPUT_PROTOCOL_VERSION,
  type MutatingWorkerMethod,
  type WorkerInput,
  type WorkerOutput
} from "../shared/worker-protocol.js";
import { StoryService } from "../server/story-service.js";
import { mutationFingerprint } from "../server/mutation-receipts.js";
import {
  executeWorkerMutation,
  parseWorkerMutation,
  preflightWorkerMutation
} from "../server/worker-mutations.js";
import { MAX_FACTS } from "../shared/types.js";
import { unusedTakePruneSelection } from "../shared/story-tree.js";
import { createDurableMutationId } from "../shared/durable-mutation-id.js";
import { rewriteStreamDigest } from "../shared/rewrite-partial-contract.js";
import { applyEffectiveGenerationSettings } from "../server/settings-v2-conversion.js";

test("pending receipts recover committed entity creation without duplicates after restart", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-idempotency-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const createInput = { title: "Recovered" };
  const createId = mutationId("1");
  const nodeId = mutationId("2");
  const factId = mutationId("3");
  const cutId = mutationId("4");
  let service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();

  await leavePendingAfterCommit(service, createId, "createStory", createInput);
  const storyId = (await service.listStories())[0]!.id;
  const nodeInput = { storyId, body: { parentId: null, instruction: "Open", text: "A long opening line." } };
  await leavePendingAfterCommit(service, nodeId, "createNode", nodeInput);
  const rootId = (await service.loadStory(storyId)).nodes[0]!.id;
  const factInput = { storyId, body: { facts: [{ tag: "One", text: "First" }, { tag: "Two", text: "Second" }] } };
  await leavePendingAfterCommit(service, factId, "createFact", factInput);
  const cutInput = { storyId, nodeId: rootId, body: { offset: 6, expected: "A long" } };
  await leavePendingAfterCommit(service, cutId, "takeFromCut", cutInput);
  const committedRevision = (await service.loadStory(storyId)).updatedAt;
  await service.dispose();

  service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    const recovered = await runWorkerMutation(service, createId, "createStory", createInput);
    assert.equal(recovered.id, storyId);
    await runWorkerMutation(service, nodeId, "createNode", nodeInput);
    await runWorkerMutation(service, factId, "createFact", factInput);
    await runWorkerMutation(service, cutId, "takeFromCut", cutInput);

    const story = await service.loadStory(storyId);
    assert.equal(story.updatedAt, committedRevision);
    assert.equal(story.nodes.length, 2);
    assert.equal(story.facts.length, 2);
    assert.equal((await service.listStories()).length, 1);
  } finally {
    await service.dispose();
  }
});

test("pending Markdown import replay re-enters canonical creation recovery", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-markdown-replay-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const mutationIdValue = mutationId("d");
  const input = {
    markdown: "# Replayed\n\nFirst.\n\n## Later\n\nSecond."
  };
  let service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  const first = await leavePendingAfterCommit(
    service,
    mutationIdValue,
    "importMarkdown",
    input
  );
  await service.dispose();

  service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    const replayed = await runWorkerMutation(
      service,
      mutationIdValue,
      "importMarkdown",
      input
    );
    assert.equal(replayed.id, first.id);
    assert.deepEqual(
      replayed.nodes.map(({ id }) => id),
      first.nodes.map(({ id }) => id)
    );
    assert.deepEqual(
      replayed.chapterBreaks.map(({ id }) => id),
      first.chapterBreaks.map(({ id }) => id)
    );
    assert.equal((await service.listStories()).length, 1);
  } finally {
    await service.dispose();
  }
});

test("pending NovelAI import replay re-enters canonical creation recovery", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-novelai-replay-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const mutationIdValue = mutationId("e");
  const input = {
    storyContainerJson: JSON.stringify({
      storyContainerVersion: 1,
      metadata: { title: "Replayed NovelAI story" },
      content: {
        story: {
          fragments: [
            { data: "First legacy line.\n" },
            { data: "Second legacy line." }
          ]
        }
      }
    })
  };
  let service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  const first = await leavePendingAfterCommit(
    service,
    mutationIdValue,
    "importNovelAI",
    input
  );
  await service.dispose();

  service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    const replayed = await runWorkerMutation(
      service,
      mutationIdValue,
      "importNovelAI",
      input
    );
    assert.equal(replayed.payload.id, first.payload.id);
    assert.deepEqual(
      replayed.payload.nodes.map(({ id }) => id),
      first.payload.nodes.map(({ id }) => id)
    );
    assert.equal((await service.listStories()).length, 1);
  } finally {
    await service.dispose();
  }
});

test("deterministic fact recovery wins before the capacity guard", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-fact-capacity-recovery-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    const story = await service.createStory("Full facts");
    await service.createFact(story.id, {
      facts: Array.from({ length: MAX_FACTS - 1 }, (_, index) => ({ text: `Fact ${index}` }))
    });
    const mutationIdValue = mutationId("9");
    const input = { storyId: story.id, body: { text: "Last fact" } };
    await leavePendingAfterCommit(service, mutationIdValue, "createFact", input);

    const recovered = await runWorkerMutation(service, mutationIdValue, "createFact", input);
    assert.equal(recovered.facts.length, MAX_FACTS);
  } finally {
    await service.dispose();
  }
});

test("a patchFact replay does not mistake a priority/budget-only edit for one already applied", async (t) => {
  // Review finding A: the replay predicate compared tag, text, activation,
  // and keys, but not the two fields this issue added. A patch that touched
  // only priority or budgetTokens left every compared field unchanged, so a
  // genuinely pending (never-applied) patch read as "already matches" —
  // reconcileStory returned the untouched story as a *success*, silently
  // discarding the edit, instead of the safe mutation_outcome_unknown escalation
  // every other field already got when the predicate could not confirm a
  // prior attempt had committed.
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-fact-patch-recovery-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    const story = await service.createFact(
      (await service.createStory("Fact patch recovery")).id,
      { text: "A fact that will gain priority and a budget." }
    );
    const factId = story.facts[0]!.id;
    const input = { storyId: story.id, factId, body: { priority: "high", budgetTokens: 40 } };
    const mutationIdValue = mutationId("fa");
    // A receipt exists, but the patch was never actually applied — the
    // scenario a real crash before commit produces.
    await writePendingReceipt(service, mutationIdValue, "patchFact", input);

    await assert.rejects(
      runWorkerMutation(service, mutationIdValue, "patchFact", input),
      hasCode("mutation_outcome_unknown")
    );
    // No false "success" happened, and the Fact was never touched — the
    // caller's mutation_outcome_unknown recovery flow decides what to retry.
    assert.equal(
      (await service.loadStory(story.id)).facts.find((fact) => fact.id === factId)?.priority,
      undefined
    );

    // Control case: a patch that also changes text has always correctly
    // escalated the same way for a genuinely pending replay.
    const textInput = { storyId: story.id, factId, body: { text: "Different text entirely.", priority: "low" } };
    const textMutationId = mutationId("fb");
    await writePendingReceipt(service, textMutationId, "patchFact", textInput);
    await assert.rejects(
      runWorkerMutation(service, textMutationId, "patchFact", textInput),
      hasCode("mutation_outcome_unknown")
    );
  } finally {
    await service.dispose();
  }
});

test("pending overwrite recovery never clobbers newer authoritative state", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-overwrite-recovery-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    const story = await service.createStory("Original");
    const input = { id: story.id, title: "Recovered title" };
    const renameId = mutationId("a");
    await leavePendingAfterCommit(service, renameId, "renameStory", input);
    await service.renameStory(story.id, "Newer title");

    await assert.rejects(
      runWorkerMutation(service, renameId, "renameStory", input),
      hasCode("mutation_outcome_unknown")
    );
    assert.equal((await service.loadStory(story.id)).title, "Newer title");
  } finally {
    await service.dispose();
  }
});

test("pending destructive mutations converge and clear without repeat writes", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-destructive-recovery-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    let story = await service.createStory("Destructive recovery");
    story = await service.createNode(story.id, { parentId: null, text: "Inactive root." });
    const inactiveId = story.nodes[0]!.id;
    story = await service.createNode(story.id, { parentId: null, text: "Active root." });
    const activeId = story.path[0]!.id;
    story = await service.putBookmark(story.id, activeId, "Active", "");
    story = await service.createFact(story.id, { text: "First fact" });
    story = await service.createFact(story.id, { text: "Second fact" });
    const secondFactId = story.facts[1]!.id;

    // A replayed reorder must not shift the Fact a second time — the ledger
    // recovery check clones the story and re-runs the real move to confirm
    // it would already be a no-op (see worker-mutations.ts's reorderFact).
    const reorderInput = { storyId: story.id, factId: secondFactId, body: { toIndex: 0 } };
    const reorderMutationId = mutationId("1a0");
    const reorderFirst = await leavePendingAfterCommit(service, reorderMutationId, "reorderFact", reorderInput);
    assert.deepEqual(reorderFirst.facts.map((fact) => fact.id), [secondFactId, story.facts[0]!.id]);
    const reorderReplay = await runWorkerMutation(service, reorderMutationId, "reorderFact", reorderInput);
    assert.equal(reorderReplay.updatedAt, reorderFirst.updatedAt);
    assert.deepEqual(reorderReplay.facts.map((fact) => fact.id), [secondFactId, story.facts[0]!.id]);

    const factInput = { storyId: story.id, factId: story.facts[0]!.id };
    const factMutationId = mutationId("1a");
    const factFirst = await leavePendingAfterCommit(service, factMutationId, "deleteFact", factInput);
    const factReplay = await runWorkerMutation(service, factMutationId, "deleteFact", factInput);
    assert.equal(factReplay.updatedAt, factFirst.updatedAt);
    assert.equal(factReplay.facts.length, 1);

    const tagInput = { storyId: story.id, nodeId: activeId };
    const tagId = mutationId("1b");
    const tagFirst = await leavePendingAfterCommit(service, tagId, "deleteBookmark", tagInput);
    const tagReplay = await runWorkerMutation(service, tagId, "deleteBookmark", tagInput);
    assert.equal(tagReplay.updatedAt, tagFirst.updatedAt);
    assert.equal(tagReplay.tags.length, 0);

    const nodeInput = { storyId: story.id, nodeId: inactiveId, expectedSubtreeCount: 1 };
    const nodeMutationId = mutationId("1c");
    const nodeFirst = await leavePendingAfterCommit(service, nodeMutationId, "deleteNode", nodeInput);
    const nodeReplay = await runWorkerMutation(service, nodeMutationId, "deleteNode", nodeInput);
    assert.equal(nodeReplay.updatedAt, nodeFirst.updatedAt);
    assert.equal(nodeReplay.nodes.some((node) => node.id === inactiveId), false);

    story = await service.createNode(story.id, { parentId: null, text: "New active root." });
    const selection = unusedTakePruneSelection(story);
    assert.ok(selection.nodeIds.length > 0);
    const pruneInput = {
      storyId: story.id,
      body: {
        expectedStoryRevision: story.updatedAt,
        expectedTakeCount: selection.takeIds.length,
        expectedPartCount: selection.nodeIds.length
      }
    };
    const pruneId = mutationId("1d");
    const pruneFirst = await leavePendingAfterCommit(service, pruneId, "pruneUnusedTakes", pruneInput);
    const pruneReplay = await runWorkerMutation(service, pruneId, "pruneUnusedTakes", pruneInput);
    assert.equal(pruneReplay.updatedAt, pruneFirst.updatedAt);
    assert.equal(unusedTakePruneSelection(pruneReplay).takeIds.length, 0);

    story = await service.createNode(story.id, { parentId: null, text: "Another active root." });
    const unresolvedSelection = unusedTakePruneSelection(story);
    const unresolvedInput = {
      storyId: story.id,
      body: {
        expectedStoryRevision: story.updatedAt,
        expectedTakeCount: unresolvedSelection.takeIds.length,
        expectedPartCount: unresolvedSelection.nodeIds.length
      }
    };
    const unresolvedId = mutationId("1f");
    await writePendingReceipt(service, unresolvedId, "pruneUnusedTakes", unresolvedInput);
    await service.renameStory(story.id, "Revision changed before prune");
    await assert.rejects(
      runWorkerMutation(service, unresolvedId, "pruneUnusedTakes", unresolvedInput),
      hasCode("mutation_outcome_unknown")
    );
    assert.equal(unusedTakePruneSelection(await service.loadStory(story.id)).takeIds.length > 0, true);

    const doomed = await service.createStory("Delete recovery");
    const deleteInput = { id: doomed.id };
    const deleteId = mutationId("1e");
    await writePendingReceipt(service, deleteId, "deleteStory", deleteInput);
    assert.deepEqual(await runWorkerMutation(service, deleteId, "deleteStory", deleteInput), { ok: true });
    assert.deepEqual(await runWorkerMutation(service, deleteId, "deleteStory", deleteInput), { ok: true });
    await assert.rejects(service.loadStory(doomed.id), hasCode("not_found"));
  } finally {
    await service.dispose();
  }
});

test("pending dry-run summaries reconcile by deterministic node ID", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-summary-recovery-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    let story = await service.createStory("Summary recovery");
    story = await service.createNode(story.id, { parentId: null, text: "A sufficiently detailed opening." });
    const body = { nodeId: story.nodes[0]!.id };
    const input = { storyId: story.id, body };
    const summaryId = mutationId("b");
    const first = await leavePendingAfterCommit(service, summaryId, "createSummaryTake", input);
    const before = await service.loadStory(story.id);

    const recovered = await runWorkerMutation(service, summaryId, "createSummaryTake", input);
    const after = await service.loadStory(story.id);
    assert.equal(recovered, first);
    assert.equal(after.nodes.length, before.nodes.length);
  } finally {
    await service.dispose();
  }
});

test("pending pre-provider summaries resume with deterministic commit IDs", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-summary-pending-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    let story = await service.createStory("Pending summary");
    story = await service.createNode(story.id, { parentId: null, text: "A pending summary source." });
    const input = { storyId: story.id, body: { nodeId: story.nodes[0]!.id } };
    const summaryId = mutationId("c");
    await writePendingReceipt(service, summaryId, "createSummaryTake", input);

    const result = await runWorkerMutation(service, summaryId, "createSummaryTake", input);
    assert.equal(typeof result, "string");
    assert.equal((await service.loadStory(story.id)).nodes.filter((node) => node.role === "summary").length, 1);
  } finally {
    await service.dispose();
  }
});

test("pending dry-run rewrites reconcile a committed take without duplicating it", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-rewrite-recovery-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    let story = await service.createStory("Rewrite recovery");
    story = await service.createNode(story.id, { parentId: null, text: "The blue door." });
    const nodeId = story.nodes[0]!.id;
    const body = { start: 4, end: 8, expected: "blue", instruction: "Change the color", destination: "take" as const };
    const input = { storyId: story.id, nodeId, body };
    const rewriteMutationId = mutationId("d");
    const takeId = await leavePendingAfterCommit(service, rewriteMutationId, "rewriteNode", input);
    assert.equal(typeof takeId, "string");
    assert.notEqual(takeId, nodeId);
    const committed = await service.loadStory(story.id);
    let replayDeltas = 0;

    const recovered = await runWorkerMutation(
      service, rewriteMutationId, "rewriteNode", input, () => { replayDeltas += 1; }
    );
    const after = await service.loadStory(story.id);

    // The replay finds the take already committed and never re-enters the
    // provider, exactly like `createSummaryTake` recovery above.
    assert.equal(recovered, takeId);
    assert.equal(replayDeltas, 0);
    assert.equal(after.nodes.length, committed.nodes.length);
    assert.equal(after.path[0]!.id, takeId);
    assert.equal(after.path[0]!.text, committed.path[0]!.text);
    // The source survives, unrewritten, reachable as a sibling of the take.
    assert.equal(after.nodes.find((node) => node.id === nodeId)?.preview, "The blue door.");
  } finally {
    await service.dispose();
  }
});

test("pending dry-run rewrites reconcile a committed in-place edit without duplicating it", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-rewrite-inplace-recovery-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    let story = await service.createStory("Rewrite recovery");
    story = await service.createNode(story.id, { parentId: null, text: "The blue door." });
    const nodeId = story.nodes[0]!.id;
    // destination absent: in-place is the default, so this mints no new node.
    const body = { start: 4, end: 8, expected: "blue", instruction: "Change the color" };
    const input = { storyId: story.id, nodeId, body };
    const rewriteMutationId = mutationId("e");
    const resolvedId = await leavePendingAfterCommit(service, rewriteMutationId, "rewriteNode", input);
    // In place mints no new node, so the operation answers the target's own id.
    assert.equal(resolvedId, nodeId);
    const committed = await service.loadStory(story.id);
    assert.equal(committed.nodes.length, 1);
    let replayDeltas = 0;

    const recovered = await runWorkerMutation(
      service, rewriteMutationId, "rewriteNode", input, () => { replayDeltas += 1; }
    );
    const after = await service.loadStory(story.id);

    // The replay finds the target's own rewriteId marker already committed
    // and never re-enters the provider — the marker `worker-mutations.ts`
    // used before #310 made every rewrite a take, restored now that in-place
    // rewrites exist again.
    assert.equal(recovered, nodeId);
    assert.equal(replayDeltas, 0);
    assert.equal(after.nodes.length, 1);
    assert.equal(after.path[0]!.id, nodeId);
    assert.equal(after.path[0]!.text, committed.path[0]!.text);
  } finally {
    await service.dispose();
  }
});

test("a partial-rewrite receipt replays after the volatile stash is lost", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-partial-rewrite-replay-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  let disposed = false;
  try {
    let story = await service.createStory("Partial rewrite replay");
    const text = "The blue door opened into a long and quiet stone corridor.";
    story = await service.createNode(story.id, { parentId: null, text });
    const nodeId = story.nodes[0]!.id;
    const expected = "blue door opened into a long and quiet stone corridor";
    const start = text.indexOf(expected);
    const controller = new AbortController();
    let streamedText = "";
    const stopped = await service.rewriteNode(
      story.id,
      nodeId,
      {
        start,
        end: start + expected.length,
        expected,
        instruction: "",
        destination: "take",
        attemptId: "restart-replay-attempt"
      },
      (delta) => {
        streamedText += delta;
        controller.abort();
      },
      controller.signal,
      { rewriteId: "partial-rewrite", takeId: "unused-original-take" }
    );
    assert.equal(stopped, null);
    assert.notEqual(streamedText.trim(), "");

    const settleId = mutationId("f");
    const input = {
      storyId: story.id,
      nodeId,
      streamedDigest: rewriteStreamDigest(streamedText),
      attemptId: "restart-replay-attempt"
    };
    const committed = await runWorkerMutation(
      service,
      settleId,
      "commitPartialRewrite",
      input
    );
    assert.ok(committed);
    assert.notEqual(committed.nodeId, nodeId);
    const committedText = committed.payload.nodes.find(
      (node) => node.id === committed.nodeId
    )?.preview;
    const current = await service.createNode(story.id, {
      parentId: committed.nodeId,
      text: "A later edit must be visible when the settle receipt replays."
    });

    // A restart removes the process-local stash. The durable terminal receipt
    // must still return the same take and must not apply the splice again.
    await service.dispose();
    disposed = true;
    service = StoryService.withoutDiagnostics({ dataDir });
    await service.init();
    disposed = false;
    const replayed = await runWorkerMutation(
      service,
      settleId,
      "commitPartialRewrite",
      input
    );
    assert.ok(replayed);
    assert.equal(replayed.nodeId, committed.nodeId);
    assert.equal(
      replayed.payload.nodes.find((node) => node.id === replayed.nodeId)?.preview,
      committedText
    );
    assert.equal(replayed.payload.nodes.length, current.nodes.length);
    assert.equal(
      replayed.payload.nodes.some((node) => node.preview.includes("later edit")),
      true
    );
  } finally {
    if (!disposed) await service.dispose();
  }
});

test("a completed partial-rewrite replay does not consume a later attempt", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-partial-rewrite-attempts-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    let story = await service.createStory("Partial rewrite attempts");
    const original = "The blue door opened into a long and quiet stone corridor.";
    story = await service.createNode(story.id, { parentId: null, text: original });
    const nodeId = story.nodes[0]!.id;
    const stopRewrite = async (
      expected: string,
      attemptId: string,
      rewriteId: string
    ): Promise<string> => {
      const current = await service.loadStory(story.id);
      const text = current.path.find((node) => node.id === nodeId)!.text;
      const start = text.indexOf(expected);
      assert.notEqual(start, -1);
      const controller = new AbortController();
      let streamedText = "";
      const stopped = await service.rewriteNode(
        story.id,
        nodeId,
        {
          start,
          end: start + expected.length,
          expected,
          instruction: "",
          attemptId
        },
        (delta) => {
          streamedText += delta;
          controller.abort();
        },
        controller.signal,
        { rewriteId, takeId: `${rewriteId}-unused-take` }
      );
      assert.equal(stopped, null);
      assert.notEqual(streamedText.trim(), "");
      return streamedText;
    };

    const streamedA = await stopRewrite(
      "blue door opened into a long",
      "attempt-a",
      "rewrite-a"
    );
    const settleAId = mutationId("a1");
    const inputA = {
      storyId: story.id,
      nodeId,
      streamedDigest: rewriteStreamDigest(streamedA),
      attemptId: "attempt-a"
    };
    const committedA = await runWorkerMutation(
      service,
      settleAId,
      "commitPartialRewrite",
      inputA
    );
    assert.ok(committedA);

    const streamedB = await stopRewrite(
      "quiet stone corridor",
      "attempt-b",
      "rewrite-b"
    );
    const replayedA = await runWorkerMutation(
      service,
      settleAId,
      "commitPartialRewrite",
      inputA
    );
    assert.ok(replayedA);

    const committedB = await runWorkerMutation(
      service,
      mutationId("b1"),
      "commitPartialRewrite",
      {
        storyId: story.id,
        nodeId,
        streamedDigest: rewriteStreamDigest(streamedB),
        attemptId: "attempt-b"
      }
    );
    assert.ok(committedB, "the replay of attempt A must leave attempt B available");
    assert.equal(
      committedB.payload.path.find((node) => node.id === nodeId)?.text
        .includes("quiet stone corridor"),
      false
    );
  } finally {
    await service.dispose();
  }
});

test("pending autoname resumes before admission and reconciles after commit", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-autoname-recovery-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    let story = await service.createStory("Original title");
    story = await service.createNode(story.id, { parentId: null, text: "A sufficiently detailed opening." });
    const input = { id: story.id, expectedTitle: story.title };
    const pendingId = mutationId("e");
    await writePendingReceipt(service, pendingId, "autonameStory", input);
    const generated = await runWorkerMutation(service, pendingId, "autonameStory", input);
    assert.equal(generated.title, "The Quiet After Rain");

    let other = await service.createStory("Another original");
    other = await service.createNode(other.id, { parentId: null, text: "Another detailed opening." });
    const committedInput = { id: other.id, expectedTitle: other.title };
    const committedId = mutationId("f");
    const first = await leavePendingAfterCommit(service, committedId, "autonameStory", committedInput);
    const replay = await runWorkerMutation(service, committedId, "autonameStory", committedInput);
    assert.equal(replay.title, first.title);
    assert.equal(replay.updatedAt, first.updatedAt);
  } finally {
    await service.dispose();
  }
});

test("autoname recovery preserves newer manual titles", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-autoname-newer-title-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    let story = await service.createStory("Original title");
    story = await service.createNode(story.id, { parentId: null, text: "A detailed opening." });
    const input = { id: story.id, expectedTitle: story.title };
    const autonameMutationId = mutationId("a");
    await leavePendingAfterCommit(service, autonameMutationId, "autonameStory", input);
    await service.renameStory(story.id, "Newer manual title");

    const reconciled = await runWorkerMutation(service, autonameMutationId, "autonameStory", input);
    assert.equal(reconciled.title, "Newer manual title");
    assert.equal((await service.loadStory(story.id)).title, "Newer manual title");

    let pending = await service.createStory("Pending original");
    pending = await service.createNode(pending.id, { parentId: null, text: "A pending detailed opening." });
    const pendingInput = { id: pending.id, expectedTitle: pending.title };
    const pendingId = mutationId("b");
    await writePendingReceipt(service, pendingId, "autonameStory", pendingInput);
    await service.renameStory(pending.id, "Newer title before generation");
    await assert.rejects(
      runWorkerMutation(service, pendingId, "autonameStory", pendingInput),
      hasCode("mutation_outcome_unknown")
    );
    assert.equal((await service.loadStory(pending.id)).title, "Newer title before generation");
  } finally {
    await service.dispose();
  }
});

test("summary cancellation after provider admission completes as null", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-summary-cancel-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  const originalFetch = globalThis.fetch;
  try {
    const initial = await service.getSettings();
    assert.equal(initial.dataFormat, 2);
    const document = applyEffectiveGenerationSettings(initial.document, {
      ...initial.effective,
      provider: "openai-compatible",
      baseUrl: "https://fixture.invalid/v1",
      model: "fixture"
    });
    await service.saveSettings({
      transportOperationId: crypto.randomUUID(),
      mutationId: createDurableMutationId(),
      expectedStateGeneration: initial.stateGeneration,
      document
    });
    let story = await service.createStory("Summary cancellation");
    story = await service.createNode(story.id, { parentId: null, text: "A detailed summary source." });
    const input = { storyId: story.id, body: { nodeId: story.nodes[0]!.id } };
    const summaryId = mutationId("c");
    const controller = new AbortController();
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      controller.abort();
      throw controller.signal.reason;
    }) as typeof fetch;

    const cancelled = await runWorkerMutation(service, summaryId, "createSummaryTake", input, () => {}, controller.signal);
    assert.equal(cancelled, null);
    const replayed = await runWorkerMutation(service, summaryId, "createSummaryTake", input);
    assert.equal(replayed, null);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await service.dispose();
  }
});

test("replaying a cleared Author's Note recovers instead of reporting an unknown outcome", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-note-clear-replay-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    let story = await service.createStory("Depth story");
    story = await service.createNode(story.id, { parentId: null, text: "A sufficiently detailed opening." });
    await service.setAuthorsNote(story.id, "Keep the lantern unanswered.", 3);
    // Clearing the note clears the depth with it, so a replay of this exact
    // input must recognise the story it already produced.
    const clearInput = { storyId: story.id, note: "", depth: 3 };
    const clearId = mutationId("d");
    const cleared = await leavePendingAfterCommit(service, clearId, "setAuthorsNote", clearInput);
    assert.equal("authorsNote" in cleared, false);
    assert.equal("authorsNoteDepth" in cleared, false);

    const replayed = await runWorkerMutation(service, clearId, "setAuthorsNote", clearInput);
    assert.equal("authorsNote" in replayed, false);
    assert.equal("authorsNoteDepth" in replayed, false);
  } finally {
    await service.dispose();
  }
});

test("replaying a depth-only Author's Note save recovers on a story with no note", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-note-depth-only-replay-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    let story = await service.createStory("Depth story");
    story = await service.createNode(story.id, { parentId: null, text: "A sufficiently detailed opening." });
    // A depth without a note stores nothing, so the replay predicate has to
    // read that absence as the state this input already produced.
    const input = { storyId: story.id, note: "", depth: 5 };
    const depthId = mutationId("e");
    await leavePendingAfterCommit(service, depthId, "setAuthorsNote", input);

    const replayed = await runWorkerMutation(service, depthId, "setAuthorsNote", input);
    assert.equal("authorsNoteDepth" in replayed, false);
  } finally {
    await service.dispose();
  }
});

async function runWorkerMutation<M extends MutatingWorkerMethod>(
  service: StoryService,
  mutationIdValue: string,
  method: M,
  value: unknown,
  onDelta: (text: string) => void = () => {},
  signal: AbortSignal = new AbortController().signal
): Promise<WorkerOutput<M>> {
  const input = parseWorkerMutation(method, value);
  return await service.runMutation(
    mutationIdValue,
    method,
    input,
    (plan) => executeWorkerMutation(service, input, plan, { onDelta, signal }),
    undefined,
    (plan) => preflightWorkerMutation(service, input, plan)
  );
}

async function leavePendingAfterCommit<M extends MutatingWorkerMethod>(
  service: StoryService,
  mutationIdValue: string,
  method: M,
  input: WorkerInput<M>
): Promise<WorkerOutput<M>> {
  const value = await runWorkerMutation(service, mutationIdValue, method, input);
  const file = path.join(service.dataDir, "mutation-receipts", `${mutationIdValue}.json`);
  const receipt = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  receipt.state = "pending";
  delete receipt.result;
  await writeFile(file, `${JSON.stringify(receipt)}\n`);
  return value;
}

async function writePendingReceipt(
  service: StoryService,
  mutationIdValue: string,
  method: MutatingWorkerMethod,
  input: unknown
): Promise<void> {
  const file = path.join(service.dataDir, "mutation-receipts", `${mutationIdValue}.json`);
  await writeFile(file, `${JSON.stringify({
    format: "1667-mutation",
    schemaVersion: 1,
    mutationId: mutationIdValue,
    protocolVersion: MUTATION_INPUT_PROTOCOL_VERSION,
    fingerprint: mutationFingerprint(method, input),
    method,
    state: "pending",
    createdAt: new Date().toISOString()
  })}\n`);
}

function mutationId(suffix: string): string {
  return `m1-${Date.now().toString(36)}-${suffix.padStart(32, "0")}`;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error !== null && typeof error === "object" && "code" in error
    && (error as { code: unknown }).code === code;
}

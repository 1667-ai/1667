import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDurableMutationId } from "../shared/durable-mutation-id.js";
import { createGenerationRecord } from "../shared/generation-record.js";
import { rewriteStreamDigest } from "../shared/rewrite-partial-contract.js";
import type {
  StoryAggregateVersion
} from "../shared/story-aggregate-version.js";
import { mutationFingerprint } from "../server/mutation-receipts.js";
import {
  PartialRewriteStash,
  partialRewriteRecordRetainedBytes,
  type PartialRewriteRecord
} from "../server/rewrite-partial.js";
import { ServiceError } from "../server/errors.js";
import { StoryService } from "../server/story-service.js";
import { StoryDurabilityError } from "../server/story-lifecycle.js";
import { sha256 } from "../server/story-format.js";

test("partial settlement replay retires the record after post-publish failure", async (t) => {
  const dataDir = await mkdtemp(path.join(
    tmpdir(),
    "1667-partial-settlement-recovery-"
  ));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    let story = await service.createStory("Partial settlement recovery");
    const original = "The blue door opened into a long and quiet stone corridor.";
    story = await service.createNode(story.id, {
      parentId: null,
      text: original
    });
    const nodeId = story.nodes[0]!.id;
    const expected = "blue door opened into a long and quiet stone corridor";
    const start = original.indexOf(expected);
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
        attemptId: "post-publish-attempt"
      },
      (delta) => {
        streamedText += delta;
        controller.abort();
      },
      controller.signal,
      {
        rewriteId: "post-publish-rewrite",
        takeId: "unused-full-take"
      }
    );
    assert.equal(stopped, null);
    assert.notEqual(streamedText.trim(), "");
    const expectedAggregateVersion = (
      await service.stories.loadVersioned(story.id)
    ).aggregateVersion!;

    const hooks = mutationHooks(service);
    let failed = false;
    hooks.afterPublish = () => {
      if (failed) return;
      failed = true;
      throw new Error("terminal evidence is offline");
    };
    const settlementId = createDurableMutationId();
    const input = {
      storyId: story.id,
      nodeId,
      streamedDigest: rewriteStreamDigest(streamedText),
      attemptId: "post-publish-attempt"
    };
    const mutationRequest = settlementRequest(
      settlementId,
      input,
      expectedAggregateVersion
    );
    await assert.rejects(
      service.commitPartialRewrite(
        story.id,
        nodeId,
        input,
        mutationRequest,
        "post-publish-take"
      ),
      (error: unknown) => error instanceof StoryDurabilityError
    );
    delete hooks.afterPublish;

    const recovered = await service.commitPartialRewrite(
      story.id,
      nodeId,
      input,
      mutationRequest,
      "post-publish-take"
    );
    assert.ok(recovered);
    assert.equal(recovered.payload.nodes.length, 2);

    const secondSettlementId = createDurableMutationId();
    const secondSettlement = await service.commitPartialRewrite(
      story.id,
      nodeId,
      input,
      settlementRequest(
        secondSettlementId,
        input,
        (await service.stories.loadVersioned(story.id)).aggregateVersion!
      ),
      "second-settlement-take"
    );
    assert.equal(secondSettlement, null);
    assert.equal((await service.loadStory(story.id)).nodes.length, 2);
  } finally {
    await service.dispose();
  }
});

test("partial settlement waits for an active rewrite to publish its record", async (t) => {
  const dataDir = await mkdtemp(path.join(
    tmpdir(),
    "1667-partial-active-settlement-"
  ));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    let story = await service.createStory("Active partial settlement");
    const original = "The blue door opened onto the courtyard.";
    story = await service.createNode(story.id, {
      parentId: null,
      text: original
    });
    const node = story.path[0]!;
    const attemptId = "active-settlement-attempt";
    const streamedDigest = rewriteStreamDigest("green door");
    const record: PartialRewriteRecord = {
      storyId: story.id,
      nodeId: node.id,
      attemptId,
      streamedDigest,
      effect: {
        kind: "rewrite",
        nodeId: node.id,
        expectedText: node.text,
        expectedInstruction: node.instruction,
        expectedUpdatedAt: node.updatedAt,
        text: "The green door opened onto the courtyard.",
        rewriteId: "active-settlement-rewrite",
        generationRecord: createGenerationRecord({
          kind: "rewrite-in-place",
          createdAt: node.updatedAt ?? node.createdAt,
          provider: { provider: "dry-run", model: "dry-run" },
          effective: { wireProtocol: "dry-run", fields: [], adjustments: [] },
          prompt: { operation: "rewrite", entries: [] }
        })
      }
    };
    const partials = partialRewriteStash(service);
    const reservation = partials.reserve(
      story.id,
      node.id,
      attemptId,
      partialRewriteRecordRetainedBytes(record)
    );
    const input = {
      storyId: story.id,
      nodeId: node.id,
      streamedDigest,
      attemptId
    };
    const settlementId = createDurableMutationId();
    let finished = false;
    const settlement = service.commitPartialRewrite(
      story.id,
      node.id,
      input,
      settlementRequest(
        settlementId,
        input,
        (await service.stories.loadVersioned(story.id)).aggregateVersion!
      )
    );
    void settlement.then(
      () => { finished = true; },
      () => { finished = true; }
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(finished, false, "settlement must not report a miss while the attempt is active");

    partials.remember(reservation, record);
    const committed = await settlement;
    assert.ok(committed);
    assert.equal(committed.payload.path[0]!.text, record.effect.text);

    const emptyAttemptId = "active-empty-attempt";
    const emptyReservation = partials.reserve(
      story.id,
      node.id,
      emptyAttemptId,
      1_024
    );
    const emptyInput = {
      storyId: story.id,
      nodeId: node.id,
      streamedDigest: rewriteStreamDigest("unverified prose"),
      attemptId: emptyAttemptId
    };
    const emptySettlement = service.commitPartialRewrite(
      story.id,
      node.id,
      emptyInput,
      settlementRequest(
        createDurableMutationId(),
        emptyInput,
        (await service.stories.loadVersioned(story.id)).aggregateVersion!
      )
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    partials.releaseEmpty(emptyReservation);
    assert.equal(await emptySettlement, null);
  } finally {
    await service.dispose();
  }
});

test("terminal settlement replay releases a newer record with reused identity", async (t) => {
  const dataDir = await mkdtemp(path.join(
    tmpdir(),
    "1667-partial-terminal-replay-"
  ));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    let story = await service.createStory("Partial terminal replay");
    const original = "The blue door opened into a long and quiet stone corridor.";
    story = await service.createNode(story.id, {
      parentId: null,
      text: original
    });
    const nodeId = story.nodes[0]!.id;
    const expected = "blue door opened into a long and quiet stone corridor";
    const attemptId = "reused-terminal-attempt";
    const stopRewrite = async (): Promise<string> => {
      const controller = new AbortController();
      let streamedText = "";
      const stopped = await service.rewriteNode(
        story.id,
        nodeId,
        {
          start: original.indexOf(expected),
          end: original.indexOf(expected) + expected.length,
          expected,
          instruction: "",
          attemptId
        },
        (delta) => {
          streamedText += delta;
          controller.abort();
        },
        controller.signal,
        {
          rewriteId: "reused-terminal-rewrite",
          takeId: "unused-terminal-take"
        }
      );
      assert.equal(stopped, null);
      assert.notEqual(streamedText, "");
      return streamedText;
    };

    const firstStream = await stopRewrite();
    const partials = partialRewriteStash(service);
    const firstRecord = partials.get(story.id, nodeId, attemptId);
    assert.ok(firstRecord);
    const changed = `${original} Changed.`;
    await service.editNode(story.id, nodeId, {
      text: changed,
      expectedTextHash: sha256(original)
    });
    const oldVersion = (
      await service.stories.loadVersioned(story.id)
    ).aggregateVersion!;
    const input = {
      storyId: story.id,
      nodeId,
      streamedDigest: rewriteStreamDigest(firstStream),
      attemptId
    };
    const oldSettlementId = createDurableMutationId();
    const oldRequest = settlementRequest(
      oldSettlementId,
      input,
      oldVersion
    );
    const terminalConflict = (error: unknown) =>
      error instanceof ServiceError && error.status === 409;
    await assert.rejects(
      service.commitPartialRewrite(story.id, nodeId, input, oldRequest),
      terminalConflict
    );

    const currentNode = (await service.loadStory(story.id)).path.find(
      (node) => node.id === nodeId
    );
    assert.ok(currentNode);
    const newerRecord: PartialRewriteRecord = {
      ...firstRecord,
      effect: {
        ...firstRecord.effect,
        expectedText: currentNode.text,
        expectedInstruction: currentNode.instruction,
        expectedUpdatedAt: currentNode.updatedAt,
        text: `${currentNode.text} Settled.`
      }
    };
    const reservation = partials.reserve(
      story.id,
      nodeId,
      attemptId,
      partialRewriteRecordRetainedBytes(newerRecord)
    );
    partials.remember(reservation, newerRecord);

    await assert.rejects(
      service.commitPartialRewrite(story.id, nodeId, input, oldRequest),
      terminalConflict
    );
    const newSettlementId = createDurableMutationId();
    const committed = await service.commitPartialRewrite(
      story.id,
      nodeId,
      input,
      settlementRequest(
        newSettlementId,
        input,
        (await service.stories.loadVersioned(story.id)).aggregateVersion!
      )
    );
    assert.ok(committed, "the stale terminal replay must release the newer record");
    assert.equal(
      committed.payload.path.find((node) => node.id === nodeId)?.text,
      `${changed} Settled.`
    );
  } finally {
    await service.dispose();
  }
});

interface MutableMutationHooks {
  afterPublish?: () => void;
}

function mutationHooks(service: StoryService): MutableMutationHooks {
  return (service as unknown as {
    storyMutations: { hooks: MutableMutationHooks };
  }).storyMutations.hooks;
}

function partialRewriteStash(service: StoryService): PartialRewriteStash {
  return (service as unknown as {
    rewritePartials: PartialRewriteStash;
  }).rewritePartials;
}

function settlementRequest(
  mutationId: string,
  value: unknown,
  expectedAggregateVersion: StoryAggregateVersion
): object {
  return {
    transportOperationId: `partial-recovery:${mutationId}`,
    mutationId,
    fingerprint: mutationFingerprint("commitPartialRewrite", value),
    scope: `story:${(value as { storyId: string }).storyId}`,
    expectedAggregateVersion
  };
}

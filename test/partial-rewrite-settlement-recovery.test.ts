import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDurableMutationId } from "../shared/durable-mutation-id.js";
import { rewriteStreamDigest } from "../shared/rewrite-partial-contract.js";
import type {
  StoryAggregateVersion
} from "../shared/story-aggregate-version.js";
import { mutationFingerprint } from "../server/mutation-receipts.js";
import { StoryService } from "../server/story-service.js";
import { StoryDurabilityError } from "../server/story-lifecycle.js";

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

interface MutableMutationHooks {
  afterPublish?: () => void;
}

function mutationHooks(service: StoryService): MutableMutationHooks {
  return (service as unknown as {
    storyMutations: { hooks: MutableMutationHooks };
  }).storyMutations.hooks;
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

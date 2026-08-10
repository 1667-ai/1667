import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  WORKER_PROTOCOL_VERSION,
  type MainToWorkerMessage,
  type WorkerOperationId
} from "../shared/worker-protocol.js";
import { createDurableMutationId } from "../shared/durable-mutation-id.js";
import { StoryService } from "../server/story-service.js";
import { WorkerDeltaBatcher } from "../server/worker-delta-batcher.js";
import { executeWorkerRequest } from "../server/worker-request-executor.js";
import { WorkerRequestCancellation } from "../server/worker-request-cancellation.js";
import type { WorkerRequestFailureResponder } from "../server/worker-request-failure-responder.js";

/**
 * Integration coverage for the reasoning ("thinking") channel across the
 * worker boundary: a real `StoryService` (dry-run provider, the default for
 * a fresh story) driven through `executeWorkerRequest` exactly as the worker
 * process drives it, publishing through a real `WorkerDeltaBatcher`. This is
 * the behavior a user gets — reasoning text streams as its own sequenced
 * wire message, ack-gated by the same credit window as prose, and never
 * lands in the prose a `continueStory` commits — not internal structure.
 */

const OPERATION_ID: WorkerOperationId = {
  workerInstanceId: "1".repeat(32),
  sequence: 1n
};

test("a live worker streams dry-run reasoning as its own sequenced delta channel, never mixed into story prose", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-reasoning-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    const story = await service.createStory("Worker reasoning integration");
    const posted: Array<{
      text: string;
      sequence: number;
      reasoning?: { tokenCount: number };
    }> = [];
    // An idealized zero-latency client: ack every message the instant it
    // posts, so the credit window (MAX_UNACKNOWLEDGED_DELTA_BATCHES) never
    // blocks dry-run's word-by-word stream. A real client's ack round trip
    // is exercised separately by the delta-batcher's own credit tests.
    const deltas: WorkerDeltaBatcher = new WorkerDeltaBatcher(OPERATION_ID, (message) => {
      posted.push({
        text: message.text,
        sequence: message.sequence,
        ...(message.reasoning === undefined ? {} : { reasoning: message.reasoning })
      });
      deltas.acknowledge(message.sequence);
    });
    const mutationId = createDurableMutationId();
    const message: Extract<MainToWorkerMessage, { type: "request" }> = {
      type: "request",
      id: OPERATION_ID,
      method: "continueStory",
      input: {
        storyId: story.id,
        instruction: "",
        genId: crypto.randomUUID(),
        target: { parentId: null }
      },
      protocolVersion: WORKER_PROTOCOL_VERSION,
      mutationId,
      expectedAggregateVersion: (await service.stories.loadVersioned(story.id)).aggregateVersion!,
      deadlineMs: Date.now() + 60_000
    };
    const failures = {
      tracked: async (error: unknown) => assert.fail(`unexpected failure: ${String(error)}`)
    } as unknown as WorkerRequestFailureResponder;
    const terminals: Array<{ type: string }> = [];

    await executeWorkerRequest(
      service,
      message,
      new WorkerRequestCancellation(true, mutationId),
      deltas,
      failures,
      (terminal) => terminals.push({ type: terminal.type })
    );

    assert.deepEqual(terminals, [{ type: "complete" }]);

    const reasoningMessages = posted.filter((entry) => entry.reasoning !== undefined);
    const proseMessages = posted.filter((entry) => entry.reasoning === undefined);
    assert.ok(reasoningMessages.length > 0, "dry-run fabricates at least one reasoning delta");
    assert.ok(proseMessages.length > 0, "dry-run still streams its usual prose");

    const reasoningText = reasoningMessages.map((entry) => entry.text).join("");
    const proseText = proseMessages.map((entry) => entry.text).join("");
    assert.match(reasoningText, /dry-run/);
    // The two channels never bleed into each other: neither text appears
    // inside the other's assembled stream.
    assert.ok(!proseText.includes(reasoningText.trim()));
    assert.ok(!reasoningText.includes(proseText.trim()));

    // One shared monotonic sequence across both channels — the transport's
    // strict `expectedSequence` contract (tui/src/worker-transport.ts) relies
    // on exactly this: 0, 1, 2, ... with no gaps and no repeats regardless of
    // which channel produced a given message.
    const sequences = posted.map((entry) => entry.sequence).sort((a, b) => a - b);
    assert.deepEqual(sequences, sequences.map((_, index) => index));

    // The reasoning token count is a running total: never decreasing.
    const counts = reasoningMessages.map((entry) => entry.reasoning!.tokenCount);
    for (let index = 1; index < counts.length; index += 1) {
      assert.ok(counts[index]! >= counts[index - 1]!, "reasoning token count never decreases");
    }
    assert.ok(counts.at(-1)! > 0);
  } finally {
    await service.dispose();
  }
});

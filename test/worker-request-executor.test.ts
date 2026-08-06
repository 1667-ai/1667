import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_DELTA_BATCH_BYTES,
  MAX_UNACKNOWLEDGED_DELTA_BATCHES,
  WORKER_PROTOCOL_VERSION,
  type MainToWorkerMessage,
  type WorkerOperationId
} from "../shared/worker-protocol.js";
import { ProviderError } from "../server/errors.js";
import type { StoryService } from "../server/story-service.js";
import { WorkerDeltaBatcher } from "../server/worker-delta-batcher.js";
import { executeWorkerRequest } from "../server/worker-request-executor.js";
import { WorkerRequestCancellation } from "../server/worker-request-cancellation.js";
import type { WorkerRequestFailureResponder } from "../server/worker-request-failure-responder.js";

const OPERATION_ID: WorkerOperationId = {
  workerInstanceId: "1".repeat(32),
  sequence: 1n
};

test("a worker deadline during provider-timeout flush transfers the sealed tail", async () => {
  const posted: string[] = [];
  const deltas = new WorkerDeltaBatcher(OPERATION_ID, (message) => {
    posted.push(message.text);
  });
  const fullBatch = "x".repeat(MAX_DELTA_BATCH_BYTES);
  for (let index = 0; index < MAX_UNACKNOWLEDGED_DELTA_BATCHES; index += 1) {
    await deltas.push(fullBatch);
  }
  const tail = "tail".padEnd(MAX_DELTA_BATCH_BYTES, "t");
  const parked = deltas.push(tail);
  await new Promise((resolve) => setImmediate(resolve));

  const timeout = new ProviderError(
    "Model stream was idle beyond the configured deadline.",
    null,
    "",
    { timeout: "provider-idle" }
  );
  const service = {
    runMutation: async () => { throw timeout; }
  } as unknown as StoryService;
  const failures: Array<{
    error: unknown;
    outcome: "terminal" | "uncertain" | undefined;
    unsentText: string | undefined;
  }> = [];
  const responder = {
    tracked: async (
      error: unknown,
      outcome: "terminal" | "uncertain" | undefined,
      unsentText: string | undefined
    ) => {
      failures.push({ error, outcome, unsentText });
    }
  } as unknown as WorkerRequestFailureResponder;
  const request: Extract<MainToWorkerMessage, { type: "request" }> = {
    type: "request",
    id: OPERATION_ID,
    method: "continueStory",
    input: {},
    protocolVersion: WORKER_PROTOCOL_VERSION,
    mutationId: "00000000-0000-7000-8000-000000000001",
    deadlineMs: Date.now() + 60_000
  };
  const cancellation = new WorkerRequestCancellation(true, request.mutationId);
  const execution = executeWorkerRequest(
    service,
    request,
    cancellation,
    deltas,
    responder,
    () => assert.fail("The failed request must not publish a success terminal")
  );
  await new Promise((resolve) => setImmediate(resolve));

  cancellation.cancel("deadline");
  deltas.sealUnsent();
  await execution;
  await parked;

  assert.equal(posted.length, MAX_UNACKNOWLEDGED_DELTA_BATCHES);
  assert.deepEqual(failures, [{
    error: timeout,
    outcome: "terminal",
    unsentText: tail
  }]);
});

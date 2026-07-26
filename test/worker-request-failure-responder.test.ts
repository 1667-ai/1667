import assert from "node:assert/strict";
import test from "node:test";
import { createFailureEnvelope } from "../shared/failure-envelope.js";
import type {
  WorkerOperationId,
  WorkerToMainMessage
} from "../shared/worker-protocol.js";
import { WorkerOperationRegistry } from "../server/worker-operation-registry.js";
import { WorkerRequestFailureResponder } from "../server/worker-request-failure-responder.js";

test("tracked failures publish their terminal state and message atomically", async () => {
  const id: WorkerOperationId = {
    workerInstanceId: "1".repeat(32),
    sequence: 1n
  };
  const operations = new WorkerOperationRegistry(id.workerInstanceId);
  operations.accept(id);
  const messages: WorkerToMainMessage[] = [];
  let finishReport!: (
    message: Extract<WorkerToMainMessage, { type: "error" }>
  ) => void;
  let reportStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    reportStarted = resolve;
  });
  const report = new Promise<
    Extract<WorkerToMainMessage, { type: "error" }>
  >((resolve) => {
    finishReport = resolve;
  });
  const responder = new WorkerRequestFailureResponder(
    { postMessage: (message) => messages.push(message) },
    {
      workerMessage: async () => {
        reportStarted();
        return await report;
      }
    },
    operations,
    id,
    { operation: "createStory", mutationOutcome: "terminal" }
  );

  const tracked = responder.tracked(new Error("private failure"));
  await started;

  assert.equal(operations.state(id), "running");
  assert.deepEqual(messages, []);

  finishReport({
    type: "error",
    id,
    failure: createFailureEnvelope({
      code: "internal",
      message: "Internal server error",
      status: 500
    }),
    mutationOutcome: "terminal"
  });
  await tracked;

  assert.equal(operations.state(id), "failed");
  assert.equal(messages.length, 1);
  assert.equal(
    (messages[0] as WorkerToMainMessage | undefined)?.type,
    "error"
  );
});

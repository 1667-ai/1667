import assert from "node:assert/strict";
import test from "node:test";
import { assertWithinBudget, cpuBudget, startTiming } from "./performance-budget.js";
import { WORKER_MAX_OPERATION_SEQUENCE } from "../shared/worker-protocol.js";
import { ServiceError } from "../server/errors.js";
import {
  WorkerOperationRegistry,
  nextWorkerOperationSequence
} from "../server/worker-operation-registry.js";

const INSTANCE = "1".repeat(32);
const OTHER_INSTANCE = "2".repeat(32);
const operationId = (sequence: bigint, workerInstanceId = INSTANCE) => ({
  workerInstanceId,
  sequence
});

test("worker operation lifecycle retains terminal proof until acknowledgement", () => {
  const registry = new WorkerOperationRegistry(INSTANCE);
  const id = operationId(1n);

  assert.equal(registry.accept(id), "accepted");
  assert.equal(registry.state(id), "running");
  assert.equal(registry.acknowledgeTerminal(id), "running");
  registry.finish(id, "completed");
  assert.equal(registry.state(id), "completed");
  assert.equal(registry.acknowledgeTerminal(id), "acknowledged");
  assert.equal(registry.state(id), "unknown");
});

test("worker operation high-water mark rejects wrong incarnation, replay, and skip", () => {
  const registry = new WorkerOperationRegistry(INSTANCE);
  assert.throws(
    () => registry.accept(operationId(1n, OTHER_INSTANCE)),
    invalidRequest("different incarnation")
  );
  assert.equal(registry.accept(operationId(1n)), "accepted");
  assert.throws(
    () => registry.accept(operationId(1n)),
    invalidRequest("replayed")
  );
  assert.throws(
    () => registry.accept(operationId(3n)),
    invalidRequest("skipped")
  );
  assert.throws(
    () => registry.state(operationId(2n)),
    invalidRequest("never accepted")
  );
});

test("capacity rejection consumes its sequence without allocating a record", () => {
  const registry = new WorkerOperationRegistry(INSTANCE, { capacity: 1 });
  const first = operationId(1n);
  const rejected = operationId(2n);

  assert.equal(registry.accept(first), "accepted");
  assert.equal(registry.accept(rejected), "capacity");
  assert.equal(registry.state(rejected), "unknown");
  registry.finish(first, "failed");
  assert.equal(registry.acknowledgeTerminal(first), "acknowledged");
  assert.equal(registry.accept(operationId(3n)), "accepted");
});

test("only terminal records expire after the retention window", () => {
  let now = 1_000;
  const registry = new WorkerOperationRegistry(INSTANCE, {
    terminalRetentionMs: 100,
    now: () => now
  });
  const terminal = operationId(1n);
  const running = operationId(2n);
  registry.accept(terminal);
  registry.finish(terminal, "canceled");
  registry.accept(running);

  now += 101;
  assert.equal(registry.state(terminal), "unknown");
  assert.equal(registry.state(running), "running");
});

test("uint64 operation sequence exhaustion fails closed", () => {
  assert.throws(
    () => nextWorkerOperationSequence(
      WORKER_MAX_OPERATION_SEQUENCE,
      WORKER_MAX_OPERATION_SEQUENCE
    ),
    invalidRequest("exhausted")
  );
});

test("worker operation registry stays inexpensive under terminal churn", (context) => {
  const registry = new WorkerOperationRegistry(INSTANCE);
  const read = startTiming();
  for (let sequence = 1n; sequence <= 20_000n; sequence += 1n) {
    const id = operationId(sequence);
    assert.equal(registry.accept(id), "accepted");
    registry.finish(id, "completed");
    assert.equal(registry.acknowledgeTerminal(id), "acknowledged");
  }
  const timing = read();
  assertWithinBudget(context, "20,000 worker lifecycles", cpuBudget(2_000), timing);
});

function invalidRequest(message: string) {
  return (error: unknown): boolean => error instanceof ServiceError
    && error.code === "invalid_request"
    && error.message.includes(message);
}

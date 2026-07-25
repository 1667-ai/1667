import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_DELTA_BATCH_BYTES,
  MAX_UNACKNOWLEDGED_DELTA_BATCHES,
  type WorkerToMainMessage
} from "../shared/worker-protocol.js";
import { WorkerDeltaBatcher } from "../server/worker-delta-batcher.js";

type DeltaMessage = Extract<WorkerToMainMessage, { type: "delta" }>;
const OPERATION_ID = {
  workerInstanceId: "1".repeat(32),
  sequence: 1n
} as const;

test("worker delta credit stops producer reads until the main thread acknowledges", async () => {
  const sent: DeltaMessage[] = [];
  const batcher = new WorkerDeltaBatcher(OPERATION_ID, (message) => sent.push(message));
  const fullBatch = "x".repeat(MAX_DELTA_BATCH_BYTES);

  for (let index = 0; index < MAX_UNACKNOWLEDGED_DELTA_BATCHES; index += 1) {
    await batcher.push(fullBatch);
  }
  let released = false;
  const blocked = batcher.push(fullBatch).then(() => { released = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, MAX_UNACKNOWLEDGED_DELTA_BATCHES);
  assert.equal(released, false);

  batcher.acknowledge(0);
  await blocked;
  assert.equal(sent.length, MAX_UNACKNOWLEDGED_DELTA_BATCHES + 1);
  assert.deepEqual(sent.map((message) => message.sequence), sent.map((_, index) => index));
  batcher.dispose();
});

test("worker delta batching splits oversized Unicode without changing text", async () => {
  const sent: DeltaMessage[] = [];
  const batcher = new WorkerDeltaBatcher(OPERATION_ID, (message) => sent.push(message));
  const text = `start-${"🌲".repeat(MAX_DELTA_BATCH_BYTES)}-end`;
  const pushing = batcher.push(text);
  for (;;) {
    await new Promise((resolve) => setImmediate(resolve));
    if (sent.length === 0) continue;
    batcher.acknowledge(sent.at(-1)!.sequence);
    if (Buffer.byteLength(sent.map((message) => message.text).join(""), "utf8") >= Buffer.byteLength(text, "utf8")) break;
  }
  await pushing;
  await batcher.flush();

  assert.equal(sent.map((message) => message.text).join(""), text);
  assert.ok(sent.every((message) => Buffer.byteLength(message.text, "utf8") <= MAX_DELTA_BATCH_BYTES));
  batcher.dispose();
});

test("disposing a credit-blocked batch releases the producer without posting", async () => {
  const sent: DeltaMessage[] = [];
  const batcher = new WorkerDeltaBatcher(OPERATION_ID, (message) => sent.push(message));
  const fullBatch = "x".repeat(MAX_DELTA_BATCH_BYTES);
  for (let index = 0; index < MAX_UNACKNOWLEDGED_DELTA_BATCHES; index += 1) await batcher.push(fullBatch);
  const blocked = batcher.push(fullBatch);
  await new Promise((resolve) => setImmediate(resolve));

  batcher.dispose();
  await blocked;
  assert.equal(sent.length, MAX_UNACKNOWLEDGED_DELTA_BATCHES);
});

test("timed flushes apply backpressure and the final flush awaits their queue", async () => {
  const sent: DeltaMessage[] = [];
  const batcher = new WorkerDeltaBatcher(OPERATION_ID, (message) => sent.push(message));
  for (let index = 0; index < MAX_UNACKNOWLEDGED_DELTA_BATCHES; index += 1) {
    await batcher.push(`batch-${index}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expectBatchCount(sent, MAX_UNACKNOWLEDGED_DELTA_BATCHES);

  await batcher.push("blocked-batch");
  await new Promise((resolve) => setTimeout(resolve, 20));
  let producerReleased = false;
  const producer = batcher.push("next-batch").then(() => { producerReleased = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(producerReleased, false);

  batcher.acknowledge(0);
  await producer;
  const finalFlush = batcher.flush();
  batcher.acknowledge(1);
  await finalFlush;
  assert.equal(sent.map((message) => message.text).join(""),
    [...Array.from({ length: MAX_UNACKNOWLEDGED_DELTA_BATCHES }, (_, index) => `batch-${index}`), "blocked-batch", "next-batch"].join(""));
  batcher.dispose();
});

function expectBatchCount(messages: readonly DeltaMessage[], expected: number): void {
  assert.equal(messages.length, expected);
}

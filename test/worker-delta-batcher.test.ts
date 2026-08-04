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

test("cancellation transfers text still inside the batching window", async () => {
  const sent: DeltaMessage[] = [];
  const batcher = new WorkerDeltaBatcher(
    OPERATION_ID,
    (message) => sent.push(message)
  );

  await batcher.push("arrived before Stop");
  assert.equal(batcher.takeUnsent(), "arrived before Stop");
  batcher.dispose();
  assert.deepEqual(sent, []);
});

test("cancellation transfers text already waiting for transport credit", async () => {
  const sent: DeltaMessage[] = [];
  const batcher = new WorkerDeltaBatcher(
    OPERATION_ID,
    (message) => sent.push(message)
  );
  const fullBatch = "x".repeat(MAX_DELTA_BATCH_BYTES);
  for (let index = 0; index < MAX_UNACKNOWLEDGED_DELTA_BATCHES; index += 1) {
    await batcher.push(fullBatch);
  }
  const blocked = batcher.push("queued".padEnd(
    MAX_DELTA_BATCH_BYTES,
    "q"
  ));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    batcher.takeUnsent(),
    "queued".padEnd(MAX_DELTA_BATCH_BYTES, "q")
  );
  batcher.dispose();
  await blocked;
});

test("a batch reclaimed while blocked on credit is never posted once credit arrives", async () => {
  const sent: DeltaMessage[] = [];
  const batcher = new WorkerDeltaBatcher(
    OPERATION_ID,
    (message) => sent.push(message)
  );
  const fullBatch = "x".repeat(MAX_DELTA_BATCH_BYTES);
  for (let index = 0; index < MAX_UNACKNOWLEDGED_DELTA_BATCHES; index += 1) {
    await batcher.push(fullBatch);
  }
  const blockedText = "queued".padEnd(MAX_DELTA_BATCH_BYTES, "q");
  const blocked = batcher.push(blockedText);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(batcher.takeUnsent(), blockedText);

  // No dispose() here: acknowledging credit for an earlier batch, without
  // disposing, is the hazard case — the reclaimed batch's `send` call is
  // still blocked in `waitForCredit` and must not post once it unblocks.
  batcher.acknowledge(0);

  await assert.doesNotReject(blocked);
  assert.ok(
    sent.every((message) => message.text !== blockedText),
    "reclaimed text must never reach post()"
  );
  assert.equal(sent.length, MAX_UNACKNOWLEDGED_DELTA_BATCHES);
  batcher.dispose();
});

test("a batch drained into the send queue while an earlier batch blocks on credit is still reclaimable", async () => {
  const sent: DeltaMessage[] = [];
  const batcher = new WorkerDeltaBatcher(
    OPERATION_ID,
    (message) => sent.push(message)
  );
  const fullBatch = "x".repeat(MAX_DELTA_BATCH_BYTES);
  for (let index = 0; index < MAX_UNACKNOWLEDGED_DELTA_BATCHES; index += 1) {
    await batcher.push(fullBatch);
  }

  // Both batches are full-size, so each push() flushes immediately and
  // parks in waitForCredit: the first becomes inFlight, the second is
  // handed to flushBuffered() while the send queue is still busy with the
  // first.
  const textA = "first".padEnd(MAX_DELTA_BATCH_BYTES, "a");
  const textB = "second".padEnd(MAX_DELTA_BATCH_BYTES, "b");
  const parkedA = batcher.push(textA);
  await new Promise((resolve) => setImmediate(resolve));
  const parkedB = batcher.push(textB);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    batcher.takeUnsent(),
    textA + textB,
    "the batch drained behind the busy send queue must not vanish from the reclaim"
  );

  // No dispose() before this point: the loss (or its absence) is already
  // decided by takeUnsent() above. Disposing now only lets the two parked
  // push() calls settle so the test can confirm neither batch posts.
  batcher.dispose();
  await assert.doesNotReject(parkedA);
  await assert.doesNotReject(parkedB);
  assert.ok(
    sent.every((message) => message.text !== textA && message.text !== textB),
    "a batch reclaimed by takeUnsent() must never also reach post()"
  );
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

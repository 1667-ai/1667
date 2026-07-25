import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DataDirectoryLock } from "../../server/data-directory-lock.js";
import {
  WORKER_OPERATION_CAPACITY,
  WORKER_PROTOCOL_VERSION,
  isWorkerInstanceId,
  sameWorkerOperationId,
  type MainToWorkerMessage,
  type WorkerOperationId,
  type WorkerToMainMessage
} from "../../shared/worker-protocol.js";

test("worker incarnation and high-water mark fence replay, skip, and old controls", async () => {
  await withWorker(async (worker, workerInstanceId) => {
    const operationId = sequenceId(workerInstanceId);
    const first = operationId();
    expect(await request(worker, {
      type: "request",
      id: first,
      method: "listStories",
      input: {},
      protocolVersion: WORKER_PROTOCOL_VERSION,
      deadlineMs: Date.now() + 60_000
    })).toMatchObject({ type: "result", id: first });

    const replayed = await request(worker, {
      type: "request",
      id: first,
      method: "listStories",
      input: {},
      protocolVersion: WORKER_PROTOCOL_VERSION,
      deadlineMs: Date.now() + 60_000
    });
    expect(replayed.type).toBe("error");
    if (replayed.type !== "error") throw new Error("expected replay error");
    expect(replayed.message).toContain("replayed");

    const skipped = { workerInstanceId, sequence: 3n };
    const skippedResult = await request(worker, {
      type: "request",
      id: skipped,
      method: "listStories",
      input: {},
      protocolVersion: WORKER_PROTOCOL_VERSION,
      deadlineMs: Date.now() + 60_000
    });
    expect(skippedResult.type).toBe("error");
    if (skippedResult.type !== "error") throw new Error("expected skip error");
    expect(skippedResult.message).toContain("skipped");

    const wrongIncarnation = {
      workerInstanceId: "f".repeat(32),
      sequence: 2n
    };
    const wrongResult = await request(worker, {
      type: "request",
      id: wrongIncarnation,
      method: "listStories",
      input: {},
      protocolVersion: WORKER_PROTOCOL_VERSION,
      deadlineMs: Date.now() + 60_000
    });
    expect(wrongResult.type).toBe("error");
    if (wrongResult.type !== "error") throw new Error("expected incarnation error");
    expect(wrongResult.message).toContain("different incarnation");

    const malformed = operationId();
    const malformedResult = nextMessageForId(worker, malformed);
    worker.postMessage({
      type: "request",
      id: malformed,
      method: "missing",
      input: {},
      protocolVersion: WORKER_PROTOCOL_VERSION,
      deadlineMs: Date.now() + 60_000
    });
    expect(await malformedResult).toMatchObject({
      type: "error",
      code: "invalid_request"
    });
    expect(await status(worker, malformed)).toMatchObject({
      type: "operation",
      state: "failed",
      terminal: true
    });

    worker.postMessage({ type: "terminalAck", id: malformed });
    expect(await status(worker, malformed)).toMatchObject({
      type: "operation",
      state: "unknown",
      terminal: true
    });

    const afterMalformed = operationId();
    expect(await request(worker, {
      type: "request",
      id: afterMalformed,
      method: "listStories",
      input: {},
      protocolVersion: WORKER_PROTOCOL_VERSION,
      deadlineMs: Date.now() + 60_000
    })).toMatchObject({ type: "result", id: afterMalformed });
  });
}, 20_000);

test("worker capacity rejects before service entry and still consumes sequence", async () => {
  await withWorker(async (worker, workerInstanceId) => {
    const operationId = sequenceId(workerInstanceId);
    const terminalIds: WorkerOperationId[] = [];
    for (let index = 0; index < WORKER_OPERATION_CAPACITY; index += 1) {
      const id = operationId();
      terminalIds.push(id);
      const result = nextMessageForId(worker, id);
      worker.postMessage({
        type: "request",
        id,
        method: "missing",
        input: {},
        protocolVersion: WORKER_PROTOCOL_VERSION,
        deadlineMs: Date.now() + 60_000
      });
      expect((await result).type).toBe("error");
    }

    const rejected = operationId();
    expect(await request(worker, {
      type: "request",
      id: rejected,
      method: "createStory",
      input: { title: "must not enter service" },
      protocolVersion: WORKER_PROTOCOL_VERSION,
      mutationId: mutationId("c"),
      deadlineMs: Date.now() + 60_000
    })).toMatchObject({
      type: "error",
      code: "resource_busy",
      message: "Worker operation capacity is full",
      mutationOutcome: "terminal"
    });
    expect(await status(worker, rejected)).toMatchObject({
      state: "unknown",
      terminal: true
    });

    worker.postMessage({ type: "terminalAck", id: terminalIds[0]! });
    const admitted = operationId();
    expect(await request(worker, {
      type: "request",
      id: admitted,
      method: "listStories",
      input: {},
      protocolVersion: WORKER_PROTOCOL_VERSION,
      deadlineMs: Date.now() + 60_000
    })).toMatchObject({ type: "result", id: admitted, value: [] });
  });
}, 20_000);

async function withWorker(
  run: (worker: Worker, workerInstanceId: string) => Promise<void>
): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-lifecycle-"));
  const dataLock = new DataDirectoryLock(dataDir);
  await dataLock.acquire();
  const worker = new Worker(new URL("../../server/worker.ts", import.meta.url), {
    type: "module"
  });
  try {
    worker.postMessage({ type: "bootstrap", dataDir, externalDataLock: true });
    const ready = await nextMessageOfType(worker, "ready");
    expect(isWorkerInstanceId(ready.workerInstanceId)).toBeTrue();
    await run(worker, ready.workerInstanceId);
  } finally {
    await worker.terminate();
    await dataLock.release();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function sequenceId(workerInstanceId: string): () => WorkerOperationId {
  let sequence = 0n;
  return () => ({ workerInstanceId, sequence: ++sequence });
}

function mutationId(suffix: string): string {
  return `m1-${Date.now().toString(36)}-${suffix.padStart(32, "0")}`;
}

function request(
  worker: Worker,
  message: Extract<MainToWorkerMessage, { type: "request" }>
): Promise<WorkerToMainMessage> {
  const result = nextMessageForId(worker, message.id);
  worker.postMessage(message);
  return result;
}

function status(
  worker: Worker,
  id: WorkerOperationId
): Promise<Extract<WorkerToMainMessage, { type: "operation" }>> {
  const result = nextMessageForId(worker, id);
  worker.postMessage({ type: "status", id });
  return result as Promise<Extract<WorkerToMainMessage, { type: "operation" }>>;
}

function nextMessageForId(
  worker: Worker,
  id: WorkerOperationId
): Promise<WorkerToMainMessage> {
  return new Promise((resolve) => {
    const listener = ((event: MessageEvent<WorkerToMainMessage>) => {
      const message = event.data;
      if (!("id" in message) || !sameWorkerOperationId(message.id, id)) return;
      if (message.type === "delta") {
        worker.postMessage({ type: "ack", id, sequence: message.sequence });
        return;
      }
      worker.removeEventListener("message", listener);
      resolve(message);
    }) as EventListener;
    worker.addEventListener("message", listener);
  });
}

function nextMessageOfType<T extends WorkerToMainMessage["type"]>(
  worker: Worker,
  type: T
): Promise<Extract<WorkerToMainMessage, { type: T }>> {
  return new Promise((resolve) => {
    const listener = ((event: MessageEvent<WorkerToMainMessage>) => {
      if (event.data.type !== type) return;
      worker.removeEventListener("message", listener);
      resolve(event.data as Extract<WorkerToMainMessage, { type: T }>);
    }) as EventListener;
    worker.addEventListener("message", listener);
  });
}

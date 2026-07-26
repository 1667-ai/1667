import { expect, test } from "bun:test";
import { mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DataDirectoryLock } from "../../server/data-directory-lock.js";
import { SETTINGS_STATE_V2_FILE } from "../../server/data-directory-layout.js";
import { internalErrorLogLockPath } from "../../server/internal-error-log.js";
import { lockFile } from "../../server/os-file-lock.js";
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
    expect(replayed.failure.message).toContain("replayed");

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
    expect(skippedResult.failure.message).toContain("skipped");

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
    expect(wrongResult.failure.message).toContain("different incarnation");

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
      failure: { code: "invalid_request" }
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
      failure: {
        code: "resource_busy",
        message: "Worker operation capacity is full"
      },
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

test("worker publishes failure state with its diagnostic message", async () => {
  await withWorker(async (worker, workerInstanceId, dataDir, machineDir) => {
    await writeFile(path.join(dataDir, SETTINGS_STATE_V2_FILE), "{\n", {
      mode: 0o600
    });
    const logHandle = await open(internalErrorLogLockPath(machineDir), "a");
    const logLock = await lockFile(logHandle.fd);
    try {
      const id = sequenceId(workerInstanceId)();
      const terminal = nextTerminalMessageForId(worker, id);
      worker.postMessage({
        type: "request",
        id,
        method: "getSettings",
        input: {},
        protocolVersion: WORKER_PROTOCOL_VERSION,
        deadlineMs: Date.now() + 60_000
      });

      expect(await Promise.race([
        terminal.then(() => "posted"),
        delay(20).then(() => "blocked")
      ])).toBe("blocked");
      expect(await status(worker, id)).toMatchObject({
        state: "running",
        terminal: false
      });

      await logLock.unlock();
      expect(await terminal).toMatchObject({
        type: "error",
        failure: { code: "internal" }
      });
      expect(await status(worker, id)).toMatchObject({
        state: "failed",
        terminal: true
      });
    } finally {
      await logLock.unlock().catch(() => undefined);
      await logHandle.close();
    }
  });
}, 20_000);

async function withWorker(
  run: (
    worker: Worker,
    workerInstanceId: string,
    dataDir: string,
    machineDir: string
  ) => Promise<void>
): Promise<void> {
  const dataDir = await realpath(
    await mkdtemp(path.join(tmpdir(), "1667-worker-lifecycle-"))
  );
  const machineDir = await realpath(
    await mkdtemp(path.join(tmpdir(), "1667-worker-machine-"))
  );
  const dataLock = new DataDirectoryLock(dataDir);
  await dataLock.acquire();
  const worker = new Worker(new URL("../../server/worker.ts", import.meta.url), {
    type: "module"
  });
  try {
    worker.postMessage({
      type: "bootstrap",
      dataDir,
      machineDir,
      externalDataLock: true
    });
    const ready = await nextMessageOfType(worker, "ready");
    expect(isWorkerInstanceId(ready.workerInstanceId)).toBeTrue();
    await run(worker, ready.workerInstanceId, dataDir, machineDir);
  } finally {
    await worker.terminate();
    await dataLock.release();
    await Promise.all([
      rm(dataDir, { recursive: true, force: true }),
      rm(machineDir, { recursive: true, force: true })
    ]);
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

function nextTerminalMessageForId(
  worker: Worker,
  id: WorkerOperationId
): Promise<WorkerToMainMessage> {
  return new Promise((resolve) => {
    const listener = ((event: MessageEvent<WorkerToMainMessage>) => {
      const message = event.data;
      if (!("id" in message)
        || !sameWorkerOperationId(message.id, id)
        || (message.type !== "result"
          && message.type !== "complete"
          && message.type !== "error")) {
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

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

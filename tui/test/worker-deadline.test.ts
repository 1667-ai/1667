import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { platformPerformanceBudget } from "../../test/performance-budget.js";
import { DataDirectoryLock } from "../../server/data-directory-lock.js";
import { ownedLoopbackHttpSupported } from "../../server/provider-fetch.js";
import { createDurableMutationId } from "../../shared/durable-mutation-id.js";
import {
  MAX_DELTA_BATCH_BYTES,
  MAX_UNACKNOWLEDGED_DELTA_BATCHES,
  WORKER_BUILD_IDENTITY,
  WORKER_PROTOCOL_VERSION,
  workerOperationKey,
  type MainToWorkerMessage,
  type WorkerOperationId,
  type WorkerToMainMessage
} from "../../shared/worker-protocol.js";
import type { StoryPayload } from "../../shared/types.js";

const PROVIDER_START_DEADLINE_MS = 1_000;

describe("embedded worker deadlines", () => {
  test("reports a locally aborted stream mutation as uncertain", async () => {
    // The provider-start fence needs the owned plaintext transport. Other
    // release targets reject this fixture before the provider by design.
    if (!ownedLoopbackHttpSupported()) return;
    const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-deadline-"));
    const openResponses = new Set<ServerResponse>();
    const providerRequestWaiters: Array<() => void> = [];
    const model = createServer((_request, response) => {
      providerRequestWaiters.shift()?.();
      openResponses.add(response);
      response.on("close", () => openResponses.delete(response));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
    });
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    const modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;
    const dataLock = new DataDirectoryLock(dataDir, { initializeDataFormat: 1 });
    await dataLock.acquire();
    await writeFile(path.join(dataDir, "settings.json"), `${JSON.stringify({
      provider: "openai-compatible",
      baseUrl: modelUrl,
      model: "deadline-fixture",
      apiKeyEnv: null,
      temperature: null,
      maxTokens: 64,
      systemPrompt: "Continue the story.",
      contextWindow: null
    })}\n`, { mode: 0o600 });

    const worker = new Worker(new URL("../../server/worker.ts", import.meta.url), { type: "module" });
    try {
      worker.postMessage({ type: "bootstrap", dataDir, externalDataLock: true });
      const ready = await nextMessageOfType(worker, "ready");
      expect(ready).toMatchObject({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        buildIdentity: WORKER_BUILD_IDENTITY
      });
      let sequence = 0n;
      const operationId = (): WorkerOperationId => ({
        workerInstanceId: ready.workerInstanceId,
        sequence: ++sequence
      });

      const created = await request(worker, {
        type: "request",
        id: operationId(),
        method: "createStory",
        input: { title: "Deadline proof" },
        protocolVersion: WORKER_PROTOCOL_VERSION,
        mutationId: mutationId("1"),
        deadlineMs: Date.now() + 60_000
      });
      expect(created.type).toBe("result");
      const storyId = (created as Extract<WorkerToMainMessage, { type: "result" }>).value as StoryPayload;
      const withRoot = await request(worker, {
        type: "request",
        id: operationId(),
        method: "createNode",
        input: { storyId: storyId.id, body: { parentId: null, text: "The door opened." } },
        protocolVersion: WORKER_PROTOCOL_VERSION,
        mutationId: mutationId("2"),
        deadlineMs: Date.now() + 60_000
      });
      const rootedStory = (withRoot as Extract<WorkerToMainMessage, { type: "result" }>).value as StoryPayload;
      if (rootedStory.aggregateVersion === undefined) {
        throw new Error("Deadline fixture is missing successor aggregate metadata");
      }
      const expectedAggregateVersion = rootedStory.aggregateVersion;
      const createdSummaryStory = await request(worker, {
        type: "request",
        id: operationId(),
        method: "createStory",
        input: { title: "Summary deadline proof" },
        protocolVersion: WORKER_PROTOCOL_VERSION,
        mutationId: mutationId("summary-1"),
        deadlineMs: Date.now() + 60_000
      });
      expect(createdSummaryStory.type).toBe("result");
      const summaryStory = (
        createdSummaryStory as Extract<WorkerToMainMessage, { type: "result" }>
      ).value as StoryPayload;
      const summaryWithRoot = await request(worker, {
        type: "request",
        id: operationId(),
        method: "createNode",
        input: {
          storyId: summaryStory.id,
          body: { parentId: null, text: "The second door opened." }
        },
        protocolVersion: WORKER_PROTOCOL_VERSION,
        mutationId: mutationId("summary-2"),
        deadlineMs: Date.now() + 60_000
      });
      expect(summaryWithRoot.type).toBe("result");
      const rootedSummaryStory = (
        summaryWithRoot as Extract<WorkerToMainMessage, { type: "result" }>
      ).value as StoryPayload;
      if (rootedSummaryStory.aggregateVersion === undefined) {
        throw new Error("Summary deadline fixture is missing aggregate metadata");
      }

      const generationMutationId = mutationId("3");
      const generationInput = {
        storyId: storyId.id,
        instruction: "Wait beyond the deadline.",
        genId: "deadline-generation",
        target: { parentId: rootedStory.path[0]!.id }
      };
      const generationProviderStarted = nextProviderRequest(providerRequestWaiters);
      const expiredGeneration = request(worker, {
        type: "request",
        id: operationId(),
        method: "continueStory",
        input: generationInput,
        protocolVersion: WORKER_PROTOCOL_VERSION,
        mutationId: generationMutationId,
        expectedAggregateVersion,
        deadlineMs: Date.now() + PROVIDER_START_DEADLINE_MS
      });
      expect(await providerStartsBeforeResult(generationProviderStarted, expiredGeneration)).toBe(true);
      const expired = await expiredGeneration;
      expect(expired).toMatchObject({
        type: "error",
        failure: { code: "mutation_outcome_unknown" },
        mutationOutcome: "uncertain"
      });

      const replayed = await request(worker, {
        type: "request",
        id: operationId(),
        method: "continueStory",
        input: generationInput,
        protocolVersion: WORKER_PROTOCOL_VERSION,
        mutationId: generationMutationId,
        expectedAggregateVersion,
        deadlineMs: Date.now() + 60_000
      });
      expect(replayed).toMatchObject({
        type: "error",
        failure: { code: "generation_outcome_unknown" },
        mutationOutcome: "uncertain"
      });

      const summaryMutationId = mutationId("4");
      const summaryInput = {
        storyId: summaryStory.id,
        body: { nodeId: rootedSummaryStory.path[0]!.id }
      };
      const summaryProviderStarted = nextProviderRequest(providerRequestWaiters);
      const expiredSummaryRequest = request(worker, {
        type: "request",
        id: operationId(),
        method: "createSummaryTake",
        input: summaryInput,
        protocolVersion: WORKER_PROTOCOL_VERSION,
        mutationId: summaryMutationId,
        expectedAggregateVersion: rootedSummaryStory.aggregateVersion,
        deadlineMs: Date.now() + PROVIDER_START_DEADLINE_MS
      });
      expect(await providerStartsBeforeResult(summaryProviderStarted, expiredSummaryRequest)).toBe(true);
      const expiredSummary = await expiredSummaryRequest;
      expect(expiredSummary).toMatchObject({
        type: "error",
        failure: { code: "mutation_outcome_unknown" },
        mutationOutcome: "uncertain"
      });

      const replayedSummary = await request(worker, {
        type: "request",
        id: operationId(),
        method: "createSummaryTake",
        input: summaryInput,
        protocolVersion: WORKER_PROTOCOL_VERSION,
        mutationId: summaryMutationId,
        expectedAggregateVersion: rootedSummaryStory.aggregateVersion,
        deadlineMs: Date.now() + 60_000
      });
      expect(replayedSummary).toMatchObject({
        type: "error",
        failure: { code: "generation_outcome_unknown" },
        mutationOutcome: "uncertain"
      });
    } finally {
      await worker.terminate();
      await dataLock.release();
      for (const response of openResponses) response.destroy();
      model.closeAllConnections();
      if (model.listening) {
        await new Promise<void>((resolve) => model.close(() => resolve()));
      }
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 20_000);

  test("a deadline publishes a single oversized accepted delta before its error terminal", async () => {
    if (!ownedLoopbackHttpSupported()) return;
    const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-deadline-tail-"));
    const openResponses = new Set<ServerResponse>();
    let releaseProviderResponse!: (response: ServerResponse) => void;
    const providerResponse = new Promise<ServerResponse>((resolve) => {
      releaseProviderResponse = resolve;
    });
    const model = createServer((_request, response) => {
      openResponses.add(response);
      response.on("close", () => openResponses.delete(response));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      releaseProviderResponse(response);
    });
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    const modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;
    const dataLock = new DataDirectoryLock(dataDir, { initializeDataFormat: 1 });
    await dataLock.acquire();
    await writeFile(path.join(dataDir, "settings.json"), `${JSON.stringify({
      provider: "openai-compatible",
      baseUrl: modelUrl,
      model: "deadline-tail-fixture",
      apiKeyEnv: null,
      temperature: null,
      maxTokens: 20_000,
      systemPrompt: "Continue the story.",
      contextWindow: null
    })}\n`, { mode: 0o600 });

    const worker = new Worker(new URL("../../server/worker.ts", import.meta.url), { type: "module" });
    try {
      worker.postMessage({ type: "bootstrap", dataDir, externalDataLock: true });
      const ready = await nextMessageOfType(worker, "ready");
      let sequence = 0n;
      const operationId = (): WorkerOperationId => ({
        workerInstanceId: ready.workerInstanceId,
        sequence: ++sequence
      });
      const created = await request(worker, {
        type: "request",
        id: operationId(),
        method: "createStory",
        input: { title: "Deadline tail proof" },
        protocolVersion: WORKER_PROTOCOL_VERSION,
        mutationId: mutationId("1"),
        deadlineMs: Date.now() + 60_000
      });
      const storyId = (created as Extract<WorkerToMainMessage, { type: "result" }>).value as StoryPayload;
      const withRoot = await request(worker, {
        type: "request",
        id: operationId(),
        method: "createNode",
        input: { storyId: storyId.id, body: { parentId: null, text: "The door opened." } },
        protocolVersion: WORKER_PROTOCOL_VERSION,
        mutationId: mutationId("2"),
        deadlineMs: Date.now() + 60_000
      });
      const rootedStory = (withRoot as Extract<WorkerToMainMessage, { type: "result" }>).value as StoryPayload;
      if (rootedStory.aggregateVersion === undefined) {
        throw new Error("Deadline fixture is missing successor aggregate metadata");
      }

      // The harness plays the main transport whose deadline timer fires: it
      // never acknowledges a delta, so the worker's credit window
      // (MAX_UNACKNOWLEDGED_DELTA_BATCHES) closes after eight posted
      // batches and every later word stays inside the batcher — exactly
      // the text a disposed batcher used to drop on deadline.
      const generationId = operationId();
      const collected = collectWithoutAck(worker, generationId);
      const terminal = request(worker, {
        type: "request",
        id: generationId,
        method: "continueStory",
        input: {
          storyId: storyId.id,
          instruction: "Stream past the credit window.",
          genId: "deadline-tail-generation",
          target: { parentId: rootedStory.path[0]!.id }
        },
        protocolVersion: WORKER_PROTOCOL_VERSION,
        mutationId: mutationId("3"),
        expectedAggregateVersion: rootedStory.aggregateVersion,
        deadlineMs: Date.now() + 60_000
      }, collected.listener);
      const response = await providerResponse;
      const posted: string[] = [];
      for (let index = 0; index < MAX_UNACKNOWLEDGED_DELTA_BATCHES; index += 1) {
        const word = `word-${index} `;
        posted.push(word);
        response.write(sseDelta(word));
        await collected.waitForDeltaCount(index + 1);
      }
      // No delta can announce the parked word (the credit window is
      // closed), so give it a generous budget to travel the loopback socket
      // into the batcher before the deadline cancel seals it. This is one
      // provider delta larger than the complete credit window.
      const parked = "single-provider-delta ".padEnd(
        MAX_DELTA_BATCH_BYTES * (MAX_UNACKNOWLEDGED_DELTA_BATCHES + 3),
        "p"
      );
      response.write(sseDelta(parked));
      await new Promise((resolve) => setTimeout(resolve, platformPerformanceBudget(500)));

      worker.postMessage({
        type: "cancel",
        id: generationId,
        reason: "deadline"
      });
      const expired = await terminal;
      expect(expired).toMatchObject({
        type: "error",
        failure: { code: "mutation_outcome_unknown" },
        mutationOutcome: "uncertain"
      });
      expect(collected.deltas.join("")).toBe(posted.join("") + parked);
      expect(collected.deltas.every((text) =>
        Buffer.byteLength(text, "utf8") <= MAX_DELTA_BATCH_BYTES)).toBe(true);
    } finally {
      await worker.terminate();
      await dataLock.release();
      for (const response of openResponses) response.destroy();
      model.closeAllConnections();
      if (model.listening) {
        await new Promise<void>((resolve) => model.close(() => resolve()));
      }
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 20_000);
});

function sseDelta(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

/** Records a stream's deltas without acknowledging any of them, so the
 * worker's credit window closes by itself. */
function collectWithoutAck(
  worker: Worker,
  id: WorkerOperationId
): {
  deltas: string[];
  listener(message: WorkerToMainMessage): boolean;
  waitForDeltaCount(count: number): Promise<void>;
} {
  const deltas: string[] = [];
  let waiters: Array<() => void> = [];
  return {
    deltas,
    listener: (message) => {
      if (message.type !== "delta"
        || workerOperationKey(message.id) !== workerOperationKey(id)) {
        return false;
      }
      deltas.push(message.text);
      const released = waiters;
      waiters = [];
      for (const release of released) release();
      return true;
    },
    waitForDeltaCount: async (count) => {
      const deadline = Date.now() + platformPerformanceBudget(2_000);
      while (deltas.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`Delta ${count} was never posted`);
        }
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 10);
        });
      }
    }
  };
}

function nextProviderRequest(waiters: Array<() => void>): Promise<void> {
  return new Promise((resolve) => waiters.push(resolve));
}

async function providerStartsBeforeResult(
  providerStarted: Promise<void>,
  result: Promise<WorkerToMainMessage>
): Promise<boolean> {
  return await Promise.race([
    providerStarted.then(() => true),
    result.then(() => false)
  ]);
}

function request(
  worker: Worker,
  message: Extract<MainToWorkerMessage, { type: "request" }>,
  interceptDelta?: (message: WorkerToMainMessage) => boolean
): Promise<WorkerToMainMessage> {
  const result = nextMessageForRequest(worker, message.id, interceptDelta);
  worker.postMessage(message);
  return result;
}

function nextMessageForRequest(
  worker: Worker,
  id: WorkerOperationId,
  interceptDelta?: (message: WorkerToMainMessage) => boolean
): Promise<WorkerToMainMessage> {
  return new Promise((resolve) => {
    const listener = ((event: MessageEvent<WorkerToMainMessage>) => {
      const message = event.data;
      if (!("id" in message)
        || workerOperationKey(message.id) !== workerOperationKey(id)) return;
      if (message.type === "operation") return;
      if (message.type === "delta") {
        if (interceptDelta?.(message) === true) return;
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

function mutationId(_suffix: string): string {
  return createDurableMutationId();
}

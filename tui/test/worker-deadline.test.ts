import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DataDirectoryLock } from "../../server/data-directory-lock.js";
import { ownedLoopbackHttpSupported } from "../../server/provider-fetch.js";
import {
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
        deadlineMs: Date.now() + 60_000
      });
      expect(replayed).toMatchObject({
        type: "error",
        failure: { code: "generation_outcome_unknown" },
        mutationOutcome: "uncertain"
      });

      const summaryMutationId = mutationId("4");
      const summaryInput = { storyId: storyId.id, body: { nodeId: rootedStory.path[0]!.id } };
      const summaryProviderStarted = nextProviderRequest(providerRequestWaiters);
      const expiredSummaryRequest = request(worker, {
        type: "request",
        id: operationId(),
        method: "createSummaryTake",
        input: summaryInput,
        protocolVersion: WORKER_PROTOCOL_VERSION,
        mutationId: summaryMutationId,
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
});

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

function request(worker: Worker, message: Extract<MainToWorkerMessage, { type: "request" }>): Promise<WorkerToMainMessage> {
  const result = nextMessageForRequest(worker, message.id);
  worker.postMessage(message);
  return result;
}

function nextMessageForRequest(
  worker: Worker,
  id: WorkerOperationId
): Promise<WorkerToMainMessage> {
  return new Promise((resolve) => {
    const listener = ((event: MessageEvent<WorkerToMainMessage>) => {
      const message = event.data;
      if (!("id" in message)
        || workerOperationKey(message.id) !== workerOperationKey(id)) return;
      if (message.type === "operation") return;
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

function mutationId(suffix: string): string {
  return `m1-${Date.now().toString(36)}-${suffix.padStart(32, "0")}`;
}

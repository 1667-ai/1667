import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  WORKER_PROTOCOL_VERSION,
  type MainToWorkerMessage,
  type WorkerToMainMessage
} from "../shared/worker-protocol.js";
import { createDurableMutationId } from "../shared/durable-mutation-id.js";
import { StoryService } from "../server/story-service.js";
import { StoryAggregateSession } from "../server/story-aggregate-session.js";
import { mintStoryMutationRequest } from "../server/story-mutation-request.js";
import { MUTATION_RECEIPT_DIRECTORY } from "../server/chapter-break-undo-liveness.js";
import { WorkerRequestCancellation } from "../server/worker-request-cancellation.js";
import type { WorkerRequestFailureResponder } from "../server/worker-request-failure-responder.js";
import { executeWorkerRequest } from "../server/worker-request-executor.js";

type WorkerTerminalMessage = Extract<
  WorkerToMainMessage,
  { type: "complete" | "result" }
>;

test("v2 ask receipts replay the current session without rerunning the provider", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-aside-receipt-v2-ask-"));
  const dataDir = path.join(root, "project");
  const service = StoryService.withoutDiagnostics({ dataDir, asideActivation: true });
  await service.init();
  t.after(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const story = await service.createStory("V2 ask receipt");
  const node = await service.createNode(story.id, {
    parentId: null,
    instruction: "",
    text: "A lantern burned."
  });
  const takeId = node.path.at(-1)!.id;
  const anchor = { partId: takeId, takeId };
  const mutationId = createDurableMutationId();
  const expectedAggregateVersion = (await service.stories.loadVersioned(story.id)).aggregateVersion!;
  const input = { storyId: story.id, question: "Why?", anchor };
  let providerCalls = 0;
  const originalAsk = service.askAsideV2.bind(service);
  service.askAsideV2 = async (...args) => {
    providerCalls += 1;
    return await originalAsk(...args);
  };

  const first = await runWorkerMutation(
    service,
    "askAside",
    input,
    mutationId,
    expectedAggregateVersion,
    1n
  ) as { id: string; turns: readonly unknown[] };
  assert.equal(providerCalls, 1);
  assert.equal(first.turns.length, 1);

  await service.asideSessionMutation(story.id, {
    operation: "clear",
    sessionId: first.id,
    anchor
  });
  const replay = await runWorkerMutation(
    service,
    "askAside",
    input,
    mutationId,
    expectedAggregateVersion,
    2n
  ) as { id: string; turns: readonly unknown[] };
  assert.equal(providerCalls, 1, "a receipt replay must not rerun Ask");
  assert.equal(replay.id, first.id);
  assert.equal(replay.turns.length, 0, "replay must read the current session");
  assert.deepEqual(
    await receiptResult(dataDir, mutationId),
    { type: "aside-session", storyId: story.id, sessionId: first.id }
  );
});

test("v2 receipt replay keeps the session and payload on one aggregate snapshot", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-aside-receipt-v2-race-"));
  const dataDir = path.join(root, "project");
  const service = StoryService.withoutDiagnostics({ dataDir, asideActivation: true });
  await service.init();
  t.after(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const story = await service.createStory("V2 receipt race");
  const node = await service.createNode(story.id, {
    parentId: null,
    instruction: "",
    text: "A lantern burned."
  });
  const takeId = node.path.at(-1)!.id;
  const anchor = { partId: takeId, takeId };
  const mutationId = createDurableMutationId();
  const receiptVersion = (await service.stories.loadVersioned(story.id)).aggregateVersion!;
  const input = { storyId: story.id, question: "Why?", anchor, sessionId: "race-session" };

  const first = await runWorkerMutation(
    service,
    "askAside",
    input,
    mutationId,
    receiptVersion,
    1n
  ) as {
    id: string;
    turns: readonly unknown[];
  };
  assert.equal(first.turns.length, 1);
  const snapshotPayload = await service.loadStory(story.id);
  const snapshotVersion = snapshotPayload.aggregateVersion;

  const readDocument = StoryAggregateSession.prototype.readAsideSessionDocument;
  let readStarted!: () => void;
  const readStartedPromise = new Promise<void>((resolve) => { readStarted = resolve; });
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  StoryAggregateSession.prototype.readAsideSessionDocument = async function (documentId) {
    const document = await readDocument.call(this, documentId);
    readStarted();
    await readGate;
    return document;
  };
  t.after(() => {
    releaseRead();
    StoryAggregateSession.prototype.readAsideSessionDocument = readDocument;
  });

  const replayPromise = runWorkerMutation(
    service,
    "askAside",
    input,
    mutationId,
    receiptVersion,
    2n
  );
  await readStartedPromise;
  let clearSettled = false;
  const clearPromise = service.asideSessionMutation(story.id, {
    operation: "clear",
    sessionId: first.id,
    anchor
  }).then((result) => {
    clearSettled = true;
    return result;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(clearSettled, false, "the replay read must hold the aggregate claim");

  releaseRead();
  const replay = await replayPromise as {
    id: string;
    turns: readonly unknown[];
    payload?: {
      aggregateVersion?: unknown;
      hasAsideSessions?: true;
      asidePresence?: unknown;
    };
  };
  await clearPromise;
  assert.equal(replay.id, first.id);
  assert.equal(replay.turns.length, 1);
  assert.deepEqual(replay.payload?.aggregateVersion, snapshotVersion);
  assert.equal(replay.payload?.hasAsideSessions, true);
  assert.deepEqual(replay.payload?.asidePresence, snapshotPayload.asidePresence);
  assert.notDeepEqual(
    replay.payload?.aggregateVersion,
    (await service.loadStory(story.id)).aggregateVersion,
    "replay payload must not be rebuilt from the post-clear revision"
  );
});

test("v2 receipt replay keeps the recovery snapshot across a concurrent clear", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-aside-receipt-v2-reset-race-"));
  const dataDir = path.join(root, "project");
  const service = StoryService.withoutDiagnostics({ dataDir, asideActivation: true });
  const concurrent = StoryService.withoutDiagnostics({
    dataDir,
    asideActivation: true,
    dataLock: "external",
    mutationRecovery: "external"
  });
  await service.init();
  await concurrent.init();
  t.after(async () => {
    await service.dispose();
    await concurrent.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const story = await service.createStory("V2 receipt reset race");
  const node = await service.createNode(story.id, {
    parentId: null,
    instruction: "",
    text: "A lantern burned."
  });
  const takeId = node.path.at(-1)!.id;
  const anchor = { partId: takeId, takeId };
  const input = {
    storyId: story.id,
    question: "Why?",
    anchor,
    sessionId: "reset-race-session"
  };
  const mutationRequest = await mintStoryMutationRequest(
    service.stories,
    story.id,
    "askAside",
    JSON.stringify(input)
  );
  const first = await service.askAsideV2(
    story.id,
    { question: input.question, anchor, sessionId: input.sessionId },
    async () => {},
    new AbortController().signal,
    { mutationRequest }
  );
  assert.ok(first !== null);
  const snapshotPayload = await service.loadStory(story.id);

  const originalLoadLive = StoryAggregateSession.prototype.loadLive;
  let resetTriggered = false;
  StoryAggregateSession.prototype.loadLive = async function () {
    const loaded = await originalLoadLive.call(this);
    if (!resetTriggered && this.storyId === story.id) {
      resetTriggered = true;
      await concurrent.asideSessionMutation(story.id, {
        operation: "clear",
        sessionId: first.id,
        anchor
      });
    }
    return loaded;
  };
  t.after(() => {
    StoryAggregateSession.prototype.loadLive = originalLoadLive;
  });

  const replay = await service.askAsideV2(
    story.id,
    { question: input.question, anchor, sessionId: input.sessionId },
    async () => {},
    new AbortController().signal,
    { mutationRequest }
  );
  assert.ok(replay !== null);
  assert.equal(replay.turns.length, 1);
  assert.deepEqual(replay.payload?.aggregateVersion, snapshotPayload.aggregateVersion);
  assert.deepEqual(replay.payload?.asidePresence, snapshotPayload.asidePresence);

  const afterReset = await concurrent.getAsideV2(story.id, anchor);
  assert.equal(afterReset.sessions.find((session) => session.id === first.id)?.turns.length, 0);
  assert.notDeepEqual(
    replay.payload?.aggregateVersion,
    (await service.loadStory(story.id)).aggregateVersion,
    "the replay response must retain the recovery snapshot revision"
  );
});

test("v2 retake receipts replay the current session after a later clear", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-aside-receipt-v2-retake-"));
  const dataDir = path.join(root, "project");
  const service = StoryService.withoutDiagnostics({ dataDir, asideActivation: true });
  await service.init();
  t.after(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const story = await service.createStory("V2 retake receipt");
  const node = await service.createNode(story.id, {
    parentId: null,
    instruction: "",
    text: "A bell rang."
  });
  const takeId = node.path.at(-1)!.id;
  const anchor = { partId: takeId, takeId };
  const first = await service.askAsideV2(
    story.id,
    { question: "Why?", anchor, sessionId: "retake-session" },
    async () => {},
    new AbortController().signal
  );
  assert.ok(first !== null);
  const mutationId = createDurableMutationId();
  const expectedAggregateVersion = (await service.stories.loadVersioned(story.id)).aggregateVersion!;
  const input = {
    storyId: story.id,
    sessionId: first.id,
    turnIndex: 0,
    anchor
  };
  let providerCalls = 0;
  const originalRetake = service.retakeAside.bind(service);
  service.retakeAside = async (...args) => {
    providerCalls += 1;
    return await originalRetake(...args);
  };

  const retaken = await runWorkerMutation(
    service,
    "retakeAside",
    input,
    mutationId,
    expectedAggregateVersion,
    1n
  ) as { id: string; turns: readonly unknown[] };
  assert.equal(providerCalls, 1);
  assert.equal(retaken.turns.length, 1);
  await service.asideSessionMutation(story.id, {
    operation: "clear",
    sessionId: first.id,
    anchor
  });

  const replay = await runWorkerMutation(
    service,
    "retakeAside",
    input,
    mutationId,
    expectedAggregateVersion,
    2n
  ) as { id: string; turns: readonly unknown[] };
  assert.equal(providerCalls, 1, "a receipt replay must not rerun Retake");
  assert.equal(replay.id, first.id);
  assert.equal(replay.turns.length, 0, "replay must read the current session");
  assert.deepEqual(
    await receiptResult(dataDir, mutationId),
    { type: "aside-session", storyId: story.id, sessionId: first.id }
  );
});

test("v2 local-session receipts replay the current typed session view", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-aside-receipt-v2-local-"));
  const dataDir = path.join(root, "project");
  const service = StoryService.withoutDiagnostics({ dataDir, asideActivation: true });
  await service.init();
  t.after(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const story = await service.createStory("V2 local receipt");
  const first = await service.askAsideV2(
    story.id,
    { question: "First?", anchor: null, sessionId: "local-session" },
    async () => {},
    new AbortController().signal
  );
  assert.ok(first !== null);
  const mutationId = createDurableMutationId();
  const expectedAggregateVersion = (await service.stories.loadVersioned(story.id)).aggregateVersion!;
  const input = {
    storyId: story.id,
    operation: "clear" as const,
    sessionId: first.id,
    anchor: null
  };
  let mutationCalls = 0;
  const originalMutation = service.asideSessionMutation.bind(service);
  service.asideSessionMutation = async (...args) => {
    mutationCalls += 1;
    return await originalMutation(...args);
  };

  const cleared = await runWorkerMutation(
    service,
    "asideSessionMutation",
    input,
    mutationId,
    expectedAggregateVersion,
    1n
  ) as { id: string; turns: readonly unknown[] };
  assert.equal(cleared.turns.length, 0);
  assert.equal(mutationCalls, 1);
  await service.askAsideV2(
    story.id,
    { question: "Second?", anchor: null, sessionId: first.id },
    async () => {},
    new AbortController().signal
  );

  const replay = await runWorkerMutation(
    service,
    "asideSessionMutation",
    input,
    mutationId,
    expectedAggregateVersion,
    2n
  ) as { id: string; turns: readonly unknown[] };
  assert.equal(mutationCalls, 1, "a receipt replay must not rerun the local verb");
  assert.equal(replay.id, first.id);
  assert.equal(replay.turns.length, 1, "replay must read the current session");
  assert.deepEqual(
    await receiptResult(dataDir, mutationId),
    { type: "aside-session", storyId: story.id, sessionId: first.id }
  );
});

async function runWorkerMutation(
  service: StoryService,
  method: "askAside" | "retakeAside" | "asideSessionMutation",
  input: unknown,
  mutationId: string,
  expectedAggregateVersion: unknown,
  sequence: bigint
): Promise<unknown> {
  const terminals: WorkerTerminalMessage[] = [];
  const errors: unknown[] = [];
  const request: Extract<MainToWorkerMessage, { type: "request" }> = {
    type: "request",
    id: { workerInstanceId: "4".repeat(32), sequence },
    method,
    input,
    protocolVersion: WORKER_PROTOCOL_VERSION,
    mutationId,
    expectedAggregateVersion,
    deadlineMs: Date.now() + 60_000
  };
  await executeWorkerRequest(
    service,
    request,
    new WorkerRequestCancellation(true, mutationId),
    null,
    {
      tracked: async (error: unknown) => { errors.push(error); }
    } as unknown as WorkerRequestFailureResponder,
    (terminal) => terminals.push(terminal as WorkerTerminalMessage)
  );
  if (errors.length > 0) throw errors[0];
  assert.equal(terminals.length, 1);
  return terminals[0]!.value;
}

async function receiptResult(dataDir: string, mutationId: string): Promise<unknown> {
  const text = await readFile(
    path.join(dataDir, MUTATION_RECEIPT_DIRECTORY, `${mutationId}.json`),
    "utf8"
  );
  return (JSON.parse(text) as { result?: unknown }).result;
}

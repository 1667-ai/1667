/**
 * HTTP/worker Aside surfaces and shared busy fence.
 */
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  WORKER_PROTOCOL_VERSION,
  type MainToWorkerMessage,
  type WorkerOperationId
} from "../shared/worker-protocol.js";
import { createDurableMutationId } from "../shared/durable-mutation-id.js";
import { httpOperationPolicy } from "../shared/http-operation-policy.js";
import { GenerationCancelledError, ServiceError } from "../server/errors.js";
import { MUTATION_RECEIPT_DIRECTORY } from "../server/chapter-break-undo-liveness.js";
import { StoryService } from "../server/story-service.js";
import { executeWorkerRequest } from "../server/worker-request-executor.js";
import { WorkerRequestCancellation } from "../server/worker-request-cancellation.js";
import type { WorkerRequestFailureResponder } from "../server/worker-request-failure-responder.js";
import { validateWorkerRequestSize } from "../server/worker-request-size.js";
import { streamResponse } from "../server/stream-response.js";
import { prepareProviderStoryEffect } from "../server/story-provider-preparation.js";
import {
  FINGERPRINT,
  MUTATION_ID,
  OTHER_FINGERPRINT,
  OTHER_MUTATION_ID,
  providerOperation,
  requestFor,
  setup,
  STORY_ID
} from "./story-mutation-fixtures.js";
import { ensureRootPart, hasCode } from "./aside-test-helpers.js";
import { FakeResponse } from "./fake-http-response.js";

test("HTTP Aside delivers a committed answer when Stop races terminal settlement", async () => {
  const request = Readable.from([]) as unknown as IncomingMessage;
  const response = new FakeResponse();
  const operation = new AbortController();
  let prepared!: () => void;
  const effectPrepared = new Promise<void>((resolve) => { prepared = resolve; });
  let release!: () => void;
  const terminalGate = new Promise<void>((resolve) => { release = resolve; });
  const running = streamResponse(
    request,
    response as unknown as ServerResponse,
    async () => {
      // Models the Aside effect having passed its durable commit boundary.
      prepared();
      await terminalGate;
      return { type: "done", aside: { notes: [{ question: "Why?", answer: "Because." }] } };
    },
    (value) => value,
    operation.signal,
    undefined,
    undefined,
    undefined,
    {
      preserveDoneAfterOperationAbort: (reason) =>
        reason instanceof GenerationCancelledError
    }
  );

  await effectPrepared;
  operation.abort(new GenerationCancelledError());
  release();
  await running;

  assert.match(response.output, /"type":"done"/u);
  assert.match(response.output, /"answer":"Because\."/u);
  assert.equal(response.ends, 1);
});

test("HTTP Aside keeps pre-commit cancellation null", async () => {
  const request = Readable.from([]) as unknown as IncomingMessage;
  const response = new FakeResponse();
  const operation = new AbortController();
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const running = streamResponse(
    request,
    response as unknown as ServerResponse,
    async () => {
      started();
      await gate;
      return null;
    },
    () => ({ type: "done" }),
    operation.signal,
    undefined,
    undefined,
    undefined,
    {
      preserveDoneAfterOperationAbort: (reason) =>
        reason instanceof GenerationCancelledError
    }
  );

  await startedPromise;
  operation.abort(new GenerationCancelledError());
  release();
  await running;

  assert.doesNotMatch(response.output, /"type":"done"/u);
  assert.equal(response.ends, 1);
});

test("HTTP disconnect revokes an earlier user Stop before Aside preparation", async () => {
  const request = Readable.from([]) as unknown as IncomingMessage;
  const response = new FakeResponse();
  const operation = new AbortController();
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const running = streamResponse(
    request,
    response as unknown as ServerResponse,
    async (_onDelta, signal, _onReasoning, transportConnected) => {
      started();
      await gate;
      assert.throws(
        () => prepareProviderStoryEffect({
          kind: "aside",
          expectedAsideDocumentId: undefined,
          document: {
            schemaVersion: 1,
            notes: [{ question: "Why?", answer: "Partial answer." }]
          },
          cancelled: signal,
          canCommitStoppedAside: () => transportConnected()
        }),
        /Aside was cancelled before it could be saved/u
      );
      return null;
    },
    () => ({ type: "done" }),
    operation.signal
  );

  await startedPromise;
  operation.abort(new GenerationCancelledError());
  response.closed = true;
  response.emit("close");
  release();
  await running;

  assert.equal(response.ends, 1);
});

test("HTTP Aside suppresses a committed result when session close supersedes Stop", async () => {
  const request = Readable.from([]) as unknown as IncomingMessage;
  const response = new FakeResponse();
  const operation = new AbortController();
  let userCancellationAuthoritative = true;
  let prepared!: () => void;
  const effectPrepared = new Promise<void>((resolve) => { prepared = resolve; });
  let release!: () => void;
  const terminalGate = new Promise<void>((resolve) => { release = resolve; });
  const running = streamResponse(
    request,
    response as unknown as ServerResponse,
    async () => {
      prepared();
      await terminalGate;
      return { type: "done", aside: { notes: [{ question: "Why?", answer: "Because." }] } };
    },
    (value) => value,
    operation.signal,
    undefined,
    undefined,
    undefined,
    {
      preserveDoneAfterOperationAbort: () => userCancellationAuthoritative
    }
  );

  await effectPrepared;
  operation.abort(new GenerationCancelledError());
  // Models the operation record's mutable authority after session close. The
  // AbortSignal retains the earlier Stop reason.
  userCancellationAuthoritative = false;
  release();
  await running;

  assert.doesNotMatch(response.output, /"type":"done"/u);
  assert.equal(response.ends, 1);
});

for (const [label, reason] of [
  ["a deadline", new Error("HTTP operation deadline exceeded")],
  ["session close", new Error("HTTP operation session closed")]
] as const) {
  test(`HTTP Aside suppresses a committed result after ${label}`, async () => {
    const response = await committedAsideAfterAbort(reason);
    assert.doesNotMatch(response.output, /"type":"done"/u);
    assert.equal(response.ends, 1);
  });
}

test("HTTP Aside suppresses a committed result after transport disconnect", async () => {
  const response = await committedAsideAfterAbort(null, true);
  assert.doesNotMatch(response.output, /"type":"done"/u);
  assert.equal(response.ends, 1);
});

async function committedAsideAfterAbort(
  reason: unknown,
  disconnect = false
): Promise<FakeResponse> {
  const request = Readable.from([]) as unknown as IncomingMessage;
  const response = new FakeResponse();
  const operation = new AbortController();
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const running = streamResponse(
    request,
    response as unknown as ServerResponse,
    async () => {
      started();
      await gate;
      return { type: "done", aside: { notes: [{ question: "Why?", answer: "Because." }] } };
    },
    (value) => value,
    operation.signal,
    undefined,
    undefined,
    undefined,
    {
      preserveDoneAfterOperationAbort: (abortReason) =>
        abortReason instanceof GenerationCancelledError
    }
  );

  await startedPromise;
  if (disconnect) {
    response.closed = true;
    response.emit("close");
  } else {
    operation.abort(reason);
  }
  release();
  await running;
  return response;
}

test("HTTP and worker request surfaces use the same Aside lifetimes and size gates", () => {
  assert.deepEqual(
    httpOperationPolicy("GET", "/api/stories/s1/aside"),
    { method: "getAside", lifetime: "transfer" }
  );
  assert.deepEqual(
    httpOperationPolicy("POST", "/api/stories/s1/aside/ask"),
    { method: "askAside", lifetime: "generation" }
  );
  assert.deepEqual(
    httpOperationPolicy("DELETE", "/api/stories/s1/aside"),
    { method: "clearAside", lifetime: "local" }
  );
  assert.doesNotThrow(() => validateWorkerRequestSize("getAside", { storyId: STORY_ID }));
  assert.doesNotThrow(() => validateWorkerRequestSize("clearAside", { storyId: STORY_ID }));
  assert.doesNotThrow(() => validateWorkerRequestSize("askAside", {
    storyId: STORY_ID,
    question: "Why?"
  }));
});

test("worker and service clearAside share resource_busy while provider is open", async (t) => {
  // Both transports call StoryMutationStore; the busy fence is one shared gate.
  const fixture = await setup(t, "1667-aside-busy-shared-", {}, undefined, { asideActivation: true });
  await ensureRootPart(fixture.stories);
  const version = (await fixture.stories.loadVersioned(STORY_ID)).aggregateVersion!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const startedP = new Promise<void>((resolve) => { started = resolve; });
  const document = {
    schemaVersion: 1 as const,
    notes: [{ question: "Q?", answer: "A." }]
  };
  const provider = fixture.mutations.runProviderOperation(
    requestFor(MUTATION_ID, FINGERPRINT, version),
    "askAside",
    providerOperation(
      async (stories, start) => {
        await start();
        started();
        await gate;
        await stories.commitProviderEffect(STORY_ID, {
          kind: "aside",
          expectedAsideDocumentId: undefined,
          document
        });
        return document;
      },
      () => document
    )
  );
  await startedP;
  for (const fingerprint of [OTHER_FINGERPRINT, "d".repeat(64)]) {
    await assert.rejects(
      fixture.mutations.runLocal(
        requestFor(
          fingerprint === OTHER_FINGERPRINT
            ? OTHER_MUTATION_ID
            : "m1.1767225600000.7123456789abcdef0123456789abcdef",
          fingerprint,
          version
        ),
        "clearAside",
        (story, session) => {
          if (session.snapshot.manifest.unresolvedProvider !== null) {
            throw new ServiceError(
              409,
              "A model request for this story is still unresolved.",
              "resource_busy"
            );
          }
          story.asideDocumentId = null;
        }
      ),
      hasCode("resource_busy")
    );
  }
  release();
  await provider;
});

test("worker Aside receipts keep a pointer and replay current clear/delete state", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-aside-receipt-pointer-"));
  t.after(async () => {
    await service.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });
  const service = StoryService.withoutDiagnostics({
    dataDir,
    asideActivation: true
  });
  await service.init();
  const story = await service.createStory("Aside receipt pointer");
  await service.createNode(story.id, {
    parentId: null,
    instruction: "",
    text: "A private lantern note."
  });
  const mutationId = createDurableMutationId();
  const canary = "receipt-private-canary-7f4b";
  const input = { storyId: story.id, question: canary };
  const expectedAggregateVersion =
    (await service.stories.loadVersioned(story.id)).aggregateVersion!;
  const operation = (sequence: bigint): WorkerOperationId => ({
    workerInstanceId: "2".repeat(32),
    sequence
  });
  const runRequest = async (sequence: bigint) => {
    const terminals: Extract<
      import("../shared/worker-protocol.js").WorkerToMainMessage,
      { type: "complete" | "result" }
    >[] = [];
    const errors: unknown[] = [];
    const request: Extract<MainToWorkerMessage, { type: "request" }> = {
      type: "request",
      id: operation(sequence),
      method: "askAside",
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
      (terminal) => terminals.push(terminal as typeof terminals[number])
    );
    return { terminals, errors };
  };

  const first = await runRequest(1n);
  assert.equal(first.errors.length, 0);
  assert.equal(first.terminals.length, 1);
  assert.equal(first.terminals[0]?.type, "complete");
  assert.ok(first.terminals[0]?.value);
  const committedView = first.terminals[0]?.value;
  const versionAfterCommit =
    (await service.stories.loadVersioned(story.id)).aggregateVersion;
  const replay = await runRequest(2n);
  assert.deepEqual(replay.errors, []);
  assert.deepEqual(replay.terminals[0]?.value, committedView);
  assert.deepEqual(
    (await service.stories.loadVersioned(story.id)).aggregateVersion,
    versionAfterCommit
  );

  const receiptPath = path.join(
    dataDir,
    MUTATION_RECEIPT_DIRECTORY,
    `${mutationId}.json`
  );
  const receiptText = (await readFile(receiptPath)).toString("utf8");
  const receipt = JSON.parse(receiptText) as {
    result?: { type?: string; id?: string; value?: unknown };
  };
  assert.deepEqual(receipt.result, { type: "aside", id: story.id });
  assert.equal(receiptText.includes(canary), false);
  assert.equal(receiptText.includes("A private lantern note."), false);

  await service.clearAside(story.id);
  const afterClear = await runRequest(3n);
  assert.deepEqual(afterClear.errors, []);
  assert.deepEqual(afterClear.terminals[0]?.value, { notes: [] });

  await service.deleteStory(story.id);
  const afterDelete = await runRequest(4n);
  assert.equal(afterDelete.terminals.length, 0);
  assert.equal(afterDelete.errors.length, 1);
  assert.match(String(afterDelete.errors[0]), /not found|deleted|story/i);
  assert.equal(String(afterDelete.errors[0]).includes(canary), false);
});

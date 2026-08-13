import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_DELTA_BATCH_BYTES,
  MAX_UNACKNOWLEDGED_DELTA_BATCHES,
  WORKER_PROTOCOL_VERSION,
  type MainToWorkerMessage,
  type WorkerOperationId
} from "../shared/worker-protocol.js";
import { createDurableMutationId } from "../shared/durable-mutation-id.js";
import {
  markRetryablePartialSettlementFailure,
  ProviderError,
  ServiceError
} from "../server/errors.js";
import { rewriteStreamDigest } from "../shared/rewrite-partial-contract.js";
import { StoryService } from "../server/story-service.js";
import { WorkerDeltaBatcher } from "../server/worker-delta-batcher.js";
import { executeWorkerRequest } from "../server/worker-request-executor.js";
import { WorkerRequestCancellation } from "../server/worker-request-cancellation.js";
import type { WorkerRequestFailureResponder } from "../server/worker-request-failure-responder.js";

const OPERATION_ID: WorkerOperationId = {
  workerInstanceId: "1".repeat(32),
  sequence: 1n
};

test("a worker deadline publishes one accepted oversized tail before its error terminal", async () => {
  const posted: string[] = [];
  const deltas = new WorkerDeltaBatcher(OPERATION_ID, (message) => {
    posted.push(message.text);
  });
  const fullBatch = "x".repeat(MAX_DELTA_BATCH_BYTES);
  for (let index = 0; index < MAX_UNACKNOWLEDGED_DELTA_BATCHES; index += 1) {
    await deltas.push(fullBatch);
  }
  const tail = "single-provider-delta ".padEnd(
    MAX_DELTA_BATCH_BYTES * (MAX_UNACKNOWLEDGED_DELTA_BATCHES + 3),
    "t"
  );
  const parked = deltas.push(tail);
  await new Promise((resolve) => setImmediate(resolve));

  const timeout = new ProviderError(
    "Model stream was idle beyond the configured deadline.",
    null,
    "",
    { timeout: "provider-idle" }
  );
  const service = {
    runMutation: async () => { throw timeout; }
  } as unknown as StoryService;
  const failures: Array<{
    error: unknown;
    outcome: "terminal" | "uncertain" | undefined;
  }> = [];
  const responder = {
    tracked: async (
      error: unknown,
      outcome: "terminal" | "uncertain" | undefined
    ) => {
      failures.push({ error, outcome });
    }
  } as unknown as WorkerRequestFailureResponder;
  const request: Extract<MainToWorkerMessage, { type: "request" }> = {
    type: "request",
    id: OPERATION_ID,
    method: "continueStory",
    input: {},
    protocolVersion: WORKER_PROTOCOL_VERSION,
    mutationId: "00000000-0000-7000-8000-000000000001",
    deadlineMs: Date.now() + 60_000
  };
  const cancellation = new WorkerRequestCancellation(true, request.mutationId);
  const execution = executeWorkerRequest(
    service,
    request,
    cancellation,
    deltas,
    responder,
    () => assert.fail("The failed request must not publish a success terminal")
  );
  await new Promise((resolve) => setImmediate(resolve));

  cancellation.cancel("deadline");
  deltas.sealUnsent();
  await execution;
  await parked;

  assert.equal(posted.join(""), fullBatch.repeat(MAX_UNACKNOWLEDGED_DELTA_BATCHES) + tail);
  assert.ok(posted.every((text) => Buffer.byteLength(text, "utf8") <= MAX_DELTA_BATCH_BYTES));
  assert.deepEqual(failures, [{
    error: timeout,
    outcome: "terminal"
  }]);
});

test("a user cancellation during a credit-blocked success flush publishes its tail before terminal", async () => {
  const posted: Array<{ text: string; sequence: number }> = [];
  const terminals: Array<{ type: string; state: string }> = [];
  const deltas = new WorkerDeltaBatcher(OPERATION_ID, (message) => {
    posted.push({ text: message.text, sequence: message.sequence });
  });
  const fullBatch = "x".repeat(MAX_DELTA_BATCH_BYTES);
  for (let index = 0; index < MAX_UNACKNOWLEDGED_DELTA_BATCHES; index += 1) {
    await deltas.push(fullBatch);
  }
  const tail = "accepted before cancellation";
  const parked = deltas.push(tail);
  await new Promise((resolve) => setImmediate(resolve));

  let releaseSuccess!: () => void;
  const success = new Promise<void>((resolve) => {
    releaseSuccess = resolve;
  });
  const cancellation = new WorkerRequestCancellation(
    true,
    "00000000-0000-7000-8000-000000000001"
  );
  const responder = {
    tracked: async () => assert.fail("The canceled request must not fail")
  } as unknown as WorkerRequestFailureResponder;
  const execution = executeWorkerRequest(
    { runMutation: async () => {
      await success;
      return { id: "story" };
    } } as unknown as StoryService,
    request(),
    cancellation,
    deltas,
    responder,
    (message, state) => terminals.push({ type: message.type, state })
  );

  releaseSuccess();
  // The successful mutation has now entered `deltas.flush()`, where the
  // parked tail waits behind the unacknowledged credit window.
  await new Promise((resolve) => setImmediate(resolve));
  cancellation.cancel("user");
  deltas.sealUnsent();
  await execution;
  await parked;

  assert.equal(
    posted.map((message) => message.text).join(""),
    fullBatch.repeat(MAX_UNACKNOWLEDGED_DELTA_BATCHES) + tail
  );
  assert.deepEqual(
    posted.map((message) => message.sequence),
    posted.map((_, index) => index)
  );
  assert.deepEqual(terminals, [{ type: "complete", state: "canceled" }]);
});

test("a committed Aside result wins a user cancellation during success flush", async () => {
  const posted: Array<{ text: string; sequence: number }> = [];
  const terminals: Array<{ type: string; value: unknown; state: string }> = [];
  const deltas = new WorkerDeltaBatcher(OPERATION_ID, (message) => {
    posted.push({ text: message.text, sequence: message.sequence });
  });
  const fullBatch = "x".repeat(MAX_DELTA_BATCH_BYTES);
  for (let index = 0; index < MAX_UNACKNOWLEDGED_DELTA_BATCHES; index += 1) {
    await deltas.push(fullBatch);
  }
  const tail = "accepted Aside output before cancellation";
  const parked = deltas.push(tail);
  await new Promise((resolve) => setImmediate(resolve));

  const committed = {
    notes: [{ question: "Why?", answer: "Because." }]
  };
  const cancellation = new WorkerRequestCancellation(
    true,
    "00000000-0000-7000-8000-000000000001"
  );
  const responder = {
    tracked: async () => assert.fail("A committed Aside result must not fail")
  } as unknown as WorkerRequestFailureResponder;
  const execution = executeWorkerRequest(
    { runMutation: async () => committed } as unknown as StoryService,
    { ...request(), method: "askAside" },
    cancellation,
    deltas,
    responder,
    (message, state) => terminals.push({
      type: message.type,
      value: message.value,
      state
    })
  );

  // The committed result has entered the credit-blocked success flush.
  await new Promise((resolve) => setImmediate(resolve));
  cancellation.cancel("user");
  deltas.sealUnsent();
  await execution;
  await parked;

  assert.equal(
    posted.map((message) => message.text).join(""),
    fullBatch.repeat(MAX_UNACKNOWLEDGED_DELTA_BATCHES) + tail
  );
  assert.deepEqual(terminals, [{
    type: "complete",
    value: committed,
    state: "completed"
  }]);
});

test("shutdown overrides an earlier user cancellation before a committed Aside settles", async () => {
  const posted: string[] = [];
  const terminals: Array<{ type: string; value: unknown; state: string }> = [];
  const deltas = new WorkerDeltaBatcher(OPERATION_ID, (message) => {
    posted.push(message.text);
  });
  const fullBatch = "x".repeat(MAX_DELTA_BATCH_BYTES);
  for (let index = 0; index < MAX_UNACKNOWLEDGED_DELTA_BATCHES; index += 1) {
    await deltas.push(fullBatch);
  }
  const parked = deltas.push("accepted Aside output before shutdown");
  await new Promise((resolve) => setImmediate(resolve));

  const committed = {
    notes: [{ question: "Why?", answer: "Because." }]
  };
  const cancellation = new WorkerRequestCancellation(
    true,
    "00000000-0000-7000-8000-000000000001"
  );
  const responder = {
    tracked: async () => assert.fail("Shutdown must not report a committed Aside as a failure")
  } as unknown as WorkerRequestFailureResponder;
  const execution = executeWorkerRequest(
    { runMutation: async () => committed } as unknown as StoryService,
    { ...request(), method: "askAside" },
    cancellation,
    deltas,
    responder,
    (message, state) => terminals.push({
      type: message.type,
      value: message.value,
      state
    })
  );

  // The committed result has entered the credit-blocked success flush.
  await new Promise((resolve) => setImmediate(resolve));
  cancellation.cancel("user");
  cancellation.cancel("shutdown");
  // Mirror worker shutdown: dispose the transport after cancellation.
  deltas.dispose();
  await execution;
  await parked;

  assert.equal(
    posted.join(""),
    fullBatch.repeat(MAX_UNACKNOWLEDGED_DELTA_BATCHES)
  );
  assert.deepEqual(terminals, [{
    type: "complete",
    value: null,
    state: "canceled"
  }]);
});

test("shutdown retains a mutation when the provider unwinds an earlier user Stop", async () => {
  const failures: Array<{ error: unknown; outcome: string | undefined }> = [];
  const responder = {
    tracked: async (error: unknown, outcome: string | undefined) => {
      failures.push({ error, outcome });
    }
  } as unknown as WorkerRequestFailureResponder;
  const cancellation = new WorkerRequestCancellation(
    true,
    "00000000-0000-7000-8000-000000000001"
  );
  let started!: () => void;
  const providerStarted = new Promise<void>((resolve) => { started = resolve; });
  const execution = executeWorkerRequest(
    { runMutation: async () => {
      started();
      await new Promise<void>((resolve) => {
        cancellation.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      // AbortController keeps the first reason, so this is the provider's
      // immutable GenerationCancelledError after shutdown supersedes Stop.
      throw cancellation.signal.reason;
    } } as unknown as StoryService,
    request(),
    cancellation,
    null,
    responder,
    () => assert.fail("An interrupted mutation must not publish success")
  );

  await providerStarted;
  cancellation.cancel("user");
  cancellation.cancel("shutdown");
  await execution;

  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.outcome, "uncertain");
  assert.equal((failures[0]!.error as ServiceError).code, "mutation_outcome_unknown");
});

test("a worker deadline still wins after a committed Aside result enters success flush", async () => {
  const posted: string[] = [];
  const terminals: Array<{ type: string; value: unknown }> = [];
  const deltas = new WorkerDeltaBatcher(OPERATION_ID, (message) => {
    posted.push(message.text);
  });
  const fullBatch = "x".repeat(MAX_DELTA_BATCH_BYTES);
  for (let index = 0; index < MAX_UNACKNOWLEDGED_DELTA_BATCHES; index += 1) {
    await deltas.push(fullBatch);
  }
  const tail = "accepted Aside output before deadline";
  const parked = deltas.push(tail);
  await new Promise((resolve) => setImmediate(resolve));

  const committed = {
    notes: [{ question: "Why?", answer: "Because." }]
  };
  const cancellation = new WorkerRequestCancellation(
    true,
    "00000000-0000-7000-8000-000000000001"
  );
  const failures: Array<{ error: unknown; outcome: string | undefined }> = [];
  const responder = {
    tracked: async (error: unknown, outcome: string | undefined) => {
      failures.push({ error, outcome });
    }
  } as unknown as WorkerRequestFailureResponder;
  const execution = executeWorkerRequest(
    { runMutation: async () => committed } as unknown as StoryService,
    { ...request(), method: "askAside" },
    cancellation,
    deltas,
    responder,
    (message) => terminals.push({ type: message.type, value: message.value })
  );

  // The committed result has entered the credit-blocked success flush.
  await new Promise((resolve) => setImmediate(resolve));
  cancellation.cancel("deadline");
  deltas.sealUnsent();
  await execution;
  await parked;

  assert.equal(
    posted.join(""),
    fullBatch.repeat(MAX_UNACKNOWLEDGED_DELTA_BATCHES) + tail
  );
  assert.deepEqual(terminals, []);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.outcome, "uncertain");
  assert.equal((failures[0]!.error as ServiceError).code, "mutation_outcome_unknown");
});

test("a normal provider rejection flushes accepted stream text before its terminal", async () => {
  const posted: string[] = [];
  const deltas = new WorkerDeltaBatcher(OPERATION_ID, (message) => {
    posted.push(message.text);
  });
  await deltas.push("accepted before rejection");
  const rejection = new ProviderError("The provider rejected the request.");
  const failures: Array<{ error: unknown; outcome: string | undefined }> = [];
  const responder = {
    tracked: async (error: unknown, outcome: string | undefined) => {
      failures.push({ error, outcome });
    }
  } as unknown as WorkerRequestFailureResponder;

  await executeWorkerRequest(
    { runMutation: async () => { throw rejection; } } as unknown as StoryService,
    request(),
    new WorkerRequestCancellation(true, "00000000-0000-7000-8000-000000000001"),
    deltas,
    responder,
    () => assert.fail("The failed request must not publish a success terminal")
  );

  assert.deepEqual(posted, ["accepted before rejection"]);
  assert.deepEqual(failures, [{ error: rejection, outcome: "terminal" }]);
});

test("an uncertain mutation drops unsealed buffered stream text", async () => {
  const posted: string[] = [];
  const deltas = new WorkerDeltaBatcher(OPERATION_ID, (message) => {
    posted.push(message.text);
  });
  await deltas.push("unsealed buffered text");
  const uncertain = new ServiceError(500, "Internal server error", "internal");
  const failures: Array<{ error: unknown; outcome: string | undefined }> = [];
  const responder = {
    tracked: async (error: unknown, outcome: string | undefined) => {
      failures.push({ error, outcome });
    }
  } as unknown as WorkerRequestFailureResponder;

  await executeWorkerRequest(
    { runMutation: async () => { throw uncertain; } } as unknown as StoryService,
    request(),
    new WorkerRequestCancellation(true, "00000000-0000-7000-8000-000000000001"),
    deltas,
    responder,
    () => assert.fail("The failed request must not publish a success terminal")
  );

  assert.deepEqual(posted, []);
  assert.deepEqual(failures, [{ error: uncertain, outcome: "uncertain" }]);
});

test("a persistent retryable partial settlement stops at deadline without busy spinning", async () => {
  const transient = new Error("Temporary partial settlement failure");
  markRetryablePartialSettlementFailure(transient);
  let attempts = 0;
  let firstAttempt!: () => void;
  const attempted = new Promise<void>((resolve) => { firstAttempt = resolve; });
  const failures: Array<{ error: unknown; outcome: string | undefined }> = [];
  const responder = {
    tracked: async (error: unknown, outcome: string | undefined) => {
      failures.push({ error, outcome });
    }
  } as unknown as WorkerRequestFailureResponder;

  const cancellation = new WorkerRequestCancellation(
    true,
    "00000000-0000-7000-8000-000000000001"
  );
  const execution = executeWorkerRequest(
    { runMutation: async () => {
      attempts += 1;
      if (attempts === 1) firstAttempt();
      throw transient;
    } } as unknown as StoryService,
    { ...request(), method: "commitPartialRewrite" },
    cancellation,
    null,
    responder,
    () => assert.fail("The persistent settlement must not publish success")
  );
  await attempted;
  await new Promise((resolve) => setTimeout(resolve, 60));
  cancellation.cancel("deadline");
  await execution;

  assert.ok(attempts >= 2, "the live operation retries after a bounded delay");
  assert.ok(attempts <= 4, "the retry loop must not busy spin");
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.outcome, "uncertain");
});

test("a live worker retries an exact partial settlement while its stash remains available", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-partial-retry-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    let story = await service.createStory("Worker partial settlement retry");
    const original = "The blue door opened into a long and quiet stone corridor.";
    story = await service.createNode(story.id, { parentId: null, text: original });
    const nodeId = story.nodes[0]!.id;
    const expected = "blue door opened into a long and quiet stone corridor";
    const controller = new AbortController();
    let streamed = "";
    const stopped = await service.rewriteNode(
      story.id,
      nodeId,
      {
        start: original.indexOf(expected),
        end: original.indexOf(expected) + expected.length,
        expected,
        instruction: "",
        destination: "take",
        attemptId: "worker-retry-attempt"
      },
      (text) => {
        streamed += text;
        controller.abort();
      },
      controller.signal,
      { rewriteId: "worker-retry-rewrite", takeId: "unused-worker-retry-take" }
    );
    assert.equal(stopped, null);
    assert.notEqual(streamed.trim(), "");

    let staged = 0;
    const hooks = (service as unknown as {
      storyMutations: { hooks: { afterStage?: () => void } };
    }).storyMutations.hooks;
    hooks.afterStage = () => {
      staged += 1;
      if (staged === 1) throw new Error("Temporary settlement stage failure");
    };
    const terminals: Array<{ type: string; value: unknown }> = [];
    const reported: Array<{ error: unknown; outcome: unknown }> = [];
    const failures = {
      tracked: async (error: unknown, outcome: unknown) => reported.push({ error, outcome })
    } as unknown as WorkerRequestFailureResponder;
    const mutationId = createDurableMutationId();
    const message: Extract<MainToWorkerMessage, { type: "request" }> = {
      type: "request",
      id: OPERATION_ID,
      method: "commitPartialRewrite",
      input: {
        storyId: story.id,
        nodeId,
        streamedDigest: rewriteStreamDigest(streamed),
        attemptId: "worker-retry-attempt"
      },
      protocolVersion: WORKER_PROTOCOL_VERSION,
      mutationId,
      expectedAggregateVersion: (await service.stories.loadVersioned(story.id)).aggregateVersion!,
      deadlineMs: Date.now() + 60_000
    };

    await executeWorkerRequest(
      service,
      message,
      new WorkerRequestCancellation(true, message.mutationId),
      null,
      failures,
      (terminal) => terminals.push({ type: terminal.type, value: terminal.value })
    );

    assert.deepEqual(reported, []);
    assert.equal(staged, 2);
    assert.deepEqual(terminals.map(({ type }) => type), ["result"]);
    assert.notEqual(
      (terminals[0]!.value as { nodeId: string }).nodeId,
      nodeId
    );
  } finally {
    await service.dispose();
  }
});

// Pins the closed-release refusal directly: `requireImageInputEntryPointsOpen`
// (server/image-stage-permit.ts) must run before either method call reaches
// `StoryService`, so a closed release never touches the service at all. This
// build's own release default is on, so the override below is explicit, the
// same way a rollback-safety test overrides it everywhere else in this
// suite — that keeps the coverage alive for the life of the constant instead
// of going permanently dead the moment activation ships.
test("stageStoryImage and releaseStoryImage both refuse before reaching the service while image input's entry points are closed", async () => {
  const service = {
    stageStoryImage: async () => { throw new Error("must not reach the service while entry points are closed"); },
    releaseStoryImage: async () => { throw new Error("must not reach the service while entry points are closed"); }
  } as unknown as StoryService;

  const cases: readonly [Extract<MainToWorkerMessage, { type: "request" }>["method"], Record<string, unknown>][] = [
    ["stageStoryImage", { storyId: "story-1", mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) }],
    ["releaseStoryImage", { storyId: "story-1", leaseId: "a".repeat(64) }]
  ];
  for (const [method, input] of cases) {
    const failures: unknown[] = [];
    const responder = {
      tracked: async (error: unknown) => { failures.push(error); }
    } as unknown as WorkerRequestFailureResponder;
    const message: Extract<MainToWorkerMessage, { type: "request" }> = {
      type: "request",
      id: OPERATION_ID,
      method,
      input,
      protocolVersion: WORKER_PROTOCOL_VERSION,
      deadlineMs: Date.now() + 60_000
    };

    await executeWorkerRequest(
      service,
      message,
      new WorkerRequestCancellation(false),
      null,
      responder,
      () => assert.fail(`${method} must not publish a success terminal while entry points are closed`),
      false
    );

    assert.equal(failures.length, 1, `${method} must report exactly one failure`);
    assert.equal((failures[0] as { code?: string }).code, "image_input_not_supported");
  }
});

function request(): Extract<MainToWorkerMessage, { type: "request" }> {
  return {
    type: "request",
    id: OPERATION_ID,
    method: "continueStory",
    input: {},
    protocolVersion: WORKER_PROTOCOL_VERSION,
    mutationId: "00000000-0000-7000-8000-000000000001",
    deadlineMs: Date.now() + 60_000
  };
}

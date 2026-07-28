import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  WORKER_BUILD_IDENTITY,
  WORKER_MAX_OPERATION_SEQUENCE,
  WORKER_PROTOCOL_VERSION,
  WORKER_SHUTDOWN_GRACE_MS,
  sameWorkerOperationId,
  type MainToWorkerMessage,
  type WorkerOperationId
} from "../../shared/worker-protocol.js";
import { createFailureEnvelope } from "../../shared/failure-envelope.js";
import { MutationOutbox } from "../../server/mutation-outbox.js";
import {
  BackendRestartRequiredError,
  createWorkerStoryApi
} from "../src/worker-api.js";
import { PendingRequestRegistry } from "../src/worker-pending.js";
import { WorkerTransport } from "../src/worker-transport.js";
import {
  FakeWorker,
  TEST_WORKER_INSTANCE_ID,
  waitForRequest
} from "./fixtures/fake-worker.js";

describe("embedded worker transport lifecycle", () => {
  test("binds monotonic request IDs to the worker incarnation and acknowledges terminals", async () => {
    const worker = new FakeWorker(true);
    const backend = await createWorkerStoryApi({ worker, readyTimeoutMs: 100 });
    try {
      const firstCall = backend.api.listStories();
      const first = await waitForRequest(worker, "listStoriesPage");
      expect(first.id).toEqual({
        workerInstanceId: TEST_WORKER_INSTANCE_ID,
        sequence: 1n
      });
      worker.message({
        type: "result",
        id: first.id,
        value: { items: [], cursor: null, catalogVersion: "1" }
      });
      expect(await firstCall).toEqual([]);
      expect(hasControlMessage(worker, "terminalAck", first.id)).toBeTrue();

      const secondCall = backend.api.listStories();
      const second = await waitForRequest(worker, "listStoriesPage");
      expect(second.id).toEqual({
        workerInstanceId: TEST_WORKER_INSTANCE_ID,
        sequence: 2n
      });
      worker.message({
        type: "result",
        id: second.id,
        value: { items: [], cursor: null, catalogVersion: "1" }
      });
      expect(await secondCall).toEqual([]);
    } finally {
      await backend.dispose();
    }
  });

  test("fails closed if a ready worker changes incarnation", async () => {
    const worker = new FakeWorker(true);
    const backend = await createWorkerStoryApi({ worker, readyTimeoutMs: 100 });
    worker.message({
      type: "ready",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      buildIdentity: WORKER_BUILD_IDENTITY,
      workerInstanceId: "2".repeat(32)
    });

    expect((await backend.failure).message).toContain("changed worker incarnation");
    expect(worker.terminateCalls).toBe(1);
    await expectRestartRequiredDisposal(backend);
  });

  test("treats operation_unknown as terminal for reads and a hard fence for mutations", async () => {
    const readWorker = new FakeWorker(true);
    const readBackend = await createWorkerStoryApi({ worker: readWorker, readyTimeoutMs: 100 });
    const reading = readBackend.api.listStories();
    const readRequest = await waitForRequest(readWorker, "listStoriesPage");
    readWorker.message({
      type: "operation",
      id: readRequest.id,
      state: "unknown",
      terminal: true
    });
    expect(await rejection(reading)).toMatchObject({
      code: "operation_unknown",
      status: 410
    });
    expect(readWorker.terminateCalls).toBe(0);
    await readBackend.dispose();

    const mutationWorker = new FakeWorker();
    const mutationBackend = await createWorkerStoryApi({
      worker: mutationWorker,
      readyTimeoutMs: 100
    });
    const mutating = mutationBackend.api.createStory("missing lifecycle");
    const mutationRequest = await waitForRequest(mutationWorker, "createStory");
    mutationWorker.message({
      type: "operation",
      id: mutationRequest.id,
      state: "unknown",
      terminal: true
    });
    expect((await rejection(mutating)).message).toContain("no longer retains");
    expect((await mutationBackend.failure).message).toContain("no longer retains");
    expect(mutationWorker.terminateCalls).toBe(1);
    await expectRestartRequiredDisposal(mutationBackend);
  });

  test("cancels a live mutation before enforcing its hard deadline fence", async () => {
    const worker = new FakeWorker();
    const backend = await createWorkerStoryApi({
      worker,
      readyTimeoutMs: 100,
      mutationDeadlineMs: 5,
      cancelGraceMs: 50
    });
    let settled = false;
    const mutation = backend.api.createStory("deadline");
    void mutation.finally(() => { settled = true; }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const request = await waitForRequest(worker, "createStory");
    expect(hasControlMessage(worker, "cancel", request.id)).toBeTrue();
    expect(worker.messages.find((message) =>
      message.type === "cancel" && sameWorkerOperationId(message.id, request.id)
    )).toMatchObject({ reason: "deadline" });
    expect(settled).toBeFalse();

    expect((await rejection(mutation)).message).toContain("recovery deadline");
    expect((await backend.failure).message).toContain("recovery deadline");
    expect(worker.terminateCalls).toBe(1);
    await expectRestartRequiredDisposal(backend);
  });

  test("cancels retained startup recovery before enforcing its hard fence", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-replay-deadline-"));
    const outbox = new MutationOutbox(path.join(dataDir, "mutation-outbox"));
    await outbox.init();
    await outbox.enqueue(
      `m1-${Date.now().toString(36)}-${"e".padStart(32, "0")}`,
      "createStory",
      { title: "retained deadline" }
    );
    const worker = new FakeWorker();
    const backend = await createWorkerStoryApi({
      worker,
      outbox,
      readyTimeoutMs: 100,
      mutationDeadlineMs: 5,
      cancelGraceMs: 20
    });
    try {
      const request = await waitForRequest(worker, "createStory");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(hasControlMessage(worker, "cancel", request.id)).toBeTrue();
      expect(worker.messages.find((message) =>
        message.type === "cancel" && sameWorkerOperationId(message.id, request.id)
      )).toMatchObject({ reason: "deadline" });

      const error = await rejection(backend.recovery);
      expect(error).toMatchObject({ code: "backend_restart_required" });
      expect(error.message).toContain("cancellation grace");
      expect(worker.terminateCalls).toBe(1);
      await expectRestartRequiredDisposal(backend);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("claims a terminal before durable cleanup and acknowledges only after cleanup", async () => {
    const worker = new FakeWorker(true);
    const outbox = new HangingOutbox();
    const backend = await createWorkerStoryApi({
      worker,
      outbox,
      readyTimeoutMs: 100,
      mutationDeadlineMs: 50
    });
    try {
      const pending = backend.api.createStory("cleanup after terminal reply");
      const request = await waitForRequest(worker, "createStory");
      worker.message({ type: "result", id: request.id, value: { id: "story" } });
      worker.message({
        type: "operation",
        id: request.id,
        state: "completed",
        terminal: true
      });
      worker.message({ type: "result", id: request.id, value: { id: "story" } });
      await outbox.removeStarted;
      const disposal = backend.dispose();

      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(worker.terminateCalls).toBe(1);
      expect(outbox.cancelCalls).toBe(0);
      expect(hasControlMessage(worker, "cancel", request.id)).toBeFalse();
      expect(hasControlMessage(worker, "terminalAck", request.id)).toBeFalse();
      outbox.finishRemove();
      expect(await pending).toEqual({ id: "story" });
      await disposal;
      expect(hasControlMessage(worker, "terminalAck", request.id)).toBeTrue();
    } finally {
      outbox.finishRemove();
      await backend.dispose();
    }
  });

  test("terminal reconciliation failure owns concurrent disposal", async () => {
    const worker = new FakeWorker(true);
    const outbox = new FailingTerminalOutbox();
    const backend = await createWorkerStoryApi({ worker, outbox, readyTimeoutMs: 100 });
    const mutationError = rejection(backend.api.createStory("failed terminal cleanup"));
    const request = await waitForRequest(worker, "createStory");
    worker.message({ type: "result", id: request.id, value: { id: "story" } });
    await outbox.removeStarted;
    const disposalError = rejection(backend.dispose());

    outbox.failRemove();
    const failure = await backend.failure;
    expect(failure).toMatchObject({ code: "backend_restart_required" });
    expect(failure.message).toContain("terminal outbox removal failed");
    expect(await mutationError).toBe(failure);
    expect(await disposalError).toBe(failure);
    expect(worker.terminateCalls).toBe(1);
  });

  test("requires exact stopped and fixes the shutdown grace at five seconds", async () => {
    expect(WORKER_SHUTDOWN_GRACE_MS).toBe(5_000);
    for (const [createWorker, diagnosticRef] of [
      [() => new ProtocolErrorOnShutdownWorker(), "err_deadbeefdeadbeefdeadbeef"],
      [() => new InvalidStoppedOnShutdownWorker(), null]
    ] as const) {
      const worker = createWorker();
      const backend = await createWorkerStoryApi({
        worker,
        readyTimeoutMs: 100,
        shutdownGraceMs: 5
      });

      const error = await rejection(backend.dispose());
      expect(error).toMatchObject({
        code: "backend_restart_required",
        diagnosticRef
      });

      expect(worker.terminateCalls).toBe(1);
      expect(worker.messages.at(-1)).toEqual({ type: "shutdown" });
    }
  });

  test("requires process restart when startup cleanup cannot confirm worker exit", async () => {
    const worker = new StartupNeverClosingWorker();
    const error = await rejection(createWorkerStoryApi({
      worker,
      outbox: new FailingStartupOutbox(),
      readyTimeoutMs: 100,
      terminationConfirmMs: 5
    }));

    expect(error instanceof BackendRestartRequiredError).toBeTrue();
    expect(error).toMatchObject({ code: "backend_restart_required" });
    expect(error.message).toContain("exit could not be confirmed");
    expect(worker.terminateCalls).toBe(1);
  });

  test("requires restart for a post-ready startup failure with confirmed exit", async () => {
    const worker = new FakeWorker();
    const error = await rejection(createWorkerStoryApi({
      worker,
      outbox: new FailingStartupOutbox(),
      readyTimeoutMs: 100
    }));

    expect(error).toMatchObject({ code: "backend_restart_required" });
    expect(error.message).toContain("startup failed after readiness");
    expect(worker.terminateCalls).toBe(1);
  });

  test("pre-ready worker error and exit remain ordinary startup failures", async () => {
    for (const [event, message] of [
      ["error", "worker import failed"],
      ["close", "exited unexpectedly"]
    ] as const) {
      const worker = new PreReadyFailingWorker(event);
      const error = await rejection(createWorkerStoryApi({
        worker,
        readyTimeoutMs: 100
      }));

      expect(error instanceof BackendRestartRequiredError).toBeFalse();
      expect(error.code).not.toBe("backend_restart_required");
      expect(error.message).toContain(message);
    }
  });

  test("hard-fences operation sequence exhaustion and retains its mutation", async () => {
    const worker = new FakeWorker();
    const outbox = new RetainingOutbox();
    const transport = new WorkerTransport(
      { worker, readyTimeoutMs: 100 },
      outbox,
      new PendingRequestRegistry(WORKER_MAX_OPERATION_SEQUENCE)
    );
    await transport.start();

    const error = await rejection(transport.call(
      "createStory",
      { title: "exhausted sequence" },
      { expectedAggregateVersion: { kind: "absent" } }
    ));

    expect(error).toMatchObject({ code: "backend_restart_required" });
    expect(error.message).toContain("could not allocate");
    expect(outbox.enqueues).toBe(1);
    expect(outbox.removals).toBe(0);
    expect(worker.messages.some((message) => message.type === "request")).toBeFalse();
    expect(worker.terminateCalls).toBe(1);
    await expectRestartRequiredDisposal(transport);
  });

  test("the first cancellation grace cannot be extended by a later cancellation", async () => {
    const pending = new PendingRequestRegistry();
    pending.bindWorkerInstance("a".repeat(32));
    const registered = pending.open({
      method: "listStories",
      replay: false,
      stream: false,
      durableIntent: false,
      timeoutMs: 10_000,
      onTimeout: () => {}
    });
    const completion = rejection(registered.promise);
    const call = pending.get(registered.id);
    if (call === undefined) throw new Error("pending call was not registered");
    const fired: string[] = [];

    call.startCancellationGrace(10, () => fired.push("first"));
    call.startCancellationGrace(1, () => fired.push("second"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fired).toEqual(["first"]);
    pending.reject(registered.id, new Error("test complete"));
    await completion;
  });
});

class HangingOutbox extends MutationOutbox {
  cancelCalls = 0;
  private markRemoveStarted!: () => void;
  readonly removeStarted = new Promise<void>((resolve) => { this.markRemoveStarted = resolve; });
  private finish!: () => void;
  private readonly removal = new Promise<void>((resolve) => { this.finish = resolve; });

  constructor() { super("unused-test-outbox"); }
  override async init(): Promise<void> {}
  override async enqueue(): Promise<void> {}
  override async cancel(): Promise<void> { this.cancelCalls += 1; }
  override async remove(): Promise<void> {
    this.markRemoveStarted();
    await this.removal;
  }
  override async list(): Promise<[]> { return []; }
  finishRemove(): void { this.finish(); }
}

class FailingTerminalOutbox extends MutationOutbox {
  private markRemoveStarted!: () => void;
  readonly removeStarted = new Promise<void>((resolve) => { this.markRemoveStarted = resolve; });
  private rejectRemove!: (error: Error) => void;
  private readonly removal = new Promise<void>((_, reject) => { this.rejectRemove = reject; });

  constructor() { super("unused-failing-terminal-outbox"); }
  override async enqueue(): Promise<void> {}
  override async cancel(): Promise<void> {}
  override async remove(): Promise<void> {
    this.markRemoveStarted();
    await this.removal;
  }
  override async list(): Promise<[]> { return []; }
  override async listArchived(): Promise<[]> { return []; }
  failRemove(): void { this.rejectRemove(new Error("terminal outbox removal failed")); }
}

class FailingStartupOutbox extends MutationOutbox {
  constructor() { super("unused-failing-startup-outbox"); }
  override async list(): Promise<[]> { throw new Error("startup outbox read failed"); }
  override async listArchived(): Promise<[]> { return []; }
}

class RetainingOutbox extends MutationOutbox {
  enqueues = 0;
  removals = 0;

  constructor() { super("unused-retaining-outbox"); }
  override async enqueue(): Promise<void> { this.enqueues += 1; }
  override async remove(): Promise<void> { this.removals += 1; }
  override async list(): Promise<[]> { return []; }
  override async listArchived(): Promise<[]> { return []; }
}

class StartupNeverClosingWorker extends FakeWorker {
  override terminate(): void {
    this.terminateCalls += 1;
  }
}

class PreReadyFailingWorker extends EventTarget {
  terminateCalls = 0;

  constructor(event: "error" | "close") {
    super();
    queueMicrotask(() => {
      if (event === "error") {
        this.dispatchEvent(new ErrorEvent("error", { message: "worker import failed" }));
      } else {
        this.dispatchEvent(new Event("close"));
      }
    });
  }

  postMessage(): void {}
  terminate(): void {
    this.terminateCalls += 1;
    this.dispatchEvent(new Event("close"));
  }
}

class ProtocolErrorOnShutdownWorker extends FakeWorker {
  override postMessage(message: MainToWorkerMessage): void {
    super.postMessage(message);
    if (message.type === "shutdown") {
      this.message({
        type: "protocolError",
        failure: createFailureEnvelope({
          code: "internal",
          message: "Internal server error",
          status: 500
        }, "err_deadbeefdeadbeefdeadbeef")
      });
    }
  }
}

class InvalidStoppedOnShutdownWorker extends FakeWorker {
  override postMessage(message: MainToWorkerMessage): void {
    super.postMessage(message);
    if (message.type === "shutdown") {
      this.dispatchEvent(new MessageEvent("message", {
        data: { type: "stopped", unexpected: true }
      }));
    }
  }
}

function hasControlMessage(
  worker: FakeWorker,
  type: "cancel" | "terminalAck",
  id: WorkerOperationId
): boolean {
  return worker.messages.some((message) =>
    message.type === type && sameWorkerOperationId(message.id, id)
  );
}

async function rejection(promise: Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    return error as Error & Record<string, unknown>;
  }
  throw new Error("Expected promise to reject");
}

async function expectRestartRequiredDisposal(
  backend: { dispose(): Promise<void> }
): Promise<void> {
  const error = await rejection(backend.dispose());
  expect(error instanceof BackendRestartRequiredError).toBeTrue();
  expect(error).toMatchObject({ code: "backend_restart_required" });
}

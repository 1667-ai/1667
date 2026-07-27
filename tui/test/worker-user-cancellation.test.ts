import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  sameWorkerOperationId,
  type MainToWorkerMessage,
  type WorkerOperationId
} from "../../shared/worker-protocol.js";
import { MutationOutbox } from "../../server/mutation-outbox.js";
import { BackendRestartRequiredError } from "../src/worker-api.js";
import { WorkerTransport } from "../src/worker-transport.js";
import { FakeWorker, waitForRequest } from "./fixtures/fake-worker.js";

// The publication deadline is armed the moment publication starts, so any test
// work that has to happen before cancellation is racing it. Tests on the
// in-memory outboxes below can hold that window near zero because their enqueue
// is a no-op, and they pick single-digit grace values accordingly.
// CommittedHangingPublicationOutbox cannot: it writes the record to a temp
// directory for real, because the assertions that follow read that directory
// back through a second transport. A loaded CI runner has taken over 50ms to
// land that write, firing the deadline before the test reached cancel.abort()
// and rejecting a mutation the test expects to resolve. This grace has to
// outrun a contended filesystem, not merely a fast one.
const FILE_BACKED_GRACE_MS = 2_000;

test("caller cancellation hard-fences a mutation that never reaches terminal state", async () => {
  const worker = new FakeWorker();
  const outbox = new RecordingCancellationOutbox();
  const transport = await startTransport(worker, outbox, 20);
  const cancel = new AbortController();
  const mutationError = rejection(transport.call(
    "createStory",
    { title: "hung cancellation" },
    { signal: cancel.signal, expectedAggregateVersion: { kind: "absent" } }
  ));
  const request = await waitForRequest(worker, "createStory");

  cancel.abort();
  await outbox.cancelled;
  expect(await waitForControlMessage(worker, "cancel", request.id)).toMatchObject({
    reason: "user"
  });
  expect(await mutationError).toMatchObject({ code: "backend_restart_required" });
  expect((await transport.failure).message).toContain(
    "cancellation did not reach terminal state"
  );
  expect(worker.terminateCalls).toBe(1);
  await expectRestartRequiredDisposal(transport);
});

test("stalled durable cancellation hard-fences disposal", async () => {
  const worker = new FakeWorker();
  const outbox = new HangingCancellationOutbox();
  const transport = await startTransport(worker, outbox, 20);
  const cancel = new AbortController();
  const mutationError = rejection(transport.call(
    "createStory",
    { title: "stalled cancellation" },
    { signal: cancel.signal, expectedAggregateVersion: { kind: "absent" } }
  ));
  await waitForRequest(worker, "createStory");

  cancel.abort();
  await outbox.cancelStarted;
  const disposalError = rejection(transport.dispose());
  const failure = await transport.failure;
  expect(failure).toMatchObject({ code: "backend_restart_required" });
  expect(failure.message).toContain("cancellation was not durably recorded");
  expect(worker.messages.some((message) => message.type === "cancel")).toBeFalse();
  expect(worker.terminateCalls).toBe(1);
  expect(await disposalError).toBe(failure);

  outbox.finishCancel();
  expect(await mutationError).toBe(failure);
});

test("terminal ownership does not clear a stalled durable-cancellation fence", async () => {
  const worker = new FakeWorker();
  const outbox = new HangingCancellationOutbox();
  const transport = await startTransport(worker, outbox, 5);
  const cancel = new AbortController();
  const mutationError = rejection(transport.call(
    "createStory",
    { title: "terminal behind stalled cancellation" },
    { signal: cancel.signal, expectedAggregateVersion: { kind: "absent" } }
  ));
  const request = await waitForRequest(worker, "createStory");

  cancel.abort();
  await outbox.cancelStarted;
  worker.message({ type: "result", id: request.id, value: { id: "story" } });

  const failure = await transport.failure;
  expect(failure).toMatchObject({ code: "backend_restart_required" });
  expect(failure.message).toContain("cancellation was not durably recorded");
  expect(worker.terminateCalls).toBe(1);
  outbox.finishCancel();
  expect(await mutationError).toBe(failure);
  await expectRestartRequiredDisposal(transport);
});

test("terminal ownership prevents cancellation delivery and a false fence", async () => {
  const worker = new FakeWorker(true);
  const outbox = new TerminalRaceOutbox();
  const transport = await startTransport(worker, outbox, 50);
  const cancel = new AbortController();
  const mutationOutcome = transport.call(
    "createStory",
    { title: "terminal cancellation race" },
    { signal: cancel.signal, expectedAggregateVersion: { kind: "absent" } }
  ).then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
  const request = await waitForRequest(worker, "createStory");

  cancel.abort();
  await outbox.cancelStarted;
  worker.message({ type: "result", id: request.id, value: { id: "story" } });
  outbox.finishCancel();
  await outbox.removeStarted;
  await new Promise((resolve) => setTimeout(resolve, 75));

  expect(worker.messages.some((message) => message.type === "cancel")).toBeFalse();
  expect(worker.terminateCalls).toBe(0);
  outbox.finishRemove();
  expect(await mutationOutcome).toEqual({ value: { id: "story" } });
  expect(hasControlMessage(worker, "terminalAck", request.id)).toBeTrue();
  await transport.dispose();
});

test("failed user-cancellation delivery hard-fences", async () => {
  const worker = new UserCancelThrowingWorker();
  const outbox = new RecordingCancellationOutbox();
  const transport = await startTransport(worker, outbox, 20);
  const cancel = new AbortController();
  const mutationError = rejection(transport.call(
    "createStory",
    { title: "failed cancellation delivery" },
    { signal: cancel.signal, expectedAggregateVersion: { kind: "absent" } }
  ));
  await waitForRequest(worker, "createStory");

  cancel.abort();
  await outbox.cancelled;
  const failure = await transport.failure;
  expect(failure).toMatchObject({ code: "backend_restart_required" });
  expect(failure.message).toContain("cancellation could not be sent");
  expect(worker.terminateCalls).toBe(1);
  expect(await mutationError).toBe(failure);
  await expectRestartRequiredDisposal(transport);
});

test("abort during intent publication durably cancels before delivery", async () => {
  const worker = new FakeWorker(true);
  const outbox = new DeferredPublicationOutbox();
  const transport = await startTransport(worker, outbox, 50);
  const cancel = new AbortController();
  const mutation = transport.call(
    "createStory",
    { title: "cancel during publication" },
    { signal: cancel.signal, expectedAggregateVersion: { kind: "absent" } }
  );

  await outbox.publicationStarted;
  cancel.abort();
  outbox.finishPublication();
  await outbox.cancelled;

  expect(await mutation).toBe(null);
  expect(worker.messages.some((message) => message.type === "request")).toBeFalse();
  expect(worker.terminateCalls).toBe(0);
  await transport.dispose();
});

test("stalled intent publication cannot defeat caller cancellation", async () => {
  const worker = new FakeWorker();
  const outbox = new DeferredPublicationOutbox();
  const transport = await startTransport(worker, outbox, 5);
  const cancel = new AbortController();
  const mutation = transport.call(
    "createStory",
    { title: "stalled publication" },
    { signal: cancel.signal, expectedAggregateVersion: { kind: "absent" } }
  );

  await outbox.publicationStarted;
  cancel.abort();
  await outbox.cancelled;
  expect(await mutation).toBe(null);
  const failure = await transport.failure;
  expect(failure).toMatchObject({ code: "backend_restart_required" });
  expect(failure.message).toContain("publication did not settle");
  expect(worker.terminateCalls).toBe(1);

  outbox.finishPublication();
  await expectRestartRequiredDisposal(transport);
});

test("signal-less stalled intent publication hard-fences disposal", async () => {
  const worker = new FakeWorker();
  const outbox = new DeferredPublicationOutbox();
  const transport = await startTransport(worker, outbox, 5);
  const mutationError = rejection(transport.call(
    "createStory",
    { title: "stalled publication without abort" },
    { expectedAggregateVersion: { kind: "absent" } }
  ));

  await outbox.publicationStarted;
  const disposalError = rejection(transport.dispose());
  const failure = await transport.failure;
  expect(failure).toMatchObject({ code: "backend_restart_required" });
  expect(failure.message).toContain("publication did not settle");
  expect(await mutationError).toBe(failure);
  expect(await disposalError).toBe(failure);
  expect(worker.terminateCalls).toBe(1);
  outbox.finishPublication();
});

test("a durable cancellation marker prevents replay after publication stalls", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-worker-publication-fence-"));
  try {
    const outbox = new CommittedHangingPublicationOutbox(dir);
    await outbox.init();
    const worker = new FakeWorker();
    const transport = await startTransport(worker, outbox, FILE_BACKED_GRACE_MS);
    const cancel = new AbortController();
    const mutation = transport.call(
      "createStory",
      { title: "never replay after cancellation" },
      { signal: cancel.signal, expectedAggregateVersion: { kind: "absent" } }
    );

    await outbox.committed;
    cancel.abort();
    expect(await mutation).toBe(null);
    const [mutationId] = await outbox.listCancellationMarkers();
    expect(typeof mutationId).toBe("string");
    const failure = await transport.failure;
    expect(failure).toMatchObject({ code: "backend_restart_required" });

    const replacementWorker = new FakeWorker(true);
    const replacement = await startTransport(
      replacementWorker,
      new MutationOutbox(dir),
      50
    );
    expect(replacementWorker.messages.some((message) => message.type === "request")).toBeFalse();
    expect(await new MutationOutbox(dir).list()).toEqual([]);
    expect(await new MutationOutbox(dir).listCancellationMarkers()).toEqual([]);
    await replacement.dispose();

    outbox.finishPublication();
    await expectRestartRequiredDisposal(transport);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("live cancellation bypasses another mutation's stalled publication", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-worker-cancel-queue-"));
  try {
    const outbox = new CommittedHangingPublicationOutbox(dir, 2);
    await outbox.init();
    const worker = new FakeWorker();
    const transport = await startTransport(worker, outbox, FILE_BACKED_GRACE_MS);
    const cancel = new AbortController();
    const firstError = rejection(transport.call(
      "createStory",
      { title: "cancel while another publication stalls" },
      { signal: cancel.signal, expectedAggregateVersion: { kind: "absent" } }
    ));
    const firstRequest = await waitForRequest(worker, "createStory");
    const firstMutationId = firstRequest.mutationId;
    if (firstMutationId === undefined) throw new Error("createStory request omitted its mutation ID");
    const secondError = rejection(transport.call(
      "createStory",
      { title: "stalled second publication" },
      { expectedAggregateVersion: { kind: "absent" } }
    ));

    await outbox.committed;
    cancel.abort();
    await waitForControlMessage(worker, "cancel", firstRequest.id);
    expect(await outbox.listCancellationMarkers()).toContain(firstMutationId);
    const secondMutationId = (await outbox.list())
      .find((record) => record.mutationId !== firstMutationId)?.mutationId;
    expect(typeof secondMutationId).toBe("string");

    const failure = await transport.failure;
    expect(failure.message).toContain("publication did not settle");
    expect(await firstError).toBe(failure);
    expect(await secondError).toBe(failure);

    const replacementWorker = new FakeWorker(true);
    const replacement = await startTransport(
      replacementWorker,
      new MutationOutbox(dir),
      200
    );
    const replay = await waitForRequest(replacementWorker, "createStory");
    expect(replay.mutationId).toBe(secondMutationId);
    expect(replacementWorker.messages.some((message) =>
      message.type === "request" && message.mutationId === firstMutationId
    )).toBeFalse();
    await replacement.dispose();

    outbox.finishPublication();
    await expectRestartRequiredDisposal(transport);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function startTransport(
  worker: FakeWorker,
  outbox: MutationOutbox,
  cancelGraceMs: number
): Promise<WorkerTransport> {
  const transport = new WorkerTransport({
    worker,
    readyTimeoutMs: 100,
    cancelGraceMs
  }, outbox);
  await transport.start();
  return transport;
}

class RecordingCancellationOutbox extends MutationOutbox {
  private markCancelled!: () => void;
  readonly cancelled = new Promise<void>((resolve) => { this.markCancelled = resolve; });

  constructor() { super("unused-recording-cancellation-outbox"); }
  override async enqueue(): Promise<void> {}
  override async cancel(): Promise<void> { this.markCancelled(); }
  override async remove(): Promise<void> {}
  override async list(): Promise<[]> { return []; }
  override async listArchived(): Promise<[]> { return []; }
}

class HangingCancellationOutbox extends RecordingCancellationOutbox {
  private markCancelStarted!: () => void;
  readonly cancelStarted = new Promise<void>((resolve) => { this.markCancelStarted = resolve; });
  private finishCancellation!: () => void;
  private readonly cancellation = new Promise<void>((resolve) => {
    this.finishCancellation = resolve;
  });

  override async cancel(): Promise<void> {
    this.markCancelStarted();
    await this.cancellation;
  }

  finishCancel(): void { this.finishCancellation(); }
}

class DeferredPublicationOutbox extends RecordingCancellationOutbox {
  private markPublicationStarted!: () => void;
  readonly publicationStarted = new Promise<void>((resolve) => {
    this.markPublicationStarted = resolve;
  });
  private finish!: () => void;
  private readonly publication = new Promise<void>((resolve) => { this.finish = resolve; });

  override async enqueue(): Promise<void> {
    this.markPublicationStarted();
    await this.publication;
  }

  finishPublication(): void { this.finish(); }
}

class CommittedHangingPublicationOutbox extends MutationOutbox {
  private markCommitted!: () => void;
  readonly committed = new Promise<void>((resolve) => { this.markCommitted = resolve; });
  private finish!: () => void;
  private readonly publication = new Promise<void>((resolve) => { this.finish = resolve; });
  private enqueues = 0;

  constructor(dir: string, private readonly hangOnEnqueue = 1) {
    super(dir);
  }

  override async enqueue(...args: Parameters<MutationOutbox["enqueue"]>): Promise<void> {
    await super.enqueue(...args);
    this.enqueues += 1;
    if (this.enqueues !== this.hangOnEnqueue) return;
    this.markCommitted();
    await this.publication;
  }

  finishPublication(): void { this.finish(); }
}

class TerminalRaceOutbox extends HangingCancellationOutbox {
  private markRemoveStarted!: () => void;
  readonly removeStarted = new Promise<void>((resolve) => { this.markRemoveStarted = resolve; });
  private finishRemoval!: () => void;
  private readonly removal = new Promise<void>((resolve) => { this.finishRemoval = resolve; });

  override async remove(): Promise<void> {
    this.markRemoveStarted();
    await this.removal;
  }

  finishRemove(): void { this.finishRemoval(); }
}

class UserCancelThrowingWorker extends FakeWorker {
  override postMessage(message: MainToWorkerMessage): void {
    if (message.type === "cancel") throw new Error("cancel channel closed");
    super.postMessage(message);
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

async function waitForControlMessage(
  worker: FakeWorker,
  type: "cancel" | "terminalAck",
  id: WorkerOperationId
): Promise<MainToWorkerMessage> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const message = worker.messages.find((candidate) =>
      candidate.type === type && sameWorkerOperationId(candidate.id, id)
    );
    if (message !== undefined) return message;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`${type} control message was not sent`);
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

import { expect, test } from "bun:test";
import {
  MutationOutbox
} from "../../server/mutation-outbox.js";
import {
  WorkerTransport
} from "../src/worker-transport.js";
import {
  FakeWorker
} from "./fixtures/fake-worker.js";

test("embedded archive cleanup retries until the process-owned task succeeds", async () => {
  const worker = new FakeWorker(true);
  const outbox = new RetryingArchiveOutbox();
  const transport = new WorkerTransport(
    {
      worker,
      readyTimeoutMs: 100
    },
    outbox
  );
  await transport.start();
  try {
    await transport.dismissArchivedMutation(
      "m1.1767225600000.7123456789abcdef0123456789abcdef"
    );
    await outbox.retired;
    expect(outbox.dismissAttempts).toBe(2);
  } finally {
    await transport.dispose();
  }
});

test("normal disposal drains an archive cleanup attempt", async () => {
  const worker = new FakeWorker(true);
  const outbox = new BlockingArchiveOutbox();
  const transport = new WorkerTransport(
    {
      worker,
      readyTimeoutMs: 100
    },
    outbox
  );
  await transport.start();
  await transport.dismissArchivedMutation(
    "m1.1767225600000.8123456789abcdef0123456789abcdef"
  );
  await outbox.secondAttemptStarted;
  let disposed = false;
  const disposal = transport.dispose().then(() => {
    disposed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(disposed).toBeFalse();
  outbox.releaseSecondAttempt();
  await disposal;
  expect(disposed).toBeTrue();
  const attemptsAfterDispose = outbox.dismissAttempts;
  await new Promise((resolve) => setTimeout(resolve, 75));
  expect(outbox.dismissAttempts).toBe(attemptsAfterDispose);
});

test("restart-required shutdown stops archive cleanup retry", async () => {
  const worker = new FakeWorker(true);
  const outbox = new FailingArchiveOutbox();
  const transport = new WorkerTransport(
    {
      worker,
      readyTimeoutMs: 100
    },
    outbox
  );
  await transport.start();
  await transport.dismissArchivedMutation(
    "m1.1767225600000.9123456789abcdef0123456789abcdef"
  );
  worker.crash("Injected worker failure");
  await transport.failure;
  const attemptsAfterFailure = outbox.dismissAttempts;
  await new Promise((resolve) => setTimeout(resolve, 75));
  expect(outbox.dismissAttempts).toBe(attemptsAfterFailure);
  let disposalError: unknown;
  try {
    await transport.dispose();
  } catch (error) {
    disposalError = error;
  }
  expect(disposalError instanceof Error).toBeTrue();
});

class RetryingArchiveOutbox extends MutationOutbox {
  dismissAttempts = 0;
  private retire!: () => void;
  readonly retired = new Promise<void>((resolve) => {
    this.retire = resolve;
  });

  constructor() {
    super("unused-archive-retry-outbox");
  }

  override async init(): Promise<void> {}
  override async list(): Promise<[]> { return []; }
  override async listArchived(): Promise<[]> { return []; }

  override async dismissArchived(): Promise<void> {
    this.dismissAttempts += 1;
    if (this.dismissAttempts === 1) {
      throw new Error("Injected archive cleanup failure");
    }
    this.retire();
  }
}

class FailingArchiveOutbox extends MutationOutbox {
  dismissAttempts = 0;

  constructor() {
    super("unused-failing-archive-retry-outbox");
  }

  override async init(): Promise<void> {}
  override async list(): Promise<[]> { return []; }
  override async listArchived(): Promise<[]> { return []; }
  override async dismissArchived(): Promise<void> {
    this.dismissAttempts += 1;
    throw new Error("Injected archive cleanup failure");
  }
}

class BlockingArchiveOutbox extends MutationOutbox {
  dismissAttempts = 0;
  private markSecondAttemptStarted!: () => void;
  private finishSecondAttempt!: () => void;
  readonly secondAttemptStarted = new Promise<void>((resolve) => {
    this.markSecondAttemptStarted = resolve;
  });
  private readonly secondAttemptRelease = new Promise<void>((resolve) => {
    this.finishSecondAttempt = resolve;
  });

  constructor() {
    super("unused-blocking-archive-retry-outbox");
  }

  override async init(): Promise<void> {}
  override async list(): Promise<[]> { return []; }
  override async listArchived(): Promise<[]> { return []; }
  override async dismissArchived(): Promise<void> {
    this.dismissAttempts += 1;
    if (this.dismissAttempts === 1) {
      throw new Error("Injected archive cleanup failure");
    }
    this.markSecondAttemptStarted();
    await this.secondAttemptRelease;
  }

  releaseSecondAttempt(): void {
    this.finishSecondAttempt();
  }
}

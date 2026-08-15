import { expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SETTINGS_STATE_V2_FILE } from "../../server/data-directory-layout.js";
import { internalErrorLogPath } from "../../server/internal-error-log.js";
import { MutationOutbox } from "../../server/mutation-outbox.js";
import {
  BackendRestartRequiredError,
  createWorkerStoryApi,
  WorkerApiError
} from "../src/worker-api.js";
import { isWorkerMessage } from "../src/worker-message.js";
import { createFailureEnvelope } from "../../shared/failure-envelope.js";
import {
  platformPerformanceBudget
} from "../../test/performance-budget.js";
import { FakeWorker, waitForRequest } from "./fixtures/fake-worker.js";
import { createDemoController } from "../src/demo.js";
import type { StoryPayload } from "../../shared/types.js";
import { InternalErrorReporter } from "../../server/internal-error-reporter.js";

test("embedded internal errors carry the reference written to the private log", async () => {
  const dataDir = await temporaryDirectory("1667-worker-error-data-");
  const machineDir = await temporaryDirectory("1667-worker-error-machine-");
  const backend = await createWorkerStoryApi({ dataDir, machineDir });
  try {
    await writeFile(path.join(dataDir, SETTINGS_STATE_V2_FILE), "{\n", {
      mode: 0o600
    });

    const error = await backend.api.getSettings().then(
      () => null,
      (failure: unknown) => failure
    );

    expect(error instanceof WorkerApiError).toBeTrue();
    expect(error).toMatchObject({ code: "internal", status: 500 });
    const ref = /err_[0-9a-f]{24}/.exec((error as Error).message)?.[0];
    expect(ref).toBeDefined();
    expect((error as WorkerApiError).diagnosticRef).toBe(ref);
    expect((error as Error).message).not.toContain(machineDir);
    const entries = (await readFile(internalErrorLogPath(machineDir), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.at(-1)).toMatchObject({
      ref,
      service: "embedded-worker",
      operation: "getSettings"
    });
  } finally {
    await backend.dispose();
    await Promise.all([
      rm(dataDir, { recursive: true, force: true }),
      rm(machineDir, { recursive: true, force: true })
    ]);
  }
}, platformPerformanceBudget(10_000));

test("unexpected worker exits log content-free host and stream progress", async () => {
  const machineDir = await temporaryDirectory("1667-worker-host-machine-");
  const worker = new FakeWorker();
  const backend = await createWorkerStoryApi({
    worker,
    machineDir,
    readyTimeoutMs: 100
  });
  const privateInstruction = "private-instruction-that-must-not-reach-the-log";
  const privateDelta = "private-streamed-prose-that-must-not-reach-the-log";
  try {
    const payload: StoryPayload = {
      ...createDemoController().payload(),
      aggregateVersion: {
        kind: "v6",
        revision: "00000000000000000001"
      }
    };
    const loading = backend.api.loadStory(payload.id);
    const loadRequest = await waitForRequest(worker, "loadStory");
    worker.message({ type: "result", id: loadRequest.id, value: payload });
    await loading;

    const received: string[] = [];
    const generationFailure = rejection(backend.api.continueStory(
      payload.id,
      privateInstruction,
      "private-generation-id",
      { parentId: payload.path.at(-1)?.id ?? null },
      (delta) => received.push(delta),
      new AbortController().signal
    ));
    const request = await waitForRequest(worker, "continueStory");
    worker.message({
      type: "delta",
      id: request.id,
      sequence: 0,
      text: privateDelta
    });
    expect(received).toEqual([privateDelta]);

    worker.crash("injected worker runtime crash");
    const failure = await backend.failure;
    expect(failure instanceof BackendRestartRequiredError).toBeTrue();
    expect((failure as BackendRestartRequiredError).diagnosticRef)
      .toMatch(/^err_[0-9a-f]{24}$/);
    expect(await generationFailure).toBe(failure);

    const entries = (await readFile(internalErrorLogPath(machineDir), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const entry = entries.at(-1) as {
      service: string;
      operation: string;
      error: {
        name: string;
        cause: { name: string; message: string };
      };
    };
    expect(entry).toMatchObject({
      service: "embedded-worker-host",
      operation: "restart-required",
      error: {
        name: "BackendRestartRequiredError",
        cause: { name: "EmbeddedWorkerHostDiagnostic" }
      }
    });
    const prefix = "Embedded backend host state: ";
    expect(entry.error.cause.message.startsWith(prefix)).toBeTrue();
    const snapshot = JSON.parse(entry.error.cause.message.slice(prefix.length)) as {
      pendingCount: number;
      omittedCount: number;
      operations: Array<Record<string, unknown>>;
    };
    expect(snapshot).toMatchObject({
      pendingCount: 1,
      omittedCount: 0,
      operations: [{
        method: "continueStory",
        replay: false,
        stream: true,
        cancelled: false,
        settling: false,
        expectedSequence: 1,
        receivedDeltaBatches: 1,
        receivedUtf16Units: privateDelta.length
      }]
    });
    expect(typeof snapshot.operations[0]?.ageMs).toBe("number");
    const stored = JSON.stringify(entry);
    expect(stored).not.toContain(privateInstruction);
    expect(stored).not.toContain(privateDelta);
    expect(stored).not.toContain("private-generation-id");
  } finally {
    await backend.dispose().catch(() => undefined);
    await rm(machineDir, { recursive: true, force: true });
  }
}, platformPerformanceBudget(10_000));

test("host diagnostic failures preserve the backend hard fence", async () => {
  const worker = new FakeWorker();
  const backend = await createWorkerStoryApi({
    worker,
    machineDir: "/unused-diagnostic-machine-directory",
    readyTimeoutMs: 100
  });
  const openReporter = InternalErrorReporter.open;
  InternalErrorReporter.open = async () => {
    throw new Error("injected diagnostic open failure");
  };
  try {
    worker.crash("injected worker runtime crash");
    const failure = await backend.failure;
    expect(failure instanceof BackendRestartRequiredError).toBeTrue();
    expect((failure as BackendRestartRequiredError).diagnosticRef).toBe(null);
  } finally {
    InternalErrorReporter.open = openReporter;
    await backend.dispose().catch(() => undefined);
  }
}, platformPerformanceBudget(10_000));

test("worker diagnostics validate the dedicated reference field, not message text", () => {
  expect(isWorkerMessage({
    type: "protocolError",
    failure: createFailureEnvelope({
      code: "internal",
      message: "Upstream mentioned err_aaaaaaaaaaaaaaaaaaaaaaaa",
      status: 500
    })
  })).toBeTrue();
  expect(isWorkerMessage({
    type: "protocolError",
    failure: createFailureEnvelope({
      code: "internal",
      message: "Internal server error",
      status: 500
    }, "err_bbbbbbbbbbbbbbbbbbbbbbbb")
  })).toBeTrue();
  expect(isWorkerMessage({
    type: "protocolError",
    failure: {
      ...createFailureEnvelope({
        code: "internal",
        message: "Internal server error",
        status: 500
      }),
      stack: "private stack"
    }
  })).toBeFalse();
});

test("archived diagnostics remain warnings without worker replay", async () => {
  const dataDir = await temporaryDirectory("1667-worker-archived-warning-");
  const outbox = new MutationOutbox(path.join(dataDir, "mutation-outbox"));
  await outbox.init();
  const mutationId = `m1-${Date.now().toString(36)}-${"a".padStart(32, "0")}`;
  await outbox.enqueue(
    mutationId,
    "autonameStory",
    { id: "story", expectedTitle: "Old" }
  );
  await outbox.archive(mutationId, createFailureEnvelope({
    code: "internal",
    message: "Internal server error",
    status: 500
  }, "err_deadbeefdeadbeefdeadbeef"));
  const worker = new FakeWorker(true);
  const backend = await createWorkerStoryApi({
    worker,
    outbox,
    readyTimeoutMs: 100
  });
  try {
    const warnings = await backend.recovery;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      mutationId,
      method: "autonameStory",
      storyId: "story",
      resolution: "archived",
      error: {
        code: "internal",
        status: 500,
        diagnosticRef: "err_deadbeefdeadbeefdeadbeef"
      }
    });
    expect(warnings[0]?.error.message).toContain(
      "err_deadbeefdeadbeefdeadbeef"
    );
    expect(
      worker.messages.some((message) => message.type === "request")
    ).toBeFalse();
  } finally {
    await backend.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("uncertain terminal failures retain diagnostics without stopping the worker", async () => {
  const worker = new FakeWorker(true);
  const backend = await createWorkerStoryApi({
    worker,
    readyTimeoutMs: 100
  });
  const pending = backend.api.createStory("internal failure");
  const request = await waitForRequest(worker, "createStory");
  worker.message({
    type: "error",
    id: request.id,
    failure: createFailureEnvelope({
      code: "internal",
      message: "Internal server error",
      status: 500
    }, "err_deadbeefdeadbeefdeadbeef"),
    mutationOutcome: "uncertain"
  });

  const pendingError = await rejection(pending);
  expect(pendingError instanceof WorkerApiError).toBeTrue();
  expect(pendingError).toMatchObject({
    diagnosticRef: "err_deadbeefdeadbeefdeadbeef",
    // Settlement exposes the transport-owned mutation outcome.
    mutationOutcome: "uncertain",
    code: "internal"
  });
  expect(worker.terminateCalls).toBe(0);
  expect(await Promise.race([
    backend.failure.then(() => "failed" as const),
    new Promise<"running">((resolve) =>
      setTimeout(() => resolve("running"), 10)
    )
  ])).toBe("running");
  await backend.dispose();
});

test("terminal mutation settlement stamps WorkerApiError.mutationOutcome terminal", async () => {
  const worker = new FakeWorker(true);
  const backend = await createWorkerStoryApi({
    worker,
    readyTimeoutMs: 100
  });
  const pending = backend.api.createStory("terminal internal failure");
  const request = await waitForRequest(worker, "createStory");
  worker.message({
    type: "error",
    id: request.id,
    failure: createFailureEnvelope({
      code: "internal",
      message: "Internal server error",
      status: 500
    }, "err_deadbeefdeadbeefdeadbeef"),
    mutationOutcome: "terminal"
  });

  const pendingError = await rejection(pending);
  expect(pendingError instanceof WorkerApiError).toBeTrue();
  expect(pendingError).toMatchObject({
    code: "internal",
    mutationOutcome: "terminal",
    diagnosticRef: "err_deadbeefdeadbeefdeadbeef"
  });
  expect(worker.terminateCalls).toBe(0);
  await backend.dispose();
});

async function temporaryDirectory(prefix: string): Promise<string> {
  return await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

async function rejection(
  promise: Promise<unknown>
): Promise<Error & Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    return error as Error & Record<string, unknown>;
  }
  throw new Error("Expected promise to reject");
}

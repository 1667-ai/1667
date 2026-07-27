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
} from "../../test/platform-performance-budget.js";
import { FakeWorker, waitForRequest } from "./fixtures/fake-worker.js";

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

test("mutation hard fences retain internal diagnostic references", async () => {
  const worker = new FakeWorker();
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
  expect(pendingError instanceof BackendRestartRequiredError).toBeTrue();
  expect(pendingError).toMatchObject({
    diagnosticRef: "err_deadbeefdeadbeefdeadbeef"
  });
  expect(await backend.failure).toBe(pendingError);
  const disposalError = await rejection(backend.dispose());
  expect(disposalError).toBe(pendingError);
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

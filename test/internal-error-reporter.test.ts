import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  readFile
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  DiagnosticServiceError,
  ProviderRecoveryRequiredError,
  ServiceError
} from "../server/errors.js";
import {
  internalErrorLogPath
} from "../server/internal-error-log.js";
import {
  restoreStoredServiceFailure
} from "../server/service-error-policy.js";
import { MutationReceiptStore } from "../server/mutation-receipts.js";
import { WorkerErrorReporter } from "../server/worker-error-reporter.js";
import { receiptUnavailable } from "../server/mutation-ledger-store-support.js";
import {
  temporaryDiagnosticDirectory
} from "./internal-error-test-support.js";
import { errorFromFailureIncident } from "../server/reported-service-error.js";
import { createDurableMutationId } from "../shared/durable-mutation-id.js";
import {
  MUTATION_INPUT_PROTOCOL_VERSION
} from "../shared/worker-protocol.js";

test("plain internal receipt replay cannot invent a new diagnostic", async (t) => {
  const machineDir = await temporaryDiagnosticDirectory(t);
  const reporter = await WorkerErrorReporter.open(machineDir);
  t.after(async () => await reporter.close());
  const restored = restoreStoredServiceFailure({
    kind: "plain",
    code: "internal",
    message: "Internal server error",
    status: 500
  });

  const message = await reporter.runtimeMessage(restored, {
    service: "mutation-receipt"
  });

  assert.deepEqual(message.failure, {
    kind: "plain",
    code: "internal",
    message: "Internal server error",
    status: 500
  });
  assert.equal(
    await readFile(internalErrorLogPath(machineDir), "utf8"),
    ""
  );
});

test("thrown undefined still receives a persistent diagnostic", async (t) => {
  const machineDir = await temporaryDiagnosticDirectory(t);
  const reporter = await WorkerErrorReporter.open(machineDir);
  t.after(async () => await reporter.close());

  const message = await reporter.runtimeMessage(undefined, {
    service: "embedded-worker"
  });

  assert.equal(message.failure.kind, "diagnostic");
  if (message.failure.kind !== "diagnostic") {
    assert.fail("expected a diagnostic failure");
  }
  assert.match(message.failure.diagnosticRef, /^err_[0-9a-f]{24}$/);
  assert.match(
    await readFile(internalErrorLogPath(machineDir), "utf8"),
    new RegExp(message.failure.diagnosticRef)
  );
});

test("worker errors retain their private provider recovery target", async () => {
  const providerMutationId =
    "m1.1767225600001.7123456789abcdef0123456789abcdef";
  const message = await WorkerErrorReporter.disabled().workerMessage(
    {
      workerInstanceId: "1".repeat(32),
      sequence: 1n
    },
    new ProviderRecoveryRequiredError(
      providerMutationId
    ),
    { mutationId: providerMutationId }
  );

  assert.equal(message.providerMutationId, providerMutationId);
  assert.equal(message.failure.message, "The model request stopped. You can try again.");
});

test("legacy receipt IDs do not become provider target wire fields", async () => {
  const message = await WorkerErrorReporter.disabled().workerMessage(
    {
      workerInstanceId: "3".repeat(32),
      sequence: 1n
    },
    new ProviderRecoveryRequiredError(
      `m1-${Date.now().toString(36)}-${"9".padStart(32, "0")}`
    )
  );

  assert.equal(message.providerMutationId, undefined);
  assert.equal(message.failure.code, "generation_outcome_unknown");
});

test("legacy warning IDs cannot emit current provider target fields", async () => {
  const providerMutationId =
    "m1.1767225600001.9123456789abcdef0123456789abcdef";
  const message = await WorkerErrorReporter.disabled().workerMessage(
    {
      workerInstanceId: "4".repeat(32),
      sequence: 1n
    },
    new ProviderRecoveryRequiredError(providerMutationId),
    {
      mutationId:
        `m1-${Date.now().toString(36)}-${"a".padStart(32, "0")}`
    }
  );

  assert.equal(message.providerMutationId, undefined);
  assert.equal(message.failure.code, "generation_outcome_unknown");
});

test("provider recovery logs only its safe correlation target", async (t) => {
  const machineDir = await temporaryDiagnosticDirectory(t);
  const reporter = await WorkerErrorReporter.open(machineDir);
  t.after(async () => await reporter.close());
  const providerMutationId = createDurableMutationId();
  const receipts = new MutationReceiptStore(
    path.join(machineDir, "receipts"),
    async () => {
      throw new Error("A provider warning has no result");
    }
  );
  await receipts.init();
  let recoveryError: unknown;
  try {
    await receipts.run(
      providerMutationId,
      "autonameStory",
      { id: "story" },
      async (plan) => {
        await plan.providerStarted();
        throw new Error(
          "https://private-endpoint.invalid credential prompt response"
        );
      },
      MUTATION_INPUT_PROTOCOL_VERSION,
      () => undefined
    );
  } catch (error) {
    recoveryError = error;
  }
  assert.equal(
    recoveryError instanceof ProviderRecoveryRequiredError,
    true
  );
  const message = await reporter.workerMessage(
    {
      workerInstanceId: "2".repeat(32),
      sequence: 1n
    },
    recoveryError,
    { mutationId: providerMutationId }
  );

  assert.equal(message.providerMutationId, providerMutationId);
  assert.equal(message.failure.kind, "diagnostic");
  const log = await readFile(internalErrorLogPath(machineDir), "utf8");
  assert.match(log, new RegExp(providerMutationId.replaceAll(".", "\\.")));
  assert.doesNotMatch(log, /private-endpoint|credential|prompt|response/);
});

test("an unreported private failure can be persisted at a later boundary", async (t) => {
  const root = new Error("private deferred diagnostic");
  const deferred = await WorkerErrorReporter
    .disabled()
    .internalReporter
    .report(root, { service: "custom-service" });
  assert.equal(deferred.failure.kind, "plain");

  const machineDir = await temporaryDiagnosticDirectory(t);
  const reporter = await WorkerErrorReporter.open(machineDir);
  t.after(async () => await reporter.close());
  const message = await reporter.runtimeMessage(
    errorFromFailureIncident(deferred),
    {
    service: "embedded-worker"
    }
  );

  assert.equal(message.failure.kind, "diagnostic");
  assert.match(
    await readFile(internalErrorLogPath(machineDir), "utf8"),
    /private deferred diagnostic/
  );
});

test("safe storage failures retain their private diagnostic cause", async (t) => {
  const machineDir = await temporaryDiagnosticDirectory(t);
  const reporter = await WorkerErrorReporter.open(machineDir);
  t.after(async () => await reporter.close());
  const failure = receiptUnavailable(
    new Error("private mutation ledger path")
  );

  const message = await reporter.runtimeMessage(failure, {
    service: "mutation-ledger"
  });

  assert.equal(message.failure.kind, "diagnostic");
  assert.equal(message.failure.code, "receipt_storage_unavailable");
  assert.match(
    await readFile(internalErrorLogPath(machineDir), "utf8"),
    /private mutation ledger path/
  );
});

test("public outcome replacement still reports the private diagnostic", async (t) => {
  const machineDir = await temporaryDiagnosticDirectory(t);
  const reporter = await WorkerErrorReporter.open(machineDir);
  t.after(async () => await reporter.close());
  const root = new Error("private settlement failure");
  const failure = new DiagnosticServiceError(
    408,
    "Worker mutation recovery deadline exceeded",
    "mutation_outcome_unknown",
    root
  );

  const reported = await reporter.internalReporter.report(
    failure,
    { service: "embedded-worker" }
  );
  const reference = reported.failure.kind === "diagnostic"
    ? reported.failure.diagnosticRef
    : null;

  assert.deepEqual(reported.failure, {
    kind: "diagnostic",
    code: "mutation_outcome_unknown",
    message: "Worker mutation recovery deadline exceeded",
    status: 408,
    diagnosticRef: reference
  });
  const stored = await readFile(internalErrorLogPath(machineDir), "utf8");
  assert.match(stored, /private settlement failure/);
  assert.match(stored, new RegExp(reference ?? ""));
});

test("print mode survives an unavailable persistent log", async (t) => {
  if (process.platform === "win32") return t.skip();
  const machineDir = await temporaryDiagnosticDirectory(t);
  const logDirectory = path.join(machineDir, "log");
  await mkdir(logDirectory, { mode: 0o755 });
  await chmod(logDirectory, 0o755);
  let printed = "";
  const reporter = await WorkerErrorReporter.open(machineDir, {
    print: true,
    stderr: {
      write(value: string | Uint8Array) {
        printed += String(value);
        return true;
      }
    } as Pick<NodeJS.WriteStream, "write">
  });

  const hidden = new ServiceError(
    500,
    "diagnostic after open failure",
    "internal"
  );
  const runtimeMessage = await reporter.runtimeMessage(
    hidden,
    { service: "embedded-worker-protocol" }
  );

  assert.deepEqual(runtimeMessage, {
    failure: {
      kind: "plain",
      code: "internal",
      message: "Internal server error",
      status: 500
    }
  });
  assert.doesNotMatch(runtimeMessage.failure.message, /err_[0-9a-f]{24}/);
  assert.match(printed, /internal error log is unavailable/);
  assert.match(printed, /diagnostic after open failure/);
});

test("an unavailable persistent log is visible without exposing details", async (t) => {
  if (process.platform === "win32") return t.skip();
  const machineDir = await temporaryDiagnosticDirectory(t);
  const logDirectory = path.join(machineDir, "log");
  await mkdir(logDirectory, { mode: 0o755 });
  await chmod(logDirectory, 0o755);
  let printed = "";
  const reporter = await WorkerErrorReporter.open(machineDir, {
    stderr: {
      write(value: string | Uint8Array) {
        printed += String(value);
        return true;
      }
    } as Pick<NodeJS.WriteStream, "write">
  });

  const runtimeMessage = await reporter.runtimeMessage(
    new Error("private runtime detail"),
    { service: "embedded-worker-protocol" }
  );

  assert.deepEqual(runtimeMessage, {
    failure: {
      kind: "plain",
      code: "internal",
      message: "Internal server error",
      status: 500
    }
  });
  assert.match(printed, /internal error log is unavailable/);
  assert.match(printed, /--print-logs/);
  assert.doesNotMatch(printed, /private runtime detail/);
  assert.doesNotMatch(
    printed,
    new RegExp(machineDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
});

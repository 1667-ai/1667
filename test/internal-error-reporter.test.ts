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
  ServiceError
} from "../server/errors.js";
import {
  internalErrorLogPath
} from "../server/internal-error-log.js";
import {
  restoreStoredServiceFailure
} from "../server/service-error-policy.js";
import { WorkerErrorReporter } from "../server/worker-error-reporter.js";
import { receiptUnavailable } from "../server/mutation-ledger-store-support.js";
import {
  temporaryDiagnosticDirectory
} from "./internal-error-test-support.js";
import { errorFromFailureIncident } from "../server/reported-service-error.js";

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

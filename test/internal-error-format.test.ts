import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  InternalErrorLog
} from "../server/internal-error-log.js";
import {
  formatInternalErrorEmergency
} from "../server/internal-error-format.js";
import { ProviderError } from "../server/errors.js";
import { RuntimeDataDirectoryLock } from "../server/runtime-data-directory.js";
import {
  temporaryDiagnosticDirectory
} from "./internal-error-test-support.js";

test("provider diagnostics redact response-bearing messages and stacks", async (t) => {
  const machineDir = await temporaryDiagnosticDirectory(t);
  let printed = "";
  const log = await InternalErrorLog.open(machineDir, {
    print: true,
    stderr: {
      write(value: string | Uint8Array) {
        printed += String(value);
        return true;
      }
    } as Pick<NodeJS.WriteStream, "write">
  });
  t.after(async () => await log.close());
  const secret = "provider-response-secret";
  const providerError = new ProviderError(
    `Model request failed (500): ${secret}`,
    500,
    secret
  );

  const report = await log.record(providerError, {
    service: "embedded-worker",
    operation: "continueStory"
  });

  assert.ok(report);
  const stored = await readFile(report.file, "utf8");
  assert.equal(printed, stored);
  assert.doesNotMatch(stored, new RegExp(secret));
  assert.doesNotMatch(stored, /Model request failed/);
  assert.deepEqual(JSON.parse(stored).error, {
    name: "ProviderError",
    message: "Provider request failed with HTTP status 500",
    status: 500
  });
});

test("provider redaction survives the emergency formatting path", () => {
  const secret = "emergency-provider-response-secret";
  const printed = formatInternalErrorEmergency(
    new ProviderError(`Model request failed: ${secret}`, 500, secret),
    new Error("hostile diagnostic context"),
    new Date().toISOString()
  );

  assert.doesNotMatch(printed, new RegExp(secret));
  assert.match(printed, /ProviderError \(details redacted\)/);
  assert.match(printed, /diagnostic formatting failed/);
});

test("hostile error accessors cannot replace the logging call", async (t) => {
  const machineDir = await temporaryDiagnosticDirectory(t);
  const log = await InternalErrorLog.open(machineDir);
  t.after(async () => await log.close());
  const error = new Error("hidden");
  Object.defineProperty(error, "message", {
    get() {
      throw new Error("hostile message getter");
    }
  });

  const report = await log.record(error, { service: "embedded-worker" });

  assert.ok(report);
  const entry = JSON.parse(await readFile(report.file, "utf8"));
  assert.equal(entry.error.message, "<unavailable>");
});

test("aggregate diagnostics retain bounded component failures", async (t) => {
  const machineDir = await temporaryDiagnosticDirectory(t);
  const log = await InternalErrorLog.open(machineDir);
  t.after(async () => await log.close());
  const nested = new AggregateError(
    [new Error("secondary cleanup"), new TypeError("third cleanup")],
    "nested cleanup"
  );
  const root = new AggregateError(
    [new Error("startup failed"), nested],
    "startup and cleanup failed",
    { cause: new Error("primary startup") }
  );

  const report = await log.record(root, { service: "http-server-startup" });

  assert.ok(report);
  const entry = JSON.parse(await readFile(report.file, "utf8"));
  assert.deepEqual(
    entry.error.errors.map((error: { message: string }) => error.message),
    ["startup failed", "nested cleanup"]
  );
  assert.deepEqual(
    entry.error.errors[1].errors.map(
      (error: { message: string }) => error.message
    ),
    ["secondary cleanup", "third cleanup"]
  );
  assert.equal(entry.error.cause.message, "primary startup");
});

test("failed lock acquisition retains its secondary release failure", async (t) => {
  const primary = new Error("data-directory acquisition failed");
  const release = new Error("data-directory release failed");
  const runtimeLock = new RuntimeDataDirectoryLock("/unused");
  const lock = (
    runtimeLock as unknown as {
      lock: {
        acquire(): Promise<string>;
        release(): Promise<void>;
      };
    }
  ).lock;
  lock.acquire = async () => {
    throw primary;
  };
  lock.release = async () => {
    throw release;
  };

  const failure = await runtimeLock.acquire().then(
    () => null,
    (error: unknown) => error
  );
  assert.ok(failure instanceof AggregateError);
  assert.deepEqual(failure.errors, [primary, release]);

  const machineDir = await temporaryDiagnosticDirectory(t);
  const log = await InternalErrorLog.open(machineDir);
  t.after(async () => await log.close());
  const report = await log.record(failure, {
    service: "embedded-worker-startup",
    operation: "data-directory-acquisition"
  });

  assert.ok(report);
  const entry = JSON.parse(await readFile(report.file, "utf8"));
  assert.deepEqual(
    entry.error.errors.map((error: { message: string }) => error.message),
    ["data-directory acquisition failed", "data-directory release failed"]
  );
});

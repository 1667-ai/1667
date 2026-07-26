import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  open,
  readdir,
  readFile,
  rename,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  InternalErrorLog,
  MAX_INTERNAL_ERROR_LOG_BYTES,
  internalErrorLogLockPath,
  internalErrorLogPath
} from "../server/internal-error-log.js";
import { lockFile } from "../server/os-file-lock.js";
import {
  temporaryDiagnosticDirectory as temporaryDirectory
} from "./internal-error-test-support.js";

test("internal errors append private structured diagnostics and optionally print them", async (t) => {
  const machineDir = await temporaryDirectory(t);
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

  const root = new Error("settings authority could not be read", {
    cause: new TypeError("invalid settings state")
  });
  const report = await log.record(root, {
    service: "embedded-worker",
    operation: "getSettings",
    workerOperationId: "worker:1"
  });

  assert.ok(report);
  assert.match(report.ref, /^err_[0-9a-f]{24}$/);
  assert.equal(report.file, internalErrorLogPath(machineDir));
  const stored = await readFile(report.file, "utf8");
  assert.equal(printed, stored);
  const entry = JSON.parse(stored) as Record<string, unknown>;
  assert.equal(entry.ref, report.ref);
  assert.equal(entry.service, "embedded-worker");
  assert.equal(entry.operation, "getSettings");
  assert.equal(entry.workerOperationId, "worker:1");
  assert.deepEqual(entry.error, {
    name: "Error",
    message: root.message,
    stack: root.stack,
    cause: {
      name: "TypeError",
      message: "invalid settings state",
      stack: root.cause instanceof Error ? root.cause.stack : undefined
    }
  });
  if (process.platform !== "win32") {
    assert.equal((await lstat(path.dirname(report.file))).mode & 0o777, 0o700);
    assert.equal((await lstat(report.file)).mode & 0o777, 0o600);
  }
});

test("full internal error logs rotate to the newest diagnostic", async (t) => {
  const machineDir = await temporaryDirectory(t);
  const file = internalErrorLogPath(machineDir);
  const log = await InternalErrorLog.open(machineDir);
  t.after(async () => await log.close());
  const oversizedPrefix = await open(file, "a");
  const prior = Buffer.alloc(MAX_INTERNAL_ERROR_LOG_BYTES - 1, 0x78);
  prior[prior.length - 1] = 0x0a;
  await oversizedPrefix.write(prior);
  await oversizedPrefix.close();

  const report = await log.record(new Error("newest diagnostic"), {
    service: "embedded-worker"
  });

  assert.ok(report);
  const stored = await readFile(file, "utf8");
  assert.ok(Buffer.byteLength(stored) <= MAX_INTERNAL_ERROR_LOG_BYTES);
  assert.equal(JSON.parse(stored).ref, report.ref);
});

test("one diagnostic cannot exceed the bounded log size", async (t) => {
  const machineDir = await temporaryDirectory(t);
  const log = await InternalErrorLog.open(machineDir);
  t.after(async () => await log.close());
  const expansion = "\0".repeat(16_384);
  const largeError = () => {
    const error = new Error(expansion);
    error.stack = expansion;
    return error;
  };
  const root = new AggregateError(
    Array.from({ length: 8 }, () => {
      const group = new AggregateError(
        Array.from({ length: 8 }, largeError),
        expansion
      );
      group.stack = expansion;
      return group;
    }),
    expansion
  );
  root.stack = expansion;

  const report = await log.record(root, { service: "embedded-worker" });

  assert.ok(report);
  const stored = await readFile(report.file);
  assert.ok(stored.byteLength <= MAX_INTERNAL_ERROR_LOG_BYTES);
  assert.equal(
    JSON.parse(stored.toString("utf8")).error.name,
    "TruncatedDiagnostic"
  );
});

test("failed log rotation preserves prior diagnostics", async (t) => {
  if (process.platform === "win32") return t.skip();
  const machineDir = await temporaryDirectory(t);
  const file = internalErrorLogPath(machineDir);
  const log = await InternalErrorLog.open(machineDir);
  t.after(async () => await log.close());
  const prior = Buffer.alloc(MAX_INTERNAL_ERROR_LOG_BYTES - 1, 0x78);
  prior[prior.length - 1] = 0x0a;
  await writeFile(file, prior);
  await chmod(path.dirname(file), 0o500);

  const report = await log.record(new Error("rotation cannot publish"), {
    service: "embedded-worker"
  });

  assert.equal(report, null);
  await chmod(path.dirname(file), 0o700);
  assert.deepEqual(await readFile(file), prior);
});

test("failed rotation durability restores the previous log", async (t) => {
  const machineDir = await temporaryDirectory(t);
  const file = internalErrorLogPath(machineDir);
  const log = await InternalErrorLog.open(machineDir, {
    syncDirectories: async () => {
      throw new Error("injected rotation barrier failure");
    }
  });
  t.after(async () => await log.close());
  const prior = Buffer.alloc(MAX_INTERNAL_ERROR_LOG_BYTES - 1, 0x78);
  prior[prior.length - 1] = 0x0a;
  await writeFile(file, prior);

  const report = await log.record(new Error("rotation barrier fails"), {
    service: "embedded-worker"
  });

  assert.equal(report, null);
  assert.deepEqual(await readFile(file), prior);
});

test("startup reconciles one bounded rotation generation", async (t) => {
  const machineDir = await temporaryDirectory(t);
  const file = internalErrorLogPath(machineDir);
  const backup = `${file}.previous`;
  const next = `${file}.next`;
  const initial = await InternalErrorLog.open(machineDir);
  await initial.close();
  await writeFile(file, "newest\n");
  await writeFile(backup, "older\n");
  await writeFile(next, "interrupted\n");

  const committed = await InternalErrorLog.open(machineDir);
  await committed.close();

  assert.equal(await readFile(file, "utf8"), "newest\n");
  assert.deepEqual(
    (await readdir(path.dirname(file))).filter((name) =>
      name.startsWith("1667.log")
    ),
    ["1667.log"]
  );

  await rename(file, backup);
  await writeFile(next, "interrupted\n");
  const restored = await InternalErrorLog.open(machineDir);
  await restored.close();

  assert.equal(await readFile(file, "utf8"), "newest\n");
  assert.deepEqual(
    (await readdir(path.dirname(file))).filter((name) =>
      name.startsWith("1667.log")
    ),
    ["1667.log"]
  );
});

test("internal error logs repair an interrupted JSONL tail before appending", async (t) => {
  const machineDir = await temporaryDirectory(t);
  const file = internalErrorLogPath(machineDir);
  const log = await InternalErrorLog.open(machineDir);
  t.after(async () => await log.close());
  await writeFile(file, "{\"interrupted\":", { flag: "a" });

  const report = await log.record(new Error("after interrupted append"), {
    service: "embedded-worker"
  });

  assert.ok(report);
  const lines = (await readFile(file, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]!).ref, report.ref);
});

test("internal error logging waits for brief cross-process contention", async (t) => {
  const machineDir = await temporaryDirectory(t);
  const log = await InternalErrorLog.open(machineDir);
  t.after(async () => await log.close());
  const contender = await open(internalErrorLogLockPath(machineDir), "a");
  t.after(async () => await contender.close());
  const held = await lockFile(contender.fd);
  const released = new Promise<void>((resolve) => {
    setTimeout(() => {
      void held.unlock().then(resolve, resolve);
    }, 20);
  });

  const report = await log.record(new Error("after contention"), {
    service: "embedded-worker"
  });
  await released;

  assert.ok(report);
  assert.match(await readFile(report.file, "utf8"), /after contention/);
});

test("internal error log initialization waits for the rotation lock", async (t) => {
  const machineDir = await temporaryDirectory(t);
  const initial = await InternalErrorLog.open(machineDir);
  await initial.close();
  const contender = await open(internalErrorLogLockPath(machineDir), "a");
  t.after(async () => await contender.close());
  const held = await lockFile(contender.fd);
  let opened = false;
  const opening = InternalErrorLog.open(machineDir).then((log) => {
    opened = true;
    return log;
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(opened, false);
  await held.unlock();

  const reopened = await opening;
  await reopened.close();
});

test("concurrent diagnostics settle before a queued close", async (t) => {
  const machineDir = await temporaryDirectory(t);
  const log = await InternalErrorLog.open(machineDir);
  const first = log.record(new Error("first concurrent error"), {
    service: "embedded-worker"
  });
  const second = log.record(new Error("second concurrent error"), {
    service: "embedded-worker"
  });
  const closing = log.close();

  const [firstReport, secondReport] = await Promise.all([first, second]);
  await closing;

  assert.ok(firstReport);
  assert.ok(secondReport);
  const entries = (await readFile(firstReport.file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    entries.map(({ ref }) => ref),
    [firstReport.ref, secondReport.ref]
  );
});

test("failed diagnostic writes do not advertise an unavailable reference", async (t) => {
  const machineDir = await temporaryDirectory(t);
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
  await log.close();

  const report = await log.record(new Error("preserved diagnostic"), {
    service: "embedded-worker"
  });

  assert.equal(report, null);
  assert.match(printed, /preserved diagnostic/);
  assert.match(printed, /log write failed/);
  assert.match(printed, /diagnostic was not persisted/);
});

test("failed diagnostic writes warn safely without print mode", async (t) => {
  const machineDir = await temporaryDirectory(t);
  let printed = "";
  const log = await InternalErrorLog.open(machineDir, {
    stderr: {
      write(value: string | Uint8Array) {
        printed += String(value);
        return true;
      }
    } as Pick<NodeJS.WriteStream, "write">
  });
  await log.close();

  const report = await log.record(new Error("private append detail"), {
    service: "embedded-worker"
  });

  assert.equal(report, null);
  assert.match(printed, /diagnostic was not persisted/);
  assert.match(printed, /--print-logs/);
  assert.doesNotMatch(printed, /private append detail/);
});

test("stored failures keep their durable diagnostic reference in the log", async (t) => {
  const machineDir = await temporaryDirectory(t);
  const log = await InternalErrorLog.open(machineDir);
  t.after(async () => await log.close());

  const report = await log.record(
    new Error("durably correlated"),
    { service: "embedded-worker" },
    "err_deadbeefdeadbeefdeadbeef"
  );

  assert.equal(report?.ref, "err_deadbeefdeadbeefdeadbeef");
  const entry = JSON.parse(await readFile(report?.file ?? "", "utf8"));
  assert.equal(entry.ref, "err_deadbeefdeadbeefdeadbeef");
});

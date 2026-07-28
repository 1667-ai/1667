import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  readHttpAuthRecord,
  resolveHttpAuthRecordPaths
} from "../server/http-auth-record.js";
import { internalErrorLogPath } from "../server/internal-error-log.js";
import {
  InternalErrorReporter,
  InternalErrorReporterLease
} from "../server/internal-error-reporter.js";
import { startHttpListener } from "../server/http-listener.js";
import { MACHINE_TIER_OVERRIDE_VARIABLE } from "../server/machine-tier.js";
import {
  internalErrorReference,
  toPublicServiceError
} from "../server/service-error-policy.js";
import { StoryService } from "../server/story-service.js";
import { StoragePathNotDirectoryError } from "../server/story-lifecycle.js";
import { diagnosticReferenceFromFailure } from "../shared/failure-envelope.js";
import {
  availableLoopbackPort,
  privateTemporaryDirectory,
  rejectionOf
} from "./http-listener-fixture.js";

test("listener closes and removes authority when its service factory fails", async (t) => {
  const stateRoot = await privateTemporaryDirectory(t, "1667-http-state-");
  const port = await availableLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  let reference: string | null = null;
  await assert.rejects(
    startHttpListener({
      port,
      authStore: { stateRoot },
      serviceFactory: async () => {
        throw new Error("service factory failed");
      }
    }),
    (error: unknown) => {
      assert.equal(toPublicServiceError(error).message, "Internal server error");
      reference = internalErrorReference(error);
      assert.match(reference ?? "", /^err_[0-9a-f]{24}$/);
      return true;
    }
  );
  const diagnostic = await readFile(internalErrorLogPath(stateRoot), "utf8");
  assert.match(diagnostic, /service factory failed/);
  assert.match(diagnostic, new RegExp(reference ?? ""));
  await assert.rejects(readHttpAuthRecord(origin, { stateRoot }), /ENOENT/);

  const rebound = createServer();
  await new Promise<void>((resolve, reject) => {
    rebound.once("error", reject);
    rebound.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    rebound.close((error) => error === undefined ? resolve() : reject(error));
  });
});

test("listener preserves actionable bind failures after reporting", async (t) => {
  const stateRoot = await privateTemporaryDirectory(t, "1667-http-state-");
  const occupied = createServer();
  await new Promise<void>((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => await new Promise<void>((resolve, reject) => {
    occupied.close((error) => error === undefined ? resolve() : reject(error));
  }));
  const address = occupied.address();
  if (address === null || typeof address === "string") {
    throw new Error("Occupied listener did not expose a TCP address");
  }

  await assert.rejects(
    startHttpListener({
      port: address.port,
      authStore: { stateRoot }
    }),
    (error: unknown) => {
      assert.match(
        toPublicServiceError(error).message,
        /address already in use|EADDRINUSE/i
      );
      assert.equal(internalErrorReference(error), null);
      return true;
    }
  );
});

test("listener accepts explicit reporter ownership only after validation", async (t) => {
  const stateRoot = await privateTemporaryDirectory(t, "1667-http-state-");
  const dataDir = path.join(
    await privateTemporaryDirectory(t, "1667-http-data-parent-"),
    "data"
  );
  let warnings = "";
  const reporter = await InternalErrorReporter.open(stateRoot, {
    stderr: {
      write(value: string | Uint8Array) {
        warnings += String(value);
        return true;
      }
    } as Pick<NodeJS.WriteStream, "write">
  });
  const lease = new InternalErrorReporterLease(reporter);

  await assert.rejects(
    startHttpListener({
      port: Number.NaN,
      errorReporterLease: lease
    }),
    /port must be between/
  );
  assert.equal(lease.transfer(), reporter);
  await reporter.close();

  const ownedReporter = await InternalErrorReporter.open(stateRoot, {
    stderr: {
      write(value: string | Uint8Array) {
        warnings += String(value);
        return true;
      }
    } as Pick<NodeJS.WriteStream, "write">
  });
  const ownedLease = new InternalErrorReporterLease(ownedReporter);
  const listener = await startHttpListener({
    port: 0,
    dataDir,
    authStore: { stateRoot },
    errorReporterLease: ownedLease
  });

  assert.throws(() => ownedLease.transfer(), /already transferred/);
  await listener.close();
  const afterClose = await ownedReporter.report(
    new Error("reporter must be closed with listener"),
    { service: "test" }
  );
  assert.equal(
    diagnosticReferenceFromFailure(afterClose.failure),
    null
  );
  assert.doesNotMatch(
    await readFile(internalErrorLogPath(stateRoot), "utf8"),
    /reporter must be closed with listener/
  );
  assert.match(warnings, /diagnostic was not persisted/);
});

test("listener stores auth in its explicit machine tier by default", async (t) => {
  const machineDir = await privateTemporaryDirectory(
    t,
    "1667-http-machine-"
  );
  const dataDir = path.join(
    await privateTemporaryDirectory(t, "1667-http-data-parent-"),
    "data"
  );
  const listener = await startHttpListener({ machineDir, dataDir });

  try {
    const stored = await readHttpAuthRecord(listener.origin, {
      stateRoot: machineDir
    });
    assert.deepEqual(stored.record, listener.authRecord);
  } finally {
    await listener.close();
  }
});

test("listener keeps pre-reporter configuration failures actionable", async () => {
  await assert.rejects(
    startHttpListener({ port: Number.NaN }),
    (error: unknown) => {
      assert.equal(
        toPublicServiceError(error).message,
        "1667 HTTP port must be between 0 and 65535"
      );
      assert.equal(internalErrorReference(error), null);
      return true;
    }
  );
  await assert.rejects(
    startHttpListener({ developmentOrigin: "http://localhost:5173" }),
    (error: unknown) => {
      assert.match(
        toPublicServiceError(error).message,
        /canonical numeric loopback origin/
      );
      assert.equal(internalErrorReference(error), null);
      return true;
    }
  );
});

test("listener preserves authenticated routing while its service opens", async (t) => {
  const stateRoot = await privateTemporaryDirectory(t, "1667-http-state-");
  const dataDir = path.join(
    await privateTemporaryDirectory(t, "1667-http-data-parent-"),
    "data"
  );
  const port = await availableLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  let initStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    initStarted = resolve;
  });
  let releaseInit!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseInit = resolve;
  });
  const starting = startHttpListener({
    port,
    authStore: { stateRoot },
    serviceFactory: async (errorReporter, machineDir) => new class
      extends StoryService {
        override async init(): Promise<void> {
          initStarted();
          await released;
          await super.init();
        }
      }({ dataDir, machineDir, errorReporter })
  });
  await started;

  try {
    const authRecord = await readHttpAuthRecord(origin, { stateRoot });
    const response = await fetch(`${origin}/api/health`);
    assert.equal(response.status, 503);
    assert.equal(
      response.headers.get("x-1667-server-instance"),
      authRecord.record.instanceId
    );
    assert.deepEqual(await response.json(), {
      error: "1667 is still opening its data"
    });
  } finally {
    releaseInit();
    const listener = await starting;
    await listener.close();
  }
});

test("listener exposes selected storage shape failures only during startup", async (t) => {
  const stateRoot = await privateTemporaryDirectory(t, "1667-http-state-");
  const selectedPath = "/selected/project/stories";

  await assert.rejects(
    startHttpListener({
      authStore: { stateRoot },
      serviceFactory: async () => {
        throw new StoragePathNotDirectoryError(selectedPath);
      }
    }),
    (error: unknown) => {
      assert.equal(
        toPublicServiceError(error).message,
        `Storage path is not a directory: ${selectedPath}`
      );
      assert.equal(internalErrorReference(error), null);
      return true;
    }
  );
  assert.equal(await readFile(internalErrorLogPath(stateRoot), "utf8"), "");
});

test("listener keeps unexpected machine-tier failures private", async (t) => {
  const parent = await privateTemporaryDirectory(
    t,
    "1667-http-state-resolution-"
  );
  const blockingFile = path.join(parent, "not-a-directory");
  await writeFile(blockingFile, "blocked");
  const previous = process.env[MACHINE_TIER_OVERRIDE_VARIABLE];
  process.env[MACHINE_TIER_OVERRIDE_VARIABLE] = path.join(
    blockingFile,
    "state"
  );
  try {
    await assert.rejects(
      startHttpListener(),
      (error: unknown) => {
        assert.equal(
          toPublicServiceError(error).message,
          "Internal server error"
        );
        assert.equal(internalErrorReference(error), null);
        return true;
      }
    );
  } finally {
    if (previous === undefined) {
      delete process.env[MACHINE_TIER_OVERRIDE_VARIABLE];
    } else {
      process.env[MACHINE_TIER_OVERRIDE_VARIABLE] = previous;
    }
  }
});

test("listener preserves startup and cleanup failures together", async (t) => {
  const stateRoot = await privateTemporaryDirectory(t, "1667-http-state-");
  const port = await availableLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  class FailingService extends StoryService {
    override async init(): Promise<void> {
      const paths = await resolveHttpAuthRecordPaths(origin, { stateRoot });
      await writeFile(paths.final, "{", { mode: 0o600 });
      throw new Error("service initialization failed");
    }

    override async dispose(): Promise<void> {
      throw new Error("service disposal failed");
    }
  }

  let reference: string | null = null;
  await assert.rejects(
    startHttpListener({
      port,
      authStore: { stateRoot },
      serviceFactory: async (errorReporter) => new FailingService({
        errorReporter
      })
    }),
    (error: unknown) => {
      assert.equal(toPublicServiceError(error).message, "Internal server error");
      reference = internalErrorReference(error);
      assert.match(reference ?? "", /^err_[0-9a-f]{24}$/);
      return true;
    }
  );
  const diagnostic = await readFile(internalErrorLogPath(stateRoot), "utf8");
  assert.match(diagnostic, /service initialization failed/);
  assert.match(diagnostic, /service disposal failed/);
  assert.match(diagnostic, /JSON|object key|auth record/i);
  assert.match(diagnostic, new RegExp(reference ?? ""));
});

test("listener reports undefined and null process failures", async (t) => {
  for (const [label, failure] of [
    ["undefined", undefined],
    ["null", null]
  ] as const) {
    const stateRoot = await privateTemporaryDirectory(
      t,
      `1667-http-${label}-state-`
    );
    const dataDir = path.join(
      await privateTemporaryDirectory(
        t,
        `1667-http-${label}-data-parent-`
      ),
      "data"
    );
    const listener = await startHttpListener({
      port: 0,
      dataDir,
      authStore: { stateRoot }
    });

    const reported = await rejectionOf(listener.close({
      error: failure,
      operation: `${label}-process-failure`
    }));
    const reference = internalErrorReference(reported);

    assert.match(reference ?? "", /^err_[0-9a-f]{24}$/);
    assert.match(
      await readFile(internalErrorLogPath(stateRoot), "utf8"),
      new RegExp(reference ?? "")
    );
  }
});

test("listener bounds a stalled diagnostic flush during shutdown", async (t) => {
  const stateRoot = await privateTemporaryDirectory(t, "1667-http-state-");
  const dataDir = path.join(
    await privateTemporaryDirectory(t, "1667-http-data-parent-"),
    "data"
  );
  const reporter = InternalErrorReporter.disabled();
  Object.defineProperty(reporter, "report", {
    value: async () => await new Promise<never>(() => undefined)
  });
  const listener = await startHttpListener({
    port: 0,
    dataDir,
    authStore: { stateRoot },
    errorReporterLease: new InternalErrorReporterLease(reporter),
    shutdownGraceMs: 250
  });
  const dateNow = Date.now;
  Date.now = () => 1_000;
  t.after(() => { Date.now = dateNow; });
  const startedAt = performance.now();
  const closing = listener.close({
    error: new Error("shutdown failed"),
    operation: "test-shutdown"
  });
  Date.now = () => 0;
  const failure = await rejectionOf(closing);

  assert.ok(performance.now() - startedAt < 1_000);
  assert.equal(internalErrorReference(failure), null);
  assert.equal(toPublicServiceError(failure).message, "Internal server error");
});

test("request drain owns diagnostic reporting and the error response", async (t) => {
  const stateRoot = await privateTemporaryDirectory(t, "1667-http-state-");
  const dataDir = path.join(
    await privateTemporaryDirectory(t, "1667-http-data-parent-"),
    "data"
  );
  const reporter = await InternalErrorReporter.open(stateRoot);
  const originalReport = reporter.report.bind(reporter);
  let reportStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    reportStarted = resolve;
  });
  let releaseReport!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseReport = resolve;
  });
  Object.defineProperty(reporter, "report", {
    value: async (...args: Parameters<InternalErrorReporter["report"]>) => {
      reportStarted();
      await released;
      return await originalReport(...args);
    }
  });
  const listener = await startHttpListener({
    port: 0,
    dataDir,
    authStore: { stateRoot },
    errorReporterLease: new InternalErrorReporterLease(reporter)
  });
  const response = fetch(`${listener.origin}/missing`);
  await started;
  let closeSettled = false;
  const closing = listener.close().then(() => {
    closeSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closeSettled, false);

  releaseReport();
  assert.equal((await response).status, 404);
  await closing;
  assert.equal(closeSettled, true);
});

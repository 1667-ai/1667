import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createDiagnosticReference } from "../server/diagnostic-reference.js";
import { ServiceError } from "../server/errors.js";
import { readHttpAuthRecord } from "../server/http-auth-record.js";
import { internalErrorLogPath } from "../server/internal-error-log.js";
import {
  InternalErrorReporter,
  InternalErrorReporterLease
} from "../server/internal-error-reporter.js";
import {
  startHttpListener,
  type HttpListener
} from "../server/http-listener.js";
import { runHttpListenerUntilSignal } from "../server/http-process-lifecycle.js";
import {
  loggedFailureIncident,
  ReportedServiceError,
  unreportedFailureIncident
} from "../server/reported-service-error.js";
import { RuntimeDataDirectoryLock } from "../server/runtime-data-directory.js";
import { internalErrorReference } from "../server/service-error-policy.js";
import { StoryService } from "../server/story-service.js";
import {
  createFailureEnvelope,
  diagnosticReferenceFromFailure
} from "../shared/failure-envelope.js";
import {
  privateTemporaryDirectory,
  rejectionOf
} from "./http-listener-fixture.js";

const linuxTest = process.platform === "linux" ? test : test.skip;

linuxTest("process lifecycle correlates readiness publication failures", async (t) => {
  const stateRoot = await privateTemporaryDirectory(t, "1667-http-state-");
  const dataDir = path.join(
    await privateTemporaryDirectory(t, "1667-http-data-parent-"),
    "data"
  );
  const root = new Error("run-record publication failed");
  let reference: string | null = null;
  const reporter = await InternalErrorReporter.open(stateRoot);
  const report = reporter.report.bind(reporter);
  Object.defineProperty(reporter, "report", {
    value: async (...args: Parameters<InternalErrorReporter["report"]>) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return await report(...args);
    }
  });

  const listener = await startHttpListener({
    port: 0,
    dataDir,
    authStore: { stateRoot },
    errorReporterLease: new InternalErrorReporterLease(reporter)
  });
  await assert.rejects(
    runHttpListenerUntilSignal(
      async () => listener,
      async () => {
        throw root;
      }
    ),
    (error: unknown) => {
      reference = internalErrorReference(error);
      assert.match(reference ?? "", /^err_[0-9a-f]{24}$/);
      return true;
    }
  );
  const diagnostic = await readFile(internalErrorLogPath(stateRoot), "utf8");
  assert.match(diagnostic, /run-record publication failed/);
  assert.match(diagnostic, new RegExp(reference ?? ""));
});

test("process lifecycle owns signals before listener startup settles", async () => {
  const previousHandlers = new Set(process.listeners("SIGINT"));
  let resolveStartup!: (listener: HttpListener) => void;
  const startup = new Promise<HttpListener>((resolve) => {
    resolveStartup = resolve;
  });
  let closes = 0;
  let ready = 0;
  const running = runHttpListenerUntilSignal(
    () => startup,
    () => {
      ready += 1;
    }
  );
  const handler = process.listeners("SIGINT").find(
    (candidate) => !previousHandlers.has(candidate)
  );
  assert.notEqual(handler, undefined);
  handler!("SIGINT");
  resolveStartup(fakeListener(async () => {
    closes += 1;
  }));
  await running;
  assert.equal(closes, 1);
  assert.equal(ready, 0);
  assert.deepEqual(
    process.listeners("SIGINT").filter(
      (candidate) => !previousHandlers.has(candidate)
    ),
    []
  );
});

test("process lifecycle closes on signal while readiness remains pending", async () => {
  const previousHandlers = new Set(process.listeners("SIGTERM"));
  let readyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    readyStarted = resolve;
  });
  let closes = 0;
  const listener = fakeListener(async () => {
    closes += 1;
  });
  const running = runHttpListenerUntilSignal(
    async () => listener,
    async () => {
      readyStarted();
      await new Promise<void>(() => undefined);
    }
  );
  await started;
  const handler = process.listeners("SIGTERM").find(
    (candidate) => !previousHandlers.has(candidate)
  );
  assert.notEqual(handler, undefined);
  handler!("SIGTERM");

  await running;
  assert.equal(closes, 1);
  assert.deepEqual(
    process.listeners("SIGTERM").filter(
      (candidate) => !previousHandlers.has(candidate)
    ),
    []
  );
});

linuxTest("real listener releases authority while readiness remains pending", async (t) => {
  const stateRoot = await privateTemporaryDirectory(t, "1667-http-state-");
  const dataDir = path.join(
    await privateTemporaryDirectory(t, "1667-http-data-parent-"),
    "data"
  );
  const previousHandlers = new Set(process.listeners("SIGTERM"));
  let readyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    readyStarted = resolve;
  });
  let rejectReadiness!: (error: unknown) => void;
  const readiness = new Promise<void>((_resolve, reject) => {
    rejectReadiness = reject;
  });
  let readinessRejected = false;
  let authorityReleases = 0;
  let warnings = "";
  const reporter = await InternalErrorReporter.open(stateRoot, {
    stderr: {
      write(value: string | Uint8Array) {
        warnings += String(value);
        return true;
      }
    } as Pick<NodeJS.WriteStream, "write">
  });
  const running = runHttpListenerUntilSignal(
    async () => await startHttpListener({
      port: 0,
      dataDir,
      authStore: { stateRoot },
      errorReporterLease: new InternalErrorReporterLease(reporter),
      projectAuthority: {
        announceProjectServer: async () => undefined,
        release: async () => {
          authorityReleases += 1;
        }
      }
    }),
    async () => {
      readyStarted();
      await readiness;
    }
  );
  await started;
  const handler = process.listeners("SIGTERM").find(
    (candidate) => !previousHandlers.has(candidate)
  );
  assert.notEqual(handler, undefined);
  handler!("SIGTERM");

  try {
    const outcome = await Promise.race([
      running.then(() => "closed" as const),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), 1_000);
      })
    ]);
    assert.equal(outcome, "closed");
    assert.equal(authorityReleases, 1);
    const afterClose = await reporter.report(
      new Error("reporter should already be closed"),
      { service: "test" }
    );
    assert.equal(
      diagnosticReferenceFromFailure(afterClose.failure),
      null
    );
    assert.match(warnings, /diagnostic was not persisted/);
    rejectReadiness(new Error("readiness failed after reporter close"));
    readinessRejected = true;
    const diagnostic = await waitForDiagnostic(
      internalErrorLogPath(stateRoot),
      /readiness failed after reporter close/
    );
    assert.match(diagnostic, /"operation":"ready-callback"/);
  } finally {
    if (!readinessRejected) {
      rejectReadiness(new DOMException("Listener stopped", "AbortError"));
    }
  }
});

linuxTest("process lifecycle reports readiness failures arriving after a signal", async (t) => {
  const stateRoot = await privateTemporaryDirectory(t, "1667-http-state-");
  const dataDir = path.join(
    await privateTemporaryDirectory(t, "1667-http-data-parent-"),
    "data"
  );
  const previousHandlers = new Set(process.listeners("SIGTERM"));
  let readyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    readyStarted = resolve;
  });
  let rejectReadiness!: (error: unknown) => void;
  const readiness = new Promise<void>((_resolve, reject) => {
    rejectReadiness = reject;
  });
  const running = runHttpListenerUntilSignal(
    async () => await startHttpListener({
      port: 0,
      dataDir,
      authStore: { stateRoot }
    }),
    async () => {
      readyStarted();
      await readiness;
    }
  );
  await started;
  const handler = process.listeners("SIGTERM").find(
    (candidate) => !previousHandlers.has(candidate)
  );
  assert.notEqual(handler, undefined);
  handler!("SIGTERM");
  rejectReadiness(new Error("late run-record publication failed"));

  let reference: string | null = null;
  await assert.rejects(running, (error: unknown) => {
    reference = internalErrorReference(error);
    assert.match(reference ?? "", /^err_[0-9a-f]{24}$/);
    return true;
  });
  const diagnostic = await readFile(internalErrorLogPath(stateRoot), "utf8");
  assert.match(diagnostic, /late run-record publication failed/);
  assert.match(diagnostic, new RegExp(reference ?? ""));
});

linuxTest("listener correlates process and cleanup failures in one diagnostic", async (t) => {
  const stateRoot = await privateTemporaryDirectory(t, "1667-http-state-");
  const dataDir = path.join(
    await privateTemporaryDirectory(t, "1667-http-data-parent-"),
    "data"
  );
  const listener = await startHttpListener({
    port: 0,
    dataDir,
    authStore: { stateRoot }
  });
  const authPath = (await readHttpAuthRecord(
    listener.origin,
    { stateRoot }
  )).paths.final;
  await writeFile(authPath, "{", { mode: 0o600 });

  const reported = await rejectionOf(listener.close({
    error: new Error("run-record publication failed"),
    operation: "ready-callback"
  }));
  assert.equal(await rejectionOf(listener.close()), reported);
  const reference = internalErrorReference(reported);

  assert.match(reference ?? "", /^err_[0-9a-f]{24}$/);
  const diagnostic = await readFile(internalErrorLogPath(stateRoot), "utf8");
  const entries = diagnostic.trim().split("\n");
  assert.equal(entries.length, 1);
  assert.match(diagnostic, /run-record publication failed/);
  assert.match(diagnostic, /JSON|auth record/i);
  assert.match(diagnostic, new RegExp(reference ?? ""));
});

linuxTest("supervised runtime failure retains its reference through final cleanup", async (t) => {
  const stateRoot = await privateTemporaryDirectory(t, "1667-http-state-");
  const dataDir = path.join(
    await privateTemporaryDirectory(t, "1667-http-data-parent-"),
    "data"
  );
  const authority = new RuntimeDataDirectoryLock(dataDir);
  let announcedUrl: string | null = null;
  const listener = await startHttpListener({
    port: 0,
    authStore: { stateRoot },
    project: { root: dataDir, dataDir },
    projectAuthority: {
      announceProjectServer: async (server, signal) => {
        await authority.announceProjectServer(server, signal);
        const { url } = server;
        announcedUrl = url;
      },
      release: async () => {
        await authority.release();
        throw new Error("external data lock release failed");
      }
    },
    serviceFactory: async (errorReporter, machineDir) => {
      await authority.acquire();
      return new StoryService({
        dataDir: authority.authorityPath,
        machineDir,
        dataLock: "external",
        freshDataDirectory: authority.initializedNewDirectory,
        errorReporter
      });
    }
  });
  await listener.announceProjectServer();

  const reported = await rejectionOf(listener.close({
    error: new Error("supervised child runtime failed"),
    operation: "supervised-child"
  }));
  const reference = internalErrorReference(reported);

  assert.equal(announcedUrl, listener.origin);
  assert.match(reference ?? "", /^err_[0-9a-f]{24}$/);
  const diagnostic = await readFile(internalErrorLogPath(stateRoot), "utf8");
  assert.equal(diagnostic.trim().split("\n").length, 1);
  assert.match(diagnostic, /supervised child runtime failed/);
  assert.match(diagnostic, /external data lock release failed/);
  assert.match(diagnostic, new RegExp(reference ?? ""));
});

test("process lifecycle retains the listener's correlated reference", async () => {
  const root = new Error("run-record publication failed");
  const reference = createDiagnosticReference();
  const combined = new AggregateError(
    [root, new Error("listener cleanup failed")],
    "1667 HTTP process failure and listener cleanup both failed",
    { cause: root }
  );
  const reportedFailure = createFailureEnvelope(
    {
      code: "internal",
      message: "Internal server error",
      status: 500
    },
    reference
  );
  assert.equal(reportedFailure.kind, "diagnostic");
  if (reportedFailure.kind !== "diagnostic") {
    throw new Error("Expected diagnostic failure");
  }
  const reported = new ReportedServiceError(
    loggedFailureIncident(
      unreportedFailureIncident(
        createFailureEnvelope({
          code: "internal",
          message: "Internal server error",
          status: 500
        }),
        combined,
        combined
      ),
      reference
    )
  );
  const listener = fakeListener(async () => {
    throw reported;
  });

  const previousHandlers = new Set(process.listeners("SIGTERM"));
  const running = runHttpListenerUntilSignal(
    async () => listener,
    () => undefined
  );
  const handler = process.listeners("SIGTERM").find(
    (candidate) => !previousHandlers.has(candidate)
  );
  assert.notEqual(handler, undefined);
  handler!("SIGTERM");
  await assert.rejects(
    running,
    (error: unknown) => {
      assert.ok(error instanceof ServiceError);
      assert.ok(error.cause instanceof AggregateError);
      assert.equal(internalErrorReference(error), reference);
      assert.match(
        error.cause.message,
        /process failure and listener cleanup/
      );
      return true;
    }
  );
});

function fakeListener(
  close: HttpListener["close"]
): HttpListener {
  return {
    origin: "http://127.0.0.1:7373",
    dataDir: "/unused",
    authRecord: {
      schema: 1,
      origin: "http://127.0.0.1:7373",
      instanceId: "11111111-1111-4111-8111-111111111111",
      capabilities: {
        story: "11".repeat(32),
        admin: "22".repeat(32)
      }
    },
    announceProjectServer: async () => undefined,
    trackReadiness: () => undefined,
    close
  };
}

async function waitForDiagnostic(
  file: string,
  pattern: RegExp
): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const diagnostic = await readFile(file, "utf8").catch(() => "");
    if (pattern.test(diagnostic)) return diagnostic;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for diagnostic ${pattern}`);
}

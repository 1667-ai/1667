import assert from "node:assert/strict";
import test from "node:test";
import {
  HttpOperationError,
  type OperationFetch
} from "../shared/http-operation-client.js";
import {
  HTTP_OPERATION_CANCEL_GRACE_MS,
  HTTP_OPERATION_RESERVATION_PATH,
  HTTP_OPERATION_SESSION_PATH,
  HTTP_OPERATION_TICKET_HEADER
} from "../shared/http-operation-protocol.js";
import {
  createFailureEnvelope,
  diagnosticReferenceFromFailure
} from "../shared/failure-envelope.js";
import {
  INSTANCE_ID,
  operationClient,
  operationFixture,
  SESSION_ID,
  terminalStatus
} from "./http-operation-client-fixture.js";

test("durable retry rejects inconsistent terminality and waits for completion", async () => {
  const reservations: Record<string, unknown>[] = [];
  const events: string[] = [];
  let statusCalls = 0;
  const fetch: OperationFetch = async (input, init) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === HTTP_OPERATION_SESSION_PATH) {
      return Response.json({
        listenerInstanceId: INSTANCE_ID,
        sessionId: SESSION_ID,
        scope: "story",
        capability: "bb".repeat(32),
        idleTimeoutMs: 60_000,
        recoveryWarnings: []
      }, { status: 201 });
    }
    if (pathname === HTTP_OPERATION_RESERVATION_PATH) {
      const reservation = JSON.parse(String(init?.body)) as Record<string, unknown>;
      reservations.push(reservation);
      return Response.json({
        listenerInstanceId: INSTANCE_ID,
        sessionId: SESSION_ID,
        sequence: String(reservations.length),
        ticket: `${SESSION_ID}.${reservations.length}.${"cc".repeat(32)}`,
        lifetime: "local",
        deadlineEpochMs: Date.now() + 2_000,
        startDeadlineEpochMs: Date.now() + 1_000
      }, { status: 201 });
    }
    if (pathname === "/api/operations/status") {
      const [sessionId, sequence] = (
        new Headers(init?.headers).get(HTTP_OPERATION_TICKET_HEADER) ?? ""
      ).split(".");
      statusCalls += 1;
      events.push(`status:${statusCalls}`);
      if (statusCalls === 1) throw new TypeError("temporary status loss");
      return Response.json({
        listenerInstanceId: INSTANCE_ID,
        sessionId,
        sequence,
        state: statusCalls < 5 ? "running" : "completed",
        terminal: statusCalls === 2 || statusCalls >= 5,
        cancelRequested: false
      });
    }
    return Response.json({ ok: true });
  };
  const client = operationClient(fetch);
  let executions = 0;

  assert.equal(await client.run({
    method: "POST",
    path: "/api/stories",
    binding: client.binding,
    requestedLifetimeMs: 2_000,
    expectedAggregateVersion: { kind: "absent" },
    execute: async () => {
      executions += 1;
      events.push(`execute:${executions}`);
      if (executions === 1) throw new TypeError("response lost");
      return "complete";
    },
    shouldRetry: () => true
  }), "complete");

  assert.equal(executions, 2);
  assert.equal(reservations.length, 2);
  assert.equal(reservations[1]!.mutationId, reservations[0]!.mutationId);
  assert.deepEqual(
    reservations.map((reservation) => reservation.expectedAggregateVersion),
    [{ kind: "absent" }, { kind: "absent" }]
  );
  assert.ok(events.indexOf("status:5") < events.indexOf("execute:2"));
});

test("caller-owned mutation identity survives separate run invocations", async () => {
  const reservations: Record<string, unknown>[] = [];
  const client = operationClient(operationFixture(async (pathname, init) => {
    if (pathname === "/api/operations/status") return terminalStatus(init);
    return Response.json({ ok: true });
  }, 2_000, (init) => {
    reservations.push(JSON.parse(String(init?.body)));
  }));
  const mutationId =
    "m1.1767225600000.0123456789abcdef0123456789abcdef";

  for (let invocation = 0; invocation < 2; invocation += 1) {
    assert.equal(await client.run({
      method: "POST",
      path: "/api/stories",
      binding: client.binding,
      mutationId,
      expectedAggregateVersion: { kind: "absent" },
      execute: async () => invocation
    }), invocation);
  }

  assert.deepEqual(
    reservations.map((reservation) => reservation.mutationId),
    [mutationId, mutationId]
  );
});

test("operation admission errors preserve HTTP status and service code", async () => {
  const client = operationClient(async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === HTTP_OPERATION_SESSION_PATH) {
      return Response.json({
        listenerInstanceId: INSTANCE_ID,
        sessionId: SESSION_ID,
        scope: "story",
        capability: "bb".repeat(32),
        idleTimeoutMs: 60_000,
        recoveryWarnings: []
      }, { status: 201 });
    }
    return Response.json(
      { error: "Operation capacity is full", code: "resource_busy" },
      { status: 429 }
    );
  });

  await assert.rejects(client.run({
    method: "POST",
    path: "/api/stories",
    binding: client.binding,
    execute: async () => undefined
  }), (error: unknown) =>
    error instanceof HttpOperationError
      && error.status === 429
      && error.code === "resource_busy");
});

test("terminal operation failure wins a racing lease deadline", async () => {
  const failure = createFailureEnvelope({
    code: "idempotency_conflict",
    message: "The continuation did not match its required boundary.",
    status: 409
  });
  const client = operationClient(operationFixture(async (pathname, init) => {
    if (pathname !== "/api/operations/status") {
      return Response.json({ ok: true });
    }
    const [sessionId, sequence] = (
      new Headers(init?.headers).get(HTTP_OPERATION_TICKET_HEADER) ?? ""
    ).split(".");
    return Response.json({
      listenerInstanceId: INSTANCE_ID,
      sessionId,
      sequence,
      state: "failed",
      terminal: true,
      cancelRequested: true,
      failure
    });
  }, 20));

  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(client.run({
      method: "POST",
      path: "/api/stories/story/continue",
      binding: client.binding,
      requestedLifetimeMs: 20,
      expectedAggregateVersion: {
        kind: "v6",
        revision: "00000000000000000001"
      },
      execute: async (lease) => await new Promise<never>((_resolve, reject) => {
        lease.signal.addEventListener(
          "abort",
          () => reject(lease.signal.reason),
          { once: true }
        );
      })
    }), (error: unknown) => {
      assert.ok(error instanceof HttpOperationError);
      assert.equal(error.code, "idempotency_conflict");
      assert.equal(error.message, failure.message);
      assert.equal(error.failure.timeout, undefined);
      return true;
    });
  } finally {
    clearTimeout(keepAlive);
  }
});

test("operation-first settlement retains its handoff after a long response drain", async () => {
  const controller = new AbortController();
  const failure = createFailureEnvelope({
    code: "revision_conflict",
    message: "The stopped rewrite committed a conflicting terminal result.",
    status: 409
  });
  let drainCompletedAt = 0;
  let statusCalls = 0;
  const client = operationClient(operationFixture(async (pathname, init) => {
    if (pathname === "/api/operations/status") {
      statusCalls += 1;
      assert.ok(drainCompletedAt > 0, "status must start after the response drain");
      const [sessionId, sequence] = (
        new Headers(init?.headers).get(HTTP_OPERATION_TICKET_HEADER) ?? ""
      ).split(".");
      return Response.json({
        listenerInstanceId: INSTANCE_ID,
        sessionId,
        sequence,
        state: "failed",
        terminal: true,
        cancelRequested: true,
        failure
      });
    }
    return Response.json({ ok: true });
  }, 2_000));

  await assert.rejects(client.run({
    method: "POST",
    path: "/api/stories/story/continue",
    binding: client.binding,
    requestedLifetimeMs: 2_000,
    expectedAggregateVersion: {
      kind: "v6",
      revision: "00000000000000000001"
    },
    callerSignal: controller.signal,
    execute: async () => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 550));
      drainCompletedAt = performance.now();
      throw new TypeError("response stream ended after caller stop");
    }
  }), (error: unknown) => {
    assert.ok(error instanceof HttpOperationError);
    assert.equal(error.code, "revision_conflict");
    return true;
  });
  assert.equal(statusCalls, 1);
});

test("operation-first status settlement starts its handoff during a synchronous abort", async () => {
  const controller = new AbortController();
  const shutdown = new AbortController();
  let resolveSecondStatus!: () => void;
  const secondStatusStarted = new Promise<void>((resolve) => {
    resolveSecondStatus = resolve;
  });
  let resolveStatusStopped!: () => void;
  const statusStopped = new Promise<void>((resolve) => {
    resolveStatusStopped = resolve;
  });
  let statusCalls = 0;
  const client = operationClient(operationFixture(async (pathname, init) => {
    if (pathname !== "/api/operations/status") return Response.json({ ok: true });
    statusCalls += 1;
    if (statusCalls === 1) {
      controller.abort();
      return Response.json({
        listenerInstanceId: INSTANCE_ID,
        sessionId: SESSION_ID,
        sequence: "1",
        state: "running",
        terminal: false,
        cancelRequested: true
      });
    }
    resolveSecondStatus();
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        resolveStatusStopped();
        reject(init.signal?.reason);
      }, { once: true });
    });
  }, 2_000), shutdown.signal);
  const lease = await client.reserve({
    method: "POST",
    path: "/api/stories/story/continue",
    binding: client.binding,
    requestedLifetimeMs: 2_000,
    callerSignal: controller.signal,
    expectedAggregateVersion: {
      kind: "v6",
      revision: "00000000000000000001"
    }
  });
  const settlement = lease.settle();

  try {
    await secondStatusStarted;
    await Promise.race([
      statusStopped,
      new Promise<never>((_resolve, reject) => setTimeout(() => {
        reject(new Error("settlement handoff did not start after synchronous abort"));
      }, 750))
    ]);
    assert.equal(statusCalls, 2);
    await settlement;
  } finally {
    shutdown.abort();
    await settlement.catch(() => undefined);
  }
});

test("operation admission errors use the canonical flat payload fallback", async () => {
  const client = operationClient(async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === HTTP_OPERATION_SESSION_PATH) {
      return Response.json({
        listenerInstanceId: INSTANCE_ID,
        sessionId: SESSION_ID,
        scope: "story",
        capability: "bb".repeat(32),
        idleTimeoutMs: 60_000,
        recoveryWarnings: []
      }, { status: 201 });
    }
    return Response.json(
      {
        error: "",
        message: "Operation admission is temporarily unavailable",
        code: "resource_busy"
      },
      { status: 429 }
    );
  });

  await assert.rejects(client.run({
    method: "POST",
    path: "/api/stories",
    binding: client.binding,
    execute: async () => undefined
  }), (error: unknown) =>
    error instanceof HttpOperationError
      && error.message === "Operation admission is temporarily unavailable"
      && error.status === 429
      && error.code === "resource_busy");
});

test("operation admission errors preserve internal diagnostic references", async () => {
  const diagnosticRef = "err_deadbeefdeadbeefdeadbeef";
  const client = operationClient(async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === HTTP_OPERATION_SESSION_PATH) {
      return Response.json({
        listenerInstanceId: INSTANCE_ID,
        sessionId: SESSION_ID,
        scope: "story",
        capability: "bb".repeat(32),
        idleTimeoutMs: 60_000,
        recoveryWarnings: []
      }, { status: 201 });
    }
    return Response.json(
      {
        error: "Internal server error",
        code: "internal",
        diagnosticRef
      },
      { status: 500 }
    );
  });

  await assert.rejects(client.run({
    method: "POST",
    path: "/api/stories",
    binding: client.binding,
    execute: async () => undefined
  }), (error: unknown) =>
    error instanceof HttpOperationError
      && error.diagnosticRef === diagnosticRef);
});

test("operation sessions preserve recovery diagnostic references", async () => {
  const diagnosticRef = "err_deadbeefdeadbeefdeadbeef";
  const providerRecovery = {
    kind: "target" as const,
    providerMutationId:
      "m1.1767225600001.1123456789abcdef0123456789abcdef"
  };
  let recoveredReference: string | undefined;
  let recoveredCode: string | undefined;
  let recoveredProviderContext: unknown;
  const fetch = operationFixture(async (pathname, init) => {
    if (pathname === "/api/operations/status") return terminalStatus(init);
    return Response.json({ ok: true });
  }, 2_000, undefined, [{
    mutationId: "m1.1767225600000.0123456789abcdef0123456789abcdef",
    method: "createStory",
    storyId: null,
    code: "future_warning",
    message: "Future compatible warning",
    status: 500,
    providerRecovery,
    diagnosticRef
  }]);
  const client = operationClient(
    fetch,
    undefined,
    undefined,
    (_scope, session) => {
      const warning = session.recoveryWarnings[0];
      recoveredReference = warning === undefined
        ? undefined
        : warning.diagnosticRef;
      recoveredCode = warning?.code;
      recoveredProviderContext = warning?.providerRecovery;
    }
  );

  await client.run({
    method: "GET",
    path: "/api/stories",
    binding: client.binding,
    execute: async () => undefined
  });

  assert.equal(recoveredReference, diagnosticRef);
  assert.equal(recoveredCode, "future_warning");
  assert.deepEqual(
    recoveredProviderContext,
    providerRecovery
  );
});

test("operation-session creation stops when its only caller cancels", async () => {
  const controller = new AbortController();
  let sessionSignal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const client = operationClient(async (_input, init) => {
    sessionSignal = init?.signal ?? undefined;
    markStarted();
    return await new Promise<Response>((_resolve, reject) => {
      sessionSignal?.addEventListener(
        "abort",
        () => reject(sessionSignal?.reason),
        { once: true }
      );
    });
  });
  const pending = client.reserve({
    method: "GET",
    path: "/api/stories",
    binding: client.binding,
    requestedLifetimeMs: 2_000,
    callerSignal: controller.signal
  });

  await started;
  controller.abort(new Error("caller stopped"));

  await assert.rejects(pending, /caller stopped/);
  assert.equal(sessionSignal?.aborted, true);
});

test("terminal settlement removes caller cancellation authority", async () => {
  const controller = new AbortController();
  let cancelCalls = 0;
  const client = operationClient(operationFixture(async (pathname, init) => {
    if (pathname === "/api/operations/cancel") cancelCalls += 1;
    if (pathname === "/api/operations/status") {
      return terminalStatus(init);
    }
    return Response.json({ ok: true });
  }));

  await client.run({
    method: "GET",
    path: "/api/stories",
    binding: client.binding,
    callerSignal: controller.signal,
    execute: async () => "done"
  });
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(cancelCalls, 0);
});

test("terminal settlement aborts a concurrent cancellation request", async () => {
  const controller = new AbortController();
  let cancelSignal: AbortSignal | undefined;
  let signalCancelStarted!: () => void;
  const cancelStarted = new Promise<void>((resolve) => {
    signalCancelStarted = resolve;
  });
  const client = operationClient(operationFixture(async (pathname, init) => {
    if (pathname === "/api/operations/cancel") {
      cancelSignal = init?.signal ?? undefined;
      signalCancelStarted();
      return await new Promise<Response>((_resolve, reject) => {
        cancelSignal?.addEventListener(
          "abort",
          () => reject(cancelSignal?.reason),
          { once: true }
        );
      });
    }
    if (pathname === "/api/operations/status") return terminalStatus(init);
    return Response.json({ ok: true });
  }));
  const lease = await client.reserve({
    method: "GET",
    path: "/api/stories",
    binding: client.binding,
    requestedLifetimeMs: 2_000,
    callerSignal: controller.signal
  });

  controller.abort();
  await cancelStarted;
  await lease.settle();

  assert.equal(cancelSignal?.aborted, true);
});

test("run settles concurrently with a stalled caller cancellation", async () => {
  const controller = new AbortController();
  const client = operationClient(operationFixture(async (pathname, init) => {
    if (pathname === "/api/operations/cancel") {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true }
        );
      });
    }
    if (pathname === "/api/operations/status") return terminalStatus(init);
    return Response.json({ ok: true });
  }, 2_000));
  const startedAt = performance.now();

  assert.equal(await client.run({
    method: "GET",
    path: "/api/stories",
    binding: client.binding,
    requestedLifetimeMs: 2_000,
    callerSignal: controller.signal,
    execute: async () => {
      controller.abort();
      return "done";
    }
  }), "done");

  assert.ok(performance.now() - startedAt < 250);
});

test("generation cancellation reaches control while the response drains", async () => {
  const controller = new AbortController();
  const events: string[] = [];
  let responseDrained = false;
  let releaseResponse!: () => void;
  const response = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  let markCancelStarted!: () => void;
  const cancelStarted = new Promise<void>((resolve) => {
    markCancelStarted = resolve;
  });
  let markExecutionStarted!: () => void;
  const executionStarted = new Promise<void>((resolve) => {
    markExecutionStarted = resolve;
  });
  const client = operationClient(operationFixture(async (pathname, init) => {
    if (pathname === "/api/operations/cancel") {
      events.push("control");
      markCancelStarted();
      return cancellationStatus(init);
    }
    if (pathname === "/api/operations/status") return terminalStatus(init);
    return Response.json({ ok: true });
  }));
  const pending = client.run({
    method: "POST",
    path: "/api/stories/story/continue",
    binding: client.binding,
    callerSignal: controller.signal,
    execute: async (lease) => {
      markExecutionStarted();
      lease.signal.addEventListener("abort", () => {
        if (!responseDrained) events.push("transport");
      }, {
        once: true
      });
      await response;
      responseDrained = true;
      return null;
    }
  });

  await executionStarted;
  controller.abort();
  await cancelStarted;
  assert.deepEqual(events, ["control"]);
  await new Promise((resolve) => setTimeout(resolve, 225));
  assert.deepEqual(events, ["control"]);
  releaseResponse();

  assert.equal(await pending, null);
  assert.deepEqual(events, ["control"]);
});

test("generation cancellation drains a response after lost control", async () => {
  const controller = new AbortController();
  let responseDrained = false;
  let transportAbortedEarly = false;
  let releaseResponse!: () => void;
  const response = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  let markExecutionStarted!: () => void;
  const executionStarted = new Promise<void>((resolve) => {
    markExecutionStarted = resolve;
  });
  const client = operationClient(operationFixture(async (pathname) => {
    if (pathname === "/api/operations/cancel"
      || pathname === "/api/operations/status") {
      throw new TypeError("operation control unavailable");
    }
    return Response.json({ ok: true });
  }));
  const pending = client.run({
    method: "POST",
    path: "/api/stories/story/continue",
    binding: client.binding,
    callerSignal: controller.signal,
    execute: async (lease) => {
      markExecutionStarted();
      lease.signal.addEventListener("abort", () => {
        if (!responseDrained) transportAbortedEarly = true;
      }, {
        once: true
      });
      await response;
      responseDrained = true;
      return null;
    }
  });

  await executionStarted;
  const startedAt = performance.now();
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 225));
  assert.equal(transportAbortedEarly, false);
  releaseResponse();

  assert.equal(await pending, null);
  assert.ok(performance.now() - startedAt < 1_000);
});

test("status polling loss cannot settle ownership without terminal proof", async () => {
  const startedAt = performance.now();
  let statusFailures = 0;
  const client = operationClient(operationFixture(async (pathname) => {
    if (pathname !== "/api/operations/status") {
      return Response.json({ ok: true });
    }
    if (performance.now() - startedAt
      < HTTP_OPERATION_CANCEL_GRACE_MS + 100) {
      statusFailures += 1;
      throw new TypeError("status transport unavailable");
    }
    return Response.json(
      { error: "operation no longer exists" },
      { status: 410 }
    );
  }, 40));

  await client.run({
    method: "GET",
    path: "/api/stories",
    binding: client.binding,
    execute: async () => "done"
  });

  const durationMs = performance.now() - startedAt;
  assert.ok(durationMs >= HTTP_OPERATION_CANCEL_GRACE_MS);
  assert.ok(durationMs < HTTP_OPERATION_CANCEL_GRACE_MS + 1_000);
  assert.ok(statusFailures > 2);
});

test("a responsive running operation stays owned beyond cancellation grace", async () => {
  const startedAt = performance.now();
  let statusCalls = 0;
  const client = operationClient(operationFixture(async (pathname, init) => {
    if (pathname !== "/api/operations/status") {
      return Response.json({ ok: true });
    }
    statusCalls += 1;
    if (performance.now() - startedAt
      < HTTP_OPERATION_CANCEL_GRACE_MS + 150) {
      const [sessionId, sequence] = (
        new Headers(init?.headers).get(HTTP_OPERATION_TICKET_HEADER) ?? ""
      ).split(".");
      return Response.json({
        listenerInstanceId: INSTANCE_ID,
        sessionId,
        sequence,
        state: "running",
        terminal: false,
        cancelRequested: true
      });
    }
    return terminalStatus(init);
  }, 40));

  await client.run({
    method: "GET",
    path: "/api/stories",
    binding: client.binding,
    execute: async () => "done"
  });

  assert.ok(performance.now() - startedAt
    >= HTTP_OPERATION_CANCEL_GRACE_MS + 100);
  assert.ok(statusCalls > 2);
});

function cancellationStatus(init: RequestInit | undefined): Response {
  const [sessionId, sequence] = (
    new Headers(init?.headers).get(HTTP_OPERATION_TICKET_HEADER) ?? ""
  ).split(".");
  return Response.json({
    listenerInstanceId: INSTANCE_ID,
    sessionId,
    sequence,
    state: "running",
    terminal: false,
    cancelRequested: true
  });
}

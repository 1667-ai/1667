import assert from "node:assert/strict";
import test from "node:test";
import {
  HttpOperationClient,
  HttpOperationError,
  type HttpOperationClientOptions,
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

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "aa".repeat(16);

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
    serverInstanceId: INSTANCE_ID,
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
      serverInstanceId: INSTANCE_ID,
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
    serverInstanceId: INSTANCE_ID,
    execute: async () => undefined
  }), (error: unknown) =>
    error instanceof HttpOperationError
      && error.status === 429
      && error.code === "resource_busy");
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
    serverInstanceId: INSTANCE_ID,
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
    serverInstanceId: INSTANCE_ID,
    execute: async () => undefined
  }), (error: unknown) =>
    error instanceof HttpOperationError
      && error.diagnosticRef === diagnosticRef);
});

test("operation sessions preserve recovery diagnostic references", async () => {
  const diagnosticRef = "err_deadbeefdeadbeefdeadbeef";
  let recoveredReference: string | undefined;
  let recoveredCode: string | undefined;
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
    }
  );

  await client.run({
    method: "GET",
    path: "/api/stories",
    serverInstanceId: INSTANCE_ID,
    execute: async () => undefined
  });

  assert.equal(recoveredReference, diagnosticRef);
  assert.equal(recoveredCode, "future_warning");
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
  const pending = client.reserve(
    "GET",
    "/api/stories",
    INSTANCE_ID,
    2_000,
    controller.signal
  );

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
    serverInstanceId: INSTANCE_ID,
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
  const lease = await client.reserve(
    "GET",
    "/api/stories",
    INSTANCE_ID,
    2_000,
    controller.signal
  );

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
    serverInstanceId: INSTANCE_ID,
    requestedLifetimeMs: 2_000,
    callerSignal: controller.signal,
    execute: async () => {
      controller.abort();
      return "done";
    }
  }), "done");

  assert.ok(performance.now() - startedAt < 250);
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
    serverInstanceId: INSTANCE_ID,
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
    serverInstanceId: INSTANCE_ID,
    execute: async () => "done"
  });

  assert.ok(performance.now() - startedAt
    >= HTTP_OPERATION_CANCEL_GRACE_MS + 100);
  assert.ok(statusCalls > 2);
});

test("listener replacement ends old-session settlement immediately", async () => {
  let statusCalls = 0;
  let responseBodyCanceled = false;
  const client = operationClient(operationFixture(async (pathname) => {
    if (pathname !== "/api/operations/status") {
      return Response.json({ ok: true });
    }
    statusCalls += 1;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("replaced"));
        },
        cancel() {
          responseBodyCanceled = true;
        }
      }),
      {
        status: 401,
        headers: {
          "x-1667-server-instance":
            "22222222-2222-4222-8222-222222222222"
        }
      }
    );
  }, 2_000));
  const lease = await client.reserve(
    "GET",
    "/api/stories",
    INSTANCE_ID,
    2_000
  );
  const startedAt = performance.now();

  await lease.settle();

  assert.equal(statusCalls, 1);
  assert.equal(responseBodyCanceled, true);
  assert.ok(performance.now() - startedAt < 250);
});

test("client shutdown releases settlement polling without terminal proof", async () => {
  const shutdown = new AbortController();
  let statusSignal: AbortSignal | undefined;
  let markStatusStarted!: () => void;
  const statusStarted = new Promise<void>((resolve) => {
    markStatusStarted = resolve;
  });
  const client = operationClient(operationFixture(async (pathname, init) => {
    if (pathname !== "/api/operations/status") {
      return Response.json({ ok: true });
    }
    statusSignal = init?.signal ?? undefined;
    markStatusStarted();
    return await new Promise<Response>((_resolve, reject) => {
      statusSignal?.addEventListener(
        "abort",
        () => reject(statusSignal?.reason),
        { once: true }
      );
    });
  }), shutdown.signal);
  const run = client.run({
    method: "GET",
    path: "/api/stories",
    serverInstanceId: INSTANCE_ID,
    execute: async () => "done"
  });

  await statusStarted;
  shutdown.abort(new Error("TUI exited"));

  assert.equal(await run, "done");
  assert.equal(statusSignal?.aborted, true);
  await assert.rejects(
    client.reserve("GET", "/api/stories", INSTANCE_ID, 2_000),
    /TUI exited/
  );
});

test("proven listener replacement releases settlement after proof loss", async () => {
  let statusCalls = 0;
  let replacementChecks = 0;
  const client = operationClient(operationFixture(async (pathname) => {
    if (pathname !== "/api/operations/status") {
      return Response.json({ ok: true });
    }
    statusCalls += 1;
    throw new Error("old listener proof failed");
  }), undefined, async (previousInstanceId) => {
    replacementChecks += 1;
    assert.equal(previousInstanceId, INSTANCE_ID);
    return true;
  });

  assert.equal(await client.run({
    method: "GET",
    path: "/api/stories",
    serverInstanceId: INSTANCE_ID,
    execute: async () => "done"
  }), "done");
  assert.equal(statusCalls, 1);
  assert.equal(replacementChecks, 1);
});

function operationClient(
  fetch: OperationFetch,
  shutdownSignal?: AbortSignal,
  confirmListenerReplacement?: (previousInstanceId: string) => Promise<boolean>,
  onSession?: HttpOperationClientOptions["onSession"]
): HttpOperationClient {
  return new HttpOperationClient({
    root: "http://127.0.0.1:7373",
    authRecord: {
      schema: 1,
      origin: "http://127.0.0.1:7373",
      instanceId: INSTANCE_ID,
      capabilities: {
        story: "11".repeat(32),
        admin: "22".repeat(32)
      }
    },
    fetch,
    shutdownSignal,
    confirmListenerReplacement,
    onSession
  });
}

function operationFixture(
  control: (
    pathname: string,
    init: RequestInit | undefined
  ) => Promise<Response>,
  lifetimeMs = 2_000,
  onReservation?: (init: RequestInit | undefined) => void,
  recoveryWarnings: unknown[] = []
): OperationFetch {
  let sequence = 0;
  return async (input, init) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === HTTP_OPERATION_SESSION_PATH) {
      return Response.json({
        listenerInstanceId: INSTANCE_ID,
        sessionId: SESSION_ID,
        scope: "story",
        capability: "bb".repeat(32),
        idleTimeoutMs: 60_000,
        recoveryWarnings
      }, { status: 201 });
    }
    if (pathname === HTTP_OPERATION_RESERVATION_PATH) {
      onReservation?.(init);
      sequence += 1;
      return Response.json({
        listenerInstanceId: INSTANCE_ID,
        sessionId: SESSION_ID,
        sequence: String(sequence),
        ticket: `${SESSION_ID}.${sequence}.${"cc".repeat(32)}`,
        lifetime: "local",
        deadlineEpochMs: Date.now() + lifetimeMs,
        startDeadlineEpochMs: Date.now() + Math.min(1_000, lifetimeMs)
      }, { status: 201 });
    }
    return await control(pathname, init);
  };
}

function terminalStatus(init: RequestInit | undefined): Response {
  const [sessionId, sequence] = (
    new Headers(init?.headers).get(HTTP_OPERATION_TICKET_HEADER) ?? ""
  ).split(".");
  return Response.json({
    listenerInstanceId: INSTANCE_ID,
    sessionId,
    sequence,
    state: "completed",
    terminal: true,
    cancelRequested: false
  });
}

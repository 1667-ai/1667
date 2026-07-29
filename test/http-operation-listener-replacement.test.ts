import assert from "node:assert/strict";
import test from "node:test";
import { HttpOperationClient } from "../shared/http-operation-client.js";
import {
  HttpListenerAuthority,
  type OperationFetch
} from "../shared/http-listener-authority.js";
import {
  HTTP_OPERATION_RESERVATION_PATH,
  HTTP_OPERATION_SESSION_PATH
} from "../shared/http-operation-protocol.js";
import {
  INSTANCE_ID,
  operationClient,
  operationFixture,
  replacementBinding,
  REPLACEMENT_INSTANCE_ID,
  terminalStatus
} from "./http-operation-client-fixture.js";

test("durable retry applies returned listener authority atomically", async () => {
  const mutationIds: string[] = [];
  let oldReservations = 0;
  let newReservations = 0;
  let executions = 0;
  const oldFetch = operationFixture(async (pathname) => {
    if (pathname === "/api/operations/status") {
      throw new Error("old listener proof failed");
    }
    return Response.json({ ok: true });
  }, 2_000, (init) => {
    oldReservations += 1;
    mutationIds.push(
      String(JSON.parse(String(init?.body)).mutationId)
    );
  });
  const newFetch = operationFixture(async (pathname, init) => {
    if (pathname === "/api/operations/status") {
      return terminalStatus(init, REPLACEMENT_INSTANCE_ID);
    }
    return Response.json({ ok: true });
  }, 2_000, (init) => {
    newReservations += 1;
    mutationIds.push(
      String(JSON.parse(String(init?.body)).mutationId)
    );
  }, [], REPLACEMENT_INSTANCE_ID, "dd".repeat(16));
  const client = operationClient(
    oldFetch,
    undefined,
    async () => ({
      kind: "rebound",
      binding: replacementBinding(newFetch)
    })
  );

  assert.equal(await client.run({
    method: "POST",
    path: "/api/stories",
    binding: client.binding,
    execute: async () => {
      executions += 1;
      if (executions === 1) throw new TypeError("response lost");
      return "complete";
    },
    shouldRetry: () => true
  }), "complete");

  assert.equal(oldReservations, 1);
  assert.equal(newReservations, 1);
  assert.equal(executions, 2);
  assert.equal(mutationIds[0], mutationIds[1]);
});

test("unsent admission rebinds before the application request", async () => {
  let oldSessions = 0;
  let newReservations = 0;
  let confirmations = 0;
  let executions = 0;
  const oldFixture = operationFixture(async () =>
    Response.json({ ok: true }));
  const oldFetch: OperationFetch = async (input, init) => {
    if (new URL(String(input)).pathname === HTTP_OPERATION_SESSION_PATH) {
      oldSessions += 1;
      throw new TypeError("old listener closed during session creation");
    }
    return await oldFixture(input, init);
  };
  const newFetch = operationFixture(
    async (pathname, init) => pathname === "/api/operations/status"
      ? terminalStatus(init, REPLACEMENT_INSTANCE_ID)
      : Response.json({ ok: true }),
    2_000,
    () => {
      newReservations += 1;
    },
    [],
    REPLACEMENT_INSTANCE_ID,
    "dd".repeat(16)
  );
  const client = operationClient(
    oldFetch,
    undefined,
    async () => {
      confirmations += 1;
      return {
        kind: "rebound",
        binding: replacementBinding(newFetch)
      };
    }
  );

  assert.equal(await client.run({
    method: "GET",
    path: "/api/stories",
    binding: client.binding,
    execute: async () => {
      executions += 1;
      return "complete";
    }
  }), "complete");
  assert.equal(oldSessions, 1);
  assert.equal(confirmations, 1);
  assert.equal(newReservations, 1);
  assert.equal(executions, 1);
});

test("caller cancellation prevents unsent admission recovery", async () => {
  let markSessionStarted!: () => void;
  const sessionStarted = new Promise<void>((resolve) => {
    markSessionStarted = resolve;
  });
  let confirmations = 0;
  let executions = 0;
  const oldFetch: OperationFetch = async (input, init) => {
    assert.equal(
      new URL(String(input)).pathname,
      HTTP_OPERATION_SESSION_PATH
    );
    markSessionStarted();
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(init.signal?.reason),
        { once: true }
      );
    });
  };
  const client = operationClient(
    oldFetch,
    undefined,
    async () => {
      confirmations += 1;
      return {
        kind: "rebound",
        binding: replacementBinding()
      };
    }
  );
  const caller = new AbortController();
  const canceled = new Error("caller canceled");
  const run = client.run({
    method: "GET",
    path: "/api/stories",
    binding: client.binding,
    callerSignal: caller.signal,
    execute: async () => {
      executions += 1;
      return "unexpected";
    }
  });
  await sessionStarted;
  caller.abort(canceled);

  await assert.rejects(run, (error: unknown) => error === canceled);
  assert.equal(confirmations, 0);
  assert.equal(executions, 0);
});

test("caller cancellation aborts active unsent admission recovery", async () => {
  let markConfirmationStarted!: () => void;
  const confirmationStarted = new Promise<void>((resolve) => {
    markConfirmationStarted = resolve;
  });
  let confirmationSignal: AbortSignal | undefined;
  let executions = 0;
  const client = operationClient(
    async () => {
      throw new TypeError("old listener closed during session creation");
    },
    undefined,
    async (_instanceId, signal) => {
      confirmationSignal = signal;
      markConfirmationStarted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(signal.reason),
          { once: true }
        );
      });
      return {
        kind: "rebound",
        binding: replacementBinding()
      };
    }
  );
  const caller = new AbortController();
  const canceled = new Error("caller canceled active admission recovery");
  const run = client.run({
    method: "GET",
    path: "/api/stories",
    binding: client.binding,
    callerSignal: caller.signal,
    execute: async () => {
      executions += 1;
      return "unexpected";
    }
  });
  await confirmationStarted;
  caller.abort(canceled);

  await assert.rejects(run, (error: unknown) => error === canceled);
  assert.equal(confirmationSignal?.aborted, true);
  assert.equal(executions, 0);
});

test("lease keeps its reserved fetch during a concurrent rebound", async () => {
  let oldRequests = 0;
  let newRequests = 0;
  const oldFetch = operationFixture(async (pathname, init) => {
    if (pathname === "/api/operations/status") return terminalStatus(init);
    if (pathname === "/api/stories") {
      oldRequests += 1;
      return Response.json({ listener: "old" });
    }
    return Response.json({ ok: true });
  });
  const newFetch: OperationFetch = async () => {
    newRequests += 1;
    return Response.json({ listener: "new" });
  };
  const authority = new HttpListenerAuthority({
    root: "http://127.0.0.1:7373",
    binding: replacementBinding(oldFetch, INSTANCE_ID),
    confirmReplacement: async () => ({
      kind: "rebound",
      binding: replacementBinding(newFetch)
    })
  });
  const client = new HttpOperationClient({ authority });

  const listener = await client.run({
    method: "GET",
    path: "/api/stories",
    binding: authority.snapshot(),
    beforeSend: async () => {
      await authority.confirmListenerReplacement(INSTANCE_ID);
    },
    execute: async (lease) => {
      const response = await lease.fetch(
        "http://127.0.0.1:7373/api/stories",
        { headers: lease.headers }
      );
      return (await response.json() as { listener: string }).listener;
    }
  });

  assert.equal(listener, "old");
  assert.equal(oldRequests, 1);
  assert.equal(newRequests, 0);
});

test("duplicate rebound outcomes keep the replacement session alive", async () => {
  let markReplacementSessionStarted!: () => void;
  const replacementSessionStarted = new Promise<void>((resolve) => {
    markReplacementSessionStarted = resolve;
  });
  let releaseReplacementSession!: () => void;
  const replacementSessionReleased = new Promise<void>((resolve) => {
    releaseReplacementSession = resolve;
  });
  const oldFetch = operationFixture(async (pathname) => {
    if (pathname === "/api/operations/status") {
      throw new Error("old listener proof failed");
    }
    return Response.json({ ok: true });
  });
  const replacementFixture = operationFixture(
    async (pathname, init) => pathname === "/api/operations/status"
      ? terminalStatus(init, REPLACEMENT_INSTANCE_ID)
      : Response.json({ ok: true }),
    2_000,
    undefined,
    [],
    REPLACEMENT_INSTANCE_ID,
    "ee".repeat(16)
  );
  const replacementFetch: OperationFetch = async (input, init) => {
    if (new URL(String(input)).pathname === HTTP_OPERATION_SESSION_PATH) {
      markReplacementSessionStarted();
      const aborted = new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true }
        );
      });
      await Promise.race([replacementSessionReleased, aborted]);
    }
    return await replacementFixture(input, init);
  };
  let confirmations = 0;
  const client = operationClient(
    oldFetch,
    undefined,
    async () => {
      const confirmation = ++confirmations;
      if (confirmation > 1) {
        await replacementSessionStarted;
      }
      if (confirmation === 3) {
        setImmediate(releaseReplacementSession);
      }
      return {
        kind: "rebound",
        binding: replacementBinding(replacementFetch)
      };
    }
  );
  const retry = async (result: string) => {
    let executions = 0;
    return await client.run({
      method: "POST",
      path: "/api/stories",
      binding: client.binding,
      execute: async () => {
        executions += 1;
        if (executions === 1) throw new TypeError("response lost");
        return result;
      },
      shouldRetry: () => true
    });
  };

  assert.deepEqual(
    await Promise.all([
      retry("first"),
      retry("second"),
      retry("third")
    ]),
    ["first", "second", "third"]
  );
  assert.equal(confirmations, 3);
});

test("stale authority cannot abort a replacement session", async (t) => {
  let markReplacementSessionStarted!: () => void;
  const replacementSessionStarted = new Promise<void>((resolve) => {
    markReplacementSessionStarted = resolve;
  });
  let releaseReplacementSession!: () => void;
  const replacementSessionReleased = new Promise<void>((resolve) => {
    releaseReplacementSession = resolve;
  });
  t.after(releaseReplacementSession);
  let replacementSessionAborted = false;
  const oldFetch = operationFixture(async (pathname, init) =>
    pathname === "/api/operations/status"
      ? terminalStatus(init)
      : Response.json({ ok: true })
  );
  const replacementFixture = operationFixture(
    async (pathname, init) => pathname === "/api/operations/status"
      ? terminalStatus(init, REPLACEMENT_INSTANCE_ID)
      : Response.json({ ok: true }),
    2_000,
    undefined,
    [],
    REPLACEMENT_INSTANCE_ID,
    "ef".repeat(16)
  );
  const replacementFetch: OperationFetch = async (input, init) => {
    if (new URL(String(input)).pathname === HTTP_OPERATION_SESSION_PATH) {
      markReplacementSessionStarted();
      init?.signal?.addEventListener(
        "abort",
        () => {
          replacementSessionAborted = true;
        },
        { once: true }
      );
      await replacementSessionReleased;
    }
    return await replacementFixture(input, init);
  };
  const oldBinding = replacementBinding(oldFetch, INSTANCE_ID);
  const newBinding = replacementBinding(replacementFetch);
  const authority = new HttpListenerAuthority({
    root: "http://127.0.0.1:7373",
    binding: oldBinding,
    confirmReplacement: async () => ({
      kind: "rebound",
      binding: newBinding
    })
  });
  const client = new HttpOperationClient({ authority });
  t.after(() => client.dispose());
  await authority.confirmListenerReplacement(INSTANCE_ID);

  const replacementReservation = client.reserve({
    method: "GET",
    path: "/api/stories",
    binding: newBinding,
    requestedLifetimeMs: 2_000
  });
  await replacementSessionStarted;
  await assert.rejects(
    client.reserve({
      method: "GET",
      path: "/api/stories",
      binding: oldBinding,
      requestedLifetimeMs: 2_000
    }),
    /listener authority changed before session creation/
  );
  assert.equal(replacementSessionAborted, false);

  releaseReplacementSession();
  const lease = await replacementReservation;
  assert.deepEqual(await lease.settle(), { kind: "settled" });
});

test("durable retry stops at a different listener replacement", async () => {
  let executions = 0;
  let reservations = 0;
  const client = operationClient(operationFixture(async (pathname) => {
    if (pathname === "/api/operations/status") {
      throw new Error("old listener proof failed");
    }
    return Response.json({ ok: true });
  }, 2_000, () => {
    reservations += 1;
  }), undefined, async () => ({ kind: "replaced" }));

  await assert.rejects(client.run({
    method: "POST",
    path: "/api/stories",
    binding: client.binding,
    execute: async () => {
      executions += 1;
      throw new TypeError("response lost");
    },
    shouldRetry: () => true
  }), /response lost/);
  assert.equal(executions, 1);
  assert.equal(reservations, 1);
});

test("failed replay admission preserves the uncertain transport error", async () => {
  let reservations = 0;
  const fixture = operationFixture(async (pathname, init) => {
    if (pathname === "/api/operations/status") return terminalStatus(init);
    return Response.json({ ok: true });
  });
  const client = operationClient(async (input, init) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === HTTP_OPERATION_RESERVATION_PATH) {
      reservations += 1;
      if (reservations === 2) {
        return Response.json(
          { error: "Operation admission is not ready", code: "resource_busy" },
          { status: 503 }
        );
      }
    }
    return await fixture(input, init);
  });
  const uncertain = new TypeError("response lost after possible commit");

  await assert.rejects(client.run({
    method: "POST",
    path: "/api/stories",
    binding: client.binding,
    execute: async () => {
      throw uncertain;
    },
    shouldRetry: () => true
  }), (error: unknown) => error === uncertain);
  assert.equal(reservations, 2);
});

test("failed replay guard preserves the uncertain transport error", async () => {
  let guards = 0;
  let executions = 0;
  const fixture = operationFixture(async (pathname, init) => {
    if (pathname === "/api/operations/status") return terminalStatus(init);
    return Response.json({ ok: true });
  });
  const client = operationClient(fixture);
  const uncertain = new TypeError("response lost after possible commit");

  await assert.rejects(client.run({
    method: "POST",
    path: "/api/stories",
    binding: client.binding,
    beforeSend: () => {
      guards += 1;
      if (guards === 2) throw new Error("recovered state requires attention");
    },
    execute: async () => {
      executions += 1;
      throw uncertain;
    },
    shouldRetry: () => true
  }), (error: unknown) => error === uncertain);
  assert.equal(guards, 2);
  assert.equal(executions, 1);
});

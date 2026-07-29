import assert from "node:assert/strict";
import test from "node:test";
import {
  INSTANCE_ID,
  operationClient,
  operationFixture,
  replacementBinding
} from "./http-operation-client-fixture.js";

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
  const lease = await client.reserve({
    method: "GET",
    path: "/api/stories",
    binding: client.binding,
    requestedLifetimeMs: 2_000
  });
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
    binding: client.binding,
    execute: async () => "done"
  });

  await statusStarted;
  shutdown.abort(new Error("TUI exited"));

  assert.equal(await run, "done");
  assert.equal(statusSignal?.aborted, true);
  await assert.rejects(
    client.reserve({
      method: "GET",
      path: "/api/stories",
      binding: client.binding,
      requestedLifetimeMs: 2_000
    }),
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
    return {
      kind: "rebound",
      binding: replacementBinding()
    };
  });

  assert.equal(await client.run({
    method: "GET",
    path: "/api/stories",
    binding: client.binding,
    execute: async () => "done"
  }), "done");
  assert.equal(statusCalls, 1);
  assert.equal(replacementChecks, 1);
});

test("different listener replacement releases settlement after proof loss", async () => {
  let replacementChecks = 0;
  const client = operationClient(operationFixture(async (pathname) => {
    if (pathname !== "/api/operations/status") {
      return Response.json({ ok: true });
    }
    throw new Error("old listener proof failed");
  }), undefined, async () => {
    replacementChecks += 1;
    return { kind: "replaced" };
  });

  assert.equal(await client.run({
    method: "GET",
    path: "/api/stories",
    binding: client.binding,
    execute: async () => "done"
  }), "done");
  assert.equal(replacementChecks, 1);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  HTTP_OPERATION_LIFETIME_MS,
  HTTP_OPERATION_PER_SESSION_CAPACITY,
  HTTP_OPERATION_SCOPE_SESSION_CAPACITY,
  HTTP_OPERATION_SESSION_CAPACITY,
  HTTP_OPERATION_SESSION_CREATION_LIMIT,
  HTTP_OPERATION_SESSION_CREATION_WINDOW_MS,
  HTTP_OPERATION_SESSION_IDLE_MS,
  HTTP_OPERATION_START_DEADLINE_MS,
  HTTP_OPERATION_TERMINAL_RETENTION_MS
} from "../shared/http-operation-protocol.js";
import {
  GenerationCancelledError,
  ServiceError
} from "../server/errors.js";
import { HttpOperationSessionStore } from "../server/http-operation-sessions.js";
import { createFailureEnvelope } from "../shared/failure-envelope.js";
import { assertWithinBudget, cpuBudget, startTiming } from "./performance-budget.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const MUTATION_ID = "m1.1753356800000.22222222222222222222222222222222";

test("HTTP operation sessions reserve monotonic server-owned tickets", async () => {
  let now = 10;
  const store = new HttpOperationSessionStore(INSTANCE_ID, {
    now: () => now,
    epochNow: () => 1_000 + now,
    secret: Buffer.alloc(32, 7)
  });
  const session = store.createSession("story", "11".repeat(32));
  const first = await store.reserve(session.capability, {
    method: "GET",
    path: "/api/stories",
    operation: "listStories"
  });
  const second = await store.reserve(session.capability, {
    method: "POST",
    path: "/api/stories",
    operation: "createStory",
    mutationId: MUTATION_ID,
    expectedAggregateVersion: { kind: "absent" }
  });

  assert.equal(first.sequence, "1");
  assert.equal(second.sequence, "2");
  assert.equal(first.lifetime, "local");
  assert.notEqual(first.ticket, second.ticket);
  assert.throws(
    () => store.begin(session.capability, first.ticket, "POST", "/api/stories"),
    /does not match/
  );

  const running = store.begin(
    session.capability,
    first.ticket,
    "GET",
    "/api/stories"
  );
  assert.equal(running.mutationId, null);
  assert.equal(running.expectedAggregateVersion, null);
  assert.equal(store.status(session.capability, first.ticket).state, "running");
  running.finish({ state: "completed" });
  assert.equal(store.status(session.capability, first.ticket).state, "completed");
  store.acknowledge(session.capability, first.ticket);
  assertServiceCode(
    () => store.status(session.capability, first.ticket),
    410,
    "operation_unknown"
  );
  const mutating = store.begin(
    session.capability,
    second.ticket,
    "POST",
    "/api/stories"
  );
  assert.deepEqual(mutating.expectedAggregateVersion, { kind: "absent" });
  mutating.finish({ state: "completed" });
});

test("HTTP operation reservation expires before service start", async () => {
  let now = 0;
  const store = new HttpOperationSessionStore(INSTANCE_ID, {
    now: () => now,
    epochNow: () => now,
    secret: Buffer.alloc(32, 8)
  });
  const session = store.createSession("story", "11".repeat(32));
  const reservation = await store.reserve(session.capability, {
    method: "GET",
    path: "/api/stories",
    operation: "listStories"
  });
  now = HTTP_OPERATION_START_DEADLINE_MS;

  assertServiceCode(
    () => store.begin(
      session.capability,
      reservation.ticket,
      "GET",
      "/api/stories"
    ),
    408,
    "operation_expired"
  );
  assert.equal(
    store.status(session.capability, reservation.ticket).state,
    "canceled"
  );
});

test("HTTP operation status retains its terminal public failure", async () => {
  const store = new HttpOperationSessionStore(INSTANCE_ID, {
    secret: Buffer.alloc(32, 23)
  });
  const session = store.createSession("story", "11".repeat(32));
  const reservation = await store.reserve(session.capability, {
    method: "POST",
    path: "/api/stories/story/continue",
    operation: "continueStory",
    mutationId: MUTATION_ID,
    expectedAggregateVersion: { kind: "v6", revision: "00000000000000000001" }
  });
  const running = store.begin(
    session.capability,
    reservation.ticket,
    "POST",
    "/api/stories/story/continue"
  );
  const failure = createFailureEnvelope({
    code: "idempotency_conflict",
    message: "The continuation did not match its required boundary.",
    status: 409
  });

  running.finish({ state: "failed", failure });

  assert.deepEqual(
    store.status(session.capability, reservation.ticket).failure,
    failure
  );
});

test("HTTP operation reservation timer terminalizes without later traffic", async () => {
  const terminal: string[] = [];
  const store = new HttpOperationSessionStore(INSTANCE_ID, {
    secret: Buffer.alloc(32, 21),
    lifecycle: {
      kind: "supervised",
      isAdmissionOpen: () => true,
      admit: async () => {},
      terminal: (operation) => terminal.push(operation.sequence),
      hardDeadline: () => {}
    }
  });
  const session = store.createSession("story", "11".repeat(32));
  const reservation = await store.reserve(session.capability, {
    method: "GET",
    path: "/api/stories",
    operation: "listStories",
    requestedLifetimeMs: 1
  });

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(
    store.status(session.capability, reservation.ticket).state,
    "canceled"
  );
  assert.deepEqual(terminal, ["1"]);
  store.acknowledge(session.capability, reservation.ticket);
  assert.equal((await store.reserve(session.capability, {
    method: "GET",
    path: "/api/stories",
    operation: "listStories"
  })).sequence, "2");
  await store.closeAll();
});

test("supervised readiness gates operation sessions and reservations", async () => {
  let admissionOpen = false;
  const store = new HttpOperationSessionStore(INSTANCE_ID, {
    secret: Buffer.alloc(32, 31),
    lifecycle: {
      kind: "supervised",
      isAdmissionOpen: () => admissionOpen,
      admit: async () => {},
      terminal: () => {},
      hardDeadline: () => {}
    }
  });
  assertServiceCode(
    () => store.createSession("story", "11".repeat(32)),
    503,
    "resource_busy"
  );
  admissionOpen = true;
  const session = store.createSession("story", "11".repeat(32));
  admissionOpen = false;
  await assertServiceRejection(
    store.reserve(session.capability, {
      method: "GET",
      path: "/api/stories",
      operation: "listStories"
    }),
    503,
    "resource_busy"
  );
});

test("HTTP reservations clamp lifetimes and reject unusable provider budgets", async () => {
  const store = new HttpOperationSessionStore(INSTANCE_ID, {
    now: () => 100,
    epochNow: () => 1_000,
    secret: Buffer.alloc(32, 13)
  });
  const story = store.createSession("story", "11".repeat(32));
  const local = await store.reserve(story.capability, {
    method: "GET",
    path: "/api/stories",
    operation: "listStories",
    requestedLifetimeMs: 60_000
  });
  assert.equal(
    local.deadlineEpochMs,
    1_000 + HTTP_OPERATION_LIFETIME_MS.local
  );
  await assertServiceRejection(store.reserve(story.capability, {
    method: "POST",
    path: "/api/stories",
    operation: "createStory",
    mutationId: MUTATION_ID
  }), 400, "invalid_request");
  await assertServiceRejection(store.reserve(story.capability, {
    method: "GET",
    path: "/api/stories",
    operation: "listStories",
    expectedAggregateVersion: { kind: "absent" }
  }), 400, "invalid_request");
  await assertServiceRejection(store.reserve(story.capability, {
    method: "POST",
    path: "/api/stories",
    operation: "createStory",
    mutationId: MUTATION_ID,
    expectedAggregateVersion: {
      kind: "v6",
      revision: "00000000000000000000"
    }
  }), 400, "invalid_request");
  await assertServiceRejection(store.reserve(story.capability, {
    method: "POST",
    path: "/api/stories/story/continue",
    operation: "continueStory",
    requestedLifetimeMs: 10_000,
    mutationId: MUTATION_ID,
    expectedAggregateVersion: {
      kind: "v6",
      revision: "00000000000000000001"
    }
  }), 400, "invalid_request");
  await store.closeAll();
});

test("HTTP operation control cannot cross session authority", async () => {
  const store = new HttpOperationSessionStore(INSTANCE_ID, {
    secret: Buffer.alloc(32, 14)
  });
  const first = store.createSession("story", "11".repeat(32));
  const second = store.createSession("story", "22".repeat(32));
  const reservation = await store.reserve(first.capability, {
    method: "GET",
    path: "/api/stories",
    operation: "listStories"
  });
  assertServiceCode(
    () => store.status(second.capability, reservation.ticket),
    400,
    "invalid_request"
  );
  await store.closeAll();
});

test("global operation capacity is atomic across concurrent sessions", async () => {
  let releaseAdmission!: () => void;
  const admission = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  const store = new HttpOperationSessionStore(INSTANCE_ID, {
    capacity: 1,
    secret: Buffer.alloc(32, 15),
    lifecycle: {
      kind: "supervised",
      isAdmissionOpen: () => true,
      admit: async () => await admission,
      terminal: () => {},
      hardDeadline: () => {}
    }
  });
  const first = store.createSession("story", "11".repeat(32));
  const second = store.createSession("story", "22".repeat(32));
  const reserve = (capability: string) => store.reserve(capability, {
    method: "GET",
    path: "/api/stories",
    operation: "listStories"
  });
  const firstAttempt = reserve(first.capability);
  const secondAttempt = reserve(second.capability);
  releaseAdmission();

  await firstAttempt;
  await assertServiceRejection(
    secondAttempt,
    503,
    "resource_busy"
  );
  await store.closeAll();
});

test("HTTP session close waits for authoritative operation settlement", async () => {
  const store = new HttpOperationSessionStore(INSTANCE_ID, {
    secret: Buffer.alloc(32, 15)
  });
  const session = store.createSession("story", "11".repeat(32));
  const reservation = await store.reserve(session.capability, {
    method: "GET",
    path: "/api/stories",
    operation: "listStories"
  });
  const running = store.begin(
    session.capability,
    reservation.ticket,
    "GET",
    "/api/stories"
  );
  let closed = false;
  const close = store.closeSession(session.capability)
    .then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(running.signal.aborted, true);
  running.finish({ state: "canceled" });
  await close;
  assert.equal(closed, true);
});

test("HTTP session creation enforces preallocation rate and global caps", async () => {
  let now = 0;
  const rateStore = new HttpOperationSessionStore(INSTANCE_ID, {
    now: () => now,
    secret: Buffer.alloc(32, 16)
  });
  for (let index = 0; index < HTTP_OPERATION_SESSION_CREATION_LIMIT; index += 1) {
    rateStore.createSession("story", "11".repeat(32));
  }
  assertServiceCode(
    () => rateStore.createSession("story", "11".repeat(32)),
    429,
    "resource_busy"
  );
  await rateStore.closeAll();

  const capacityStore = new HttpOperationSessionStore(INSTANCE_ID, {
    now: () => now,
    secret: Buffer.alloc(32, 17)
  });
  for (let origin = 0; origin < HTTP_OPERATION_SESSION_CAPACITY / 8; origin += 1) {
    const capability = origin.toString(16).padStart(64, "0");
    for (let index = 0; index < 8; index += 1) {
      capacityStore.createSession("story", capability);
    }
  }
  assertServiceCode(
    () => capacityStore.createSession("story", "ff".repeat(32)),
    503,
    "resource_busy"
  );
  await capacityStore.closeAll();
});

test("HTTP session and listener operation capacities reject before allocation", async () => {
  const store = new HttpOperationSessionStore(INSTANCE_ID, {
    capacity: 2,
    secret: Buffer.alloc(32, 18)
  });
  const session = store.createSession("story", "11".repeat(32));
  const reserve = () => store.reserve(session.capability, {
    method: "GET",
    path: "/api/stories",
    operation: "listStories"
  });
  assert.equal((await reserve()).sequence, "1");
  assert.equal((await reserve()).sequence, "2");
  await assertServiceRejection(reserve(), 503, "resource_busy");
  await store.closeAll();

  const sessionStore = new HttpOperationSessionStore(INSTANCE_ID, {
    secret: Buffer.alloc(32, 19)
  });
  const bounded = sessionStore.createSession("story", "11".repeat(32));
  for (let index = 0; index < HTTP_OPERATION_PER_SESSION_CAPACITY; index += 1) {
    await sessionStore.reserve(bounded.capability, {
      method: "GET",
      path: "/api/stories",
      operation: "listStories"
    });
  }
  await assertServiceRejection(sessionStore.reserve(bounded.capability, {
    method: "GET",
    path: "/api/stories",
    operation: "listStories"
  }), 503, "resource_busy");
  await sessionStore.closeAll();
});

test("HTTP per-capability session cap survives creation-window rollover", async () => {
  let now = 0;
  const store = new HttpOperationSessionStore(INSTANCE_ID, {
    now: () => now,
    epochNow: () => now,
    secret: Buffer.alloc(32, 20)
  });
  const origin = "11".repeat(32);
  const running = [];
  for (
    let index = 0;
    index < HTTP_OPERATION_SCOPE_SESSION_CAPACITY;
    index += 1
  ) {
    if (index > 0 && index % HTTP_OPERATION_SESSION_CREATION_LIMIT === 0) {
      now += HTTP_OPERATION_SESSION_CREATION_WINDOW_MS + 1;
    }
    const session = store.createSession("story", origin);
    const mutationId = `m1.1753356800000.${index.toString(16).padStart(32, "0")}`;
    const reservation = await store.reserve(session.capability, {
      method: "POST",
      path: "/api/stories/story/continue",
      operation: "continueStory",
      mutationId,
      expectedAggregateVersion: {
        kind: "v6",
        revision: "00000000000000000001"
      }
    });
    running.push(store.begin(
      session.capability,
      reservation.ticket,
      "POST",
      "/api/stories/story/continue"
    ));
  }
  assertServiceCode(
    () => store.createSession("story", origin),
    503,
    "resource_busy"
  );
  for (const operation of running) operation.finish({ state: "canceled" });
  await store.closeAll();
});

test("HTTP mutation cancellation remains nonterminal until its authoritative settlement", async () => {
  const store = new HttpOperationSessionStore(INSTANCE_ID, {
    secret: Buffer.alloc(32, 9)
  });
  const session = store.createSession("story", "11".repeat(32));
  const reservation = await store.reserve(session.capability, {
    method: "POST",
    path: "/api/stories/story/continue",
    operation: "continueStory",
    mutationId: MUTATION_ID,
    expectedAggregateVersion: {
      kind: "v6",
      revision: "00000000000000000001"
    }
  });
  const running = store.begin(
    session.capability,
    reservation.ticket,
    "POST",
    "/api/stories/story/continue"
  );

  const cancellation = store.cancel(
    session.capability,
    reservation.ticket
  );
  assert.equal(cancellation.state, "running");
  assert.equal(running.signal.aborted, true);
  assert.ok(running.signal.reason instanceof GenerationCancelledError);
  assert.equal(store.status(session.capability, reservation.ticket).terminal, false);
  running.finish({ state: "completed" });
  assert.equal(store.status(session.capability, reservation.ticket).state, "completed");
  assert.equal(
    store.cancel(session.capability, reservation.ticket).state,
    "completed"
  );
});

test("HTTP Aside Stop loses authority when its session closes later", async () => {
  const store = new HttpOperationSessionStore(INSTANCE_ID, {
    secret: Buffer.alloc(32, 24)
  });
  const session = store.createSession("story", "11".repeat(32));
  const reservation = await store.reserve(session.capability, {
    method: "POST",
    path: "/api/stories/story/aside/ask",
    operation: "askAside",
    mutationId: MUTATION_ID,
    expectedAggregateVersion: {
      kind: "v6",
      revision: "00000000000000000001"
    }
  });
  const running = store.begin(
    session.capability,
    reservation.ticket,
    "POST",
    "/api/stories/story/aside/ask"
  );

  store.cancel(session.capability, reservation.ticket);
  assert.equal(running.isUserCancellationAuthoritative(), true);
  assert.ok(running.signal.reason instanceof GenerationCancelledError);

  const close = store.closeSession(session.capability);
  await Promise.resolve();
  assert.equal(running.isUserCancellationAuthoritative(), false);
  // AbortSignal.reason stays at the first Stop. The operation record must not
  // use that immutable value after the later session-close cancellation.
  assert.ok(running.signal.reason instanceof GenerationCancelledError);

  running.finish({ state: "canceled" });
  await close;
});

test("local request cancellation uses a generic server reason", async () => {
  const store = new HttpOperationSessionStore(INSTANCE_ID, {
    secret: Buffer.alloc(32, 22)
  });
  const session = store.createSession("story", "11".repeat(32));
  const reservation = await store.reserve(session.capability, {
    method: "GET",
    path: "/api/stories",
    operation: "listStories"
  });
  const running = store.begin(
    session.capability,
    reservation.ticket,
    "GET",
    "/api/stories"
  );

  const cancellation = store.cancel(
    session.capability,
    reservation.ticket
  );

  assert.equal(cancellation.state, "running");
  assert.equal(running.signal.aborted, true);
  assert.ok(running.signal.reason instanceof Error);
  assert.equal(
    running.signal.reason instanceof GenerationCancelledError,
    false
  );
  running.finish({ state: "canceled" });
  await store.closeAll();
});

test("closed and idle session capabilities authenticate only as terminal", async () => {
  let now = 0;
  const store = new HttpOperationSessionStore(INSTANCE_ID, {
    now: () => now,
    epochNow: () => now,
    secret: Buffer.alloc(32, 10)
  });
  const closed = store.createSession("story", "11".repeat(32));
  await store.closeSession(closed.capability);
  await assertServiceRejection(
    store.reserve(closed.capability, {
      method: "GET",
      path: "/api/stories",
      operation: "listStories"
    }),
    410,
    "operation_session_terminal"
  );

  const idle = store.createSession("admin", "22".repeat(32));
  now = HTTP_OPERATION_SESSION_IDLE_MS;
  await assertServiceRejection(
    store.reserve(idle.capability, {
      method: "GET",
      path: "/api/settings",
      operation: "getSettings"
    }),
    410,
    "operation_session_terminal"
  );
  await assertServiceRejection(
    store.reserve("00".repeat(32), {
      method: "GET",
      path: "/api/stories",
      operation: "listStories"
    }),
    401,
    "unauthorized"
  );
});

test("terminal HTTP operations expire to operation_unknown", async () => {
  let now = 0;
  const store = new HttpOperationSessionStore(INSTANCE_ID, {
    now: () => now,
    epochNow: () => now,
    secret: Buffer.alloc(32, 11)
  });
  const session = store.createSession("story", "11".repeat(32));
  const reservation = await store.reserve(session.capability, {
    method: "GET",
    path: "/api/stories",
    operation: "listStories"
  });
  store.begin(
    session.capability,
    reservation.ticket,
    "GET",
    "/api/stories"
  ).finish({ state: "completed" });
  for (
    now = 59_000;
    now < HTTP_OPERATION_TERMINAL_RETENTION_MS;
    now += 59_000
  ) {
    store.status(session.capability, reservation.ticket);
  }
  now = HTTP_OPERATION_TERMINAL_RETENTION_MS;

  assertServiceCode(
    () => store.status(session.capability, reservation.ticket),
    410,
    "operation_unknown"
  );
});

test("HTTP operation lifecycle keeps 20k local calls within its CPU budget", async (t) => {
  let now = 0;
  const store = new HttpOperationSessionStore(INSTANCE_ID, {
    now: () => now,
    epochNow: () => 1_753_356_800_000 + now,
    secret: Buffer.alloc(32, 12)
  });
  const session = store.createSession("story", "11".repeat(32));
  const read = startTiming();
  for (let index = 0; index < 20_000; index += 1) {
    now += 251;
    const reservation = await store.reserve(session.capability, {
      method: "GET",
      path: "/api/stories",
      operation: "listStories"
    });
    store.begin(
      session.capability,
      reservation.ticket,
      "GET",
      "/api/stories"
    ).finish({ state: "completed" });
    store.acknowledge(session.capability, reservation.ticket);
  }
  // Pure computation, so this budget measures CPU time.
  assertWithinBudget(t, "20k operation lifecycles", cpuBudget(2_000), read());
});

function assertServiceCode(
  work: () => unknown,
  status: number,
  code: string
): void {
  assert.throws(work, (error: unknown) =>
    error instanceof ServiceError
    && error.status === status
    && error.code === code);
}

async function assertServiceRejection(
  work: Promise<unknown>,
  status: number,
  code: string
): Promise<void> {
  await assert.rejects(work, (error: unknown) =>
    error instanceof ServiceError
    && error.status === status
    && error.code === code);
}

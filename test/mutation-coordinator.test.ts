import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { ServiceError } from "../server/errors.js";
import {
  MAX_TRANSPORT_OPERATION_ID_BYTES,
  MUTATION_COORDINATOR_GLOBAL_LIMIT,
  createMutationCoordinator
} from "../server/mutation-coordinator.js";

const HASH_A = "a".repeat(64);

test("settings coordinator validates and freezes the five-field contract", async () => {
  const coordinator = createMutationCoordinator();
  const input = settingsRequest(1);
  const result = await coordinator.runSettings(input, (request) => {
    assert.deepEqual(request, input);
    assert.ok(Object.isFrozen(request));
    assert.ok(Object.isFrozen(request.expectedAggregateVersion));
    return request.expectedAggregateVersion.stateGeneration;
  });
  assert.equal(result, 1);
});

test("settings coordinator rejects malformed or out-of-bounds contracts before admission", async (t) => {
  const valid = settingsRequest(1);
  const { fingerprint: _fingerprint, ...missingFingerprint } = valid;
  const symbolKey = { ...valid, [Symbol("extra")]: true };
  const cases: ReadonlyArray<{ name: string; input: unknown }> = [
    { name: "non-object", input: null },
    { name: "missing field", input: missingFingerprint },
    { name: "unknown field", input: { ...valid, extra: true } },
    { name: "symbol field", input: symbolKey },
    { name: "empty transport operation ID", input: { ...valid, transportOperationId: "" } },
    {
      name: "oversize transport operation ID",
      input: { ...valid, transportOperationId: "é".repeat(MAX_TRANSPORT_OPERATION_ID_BYTES / 2 + 1) }
    },
    { name: "invalid Unicode operation ID", input: { ...valid, transportOperationId: "\ud800" } },
    { name: "legacy mutation ID", input: { ...valid, mutationId: `m1-1767225600000-${"a".repeat(32)}` } },
    { name: "uppercase mutation ID", input: { ...valid, mutationId: mutationId(10).toUpperCase() } },
    { name: "short fingerprint", input: { ...valid, fingerprint: "a".repeat(63) } },
    { name: "uppercase fingerprint", input: { ...valid, fingerprint: "A".repeat(64) } },
    { name: "story scope", input: { ...valid, scope: "story:one" } },
    { name: "non-object version", input: { ...valid, expectedAggregateVersion: null } },
    {
      name: "unknown version field",
      input: { ...valid, expectedAggregateVersion: { kind: "settings", stateGeneration: 1, extra: true } }
    },
    {
      name: "wrong version kind",
      input: { ...valid, expectedAggregateVersion: { kind: "v6", stateGeneration: 1 } }
    },
    {
      name: "zero generation",
      input: { ...valid, expectedAggregateVersion: { kind: "settings", stateGeneration: 0 } }
    },
    {
      name: "negative zero generation",
      input: { ...valid, expectedAggregateVersion: { kind: "settings", stateGeneration: -0 } }
    },
    {
      name: "fractional generation",
      input: { ...valid, expectedAggregateVersion: { kind: "settings", stateGeneration: 1.5 } }
    },
    {
      name: "unsafe generation",
      input: {
        ...valid,
        expectedAggregateVersion: { kind: "settings", stateGeneration: Number.MAX_SAFE_INTEGER + 1 }
      }
    }
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      let called = false;
      await assert.rejects(
        createMutationCoordinator().runSettings(fixture.input, () => {
          called = true;
        }),
        hasServiceError("invalid_request", 400)
      );
      assert.equal(called, false);
    });
  }
});

test("story coordinator validates absent, V5, and V6 versions as one frozen scope contract", async () => {
  const coordinator = createMutationCoordinator();
  const versions = [
    { kind: "absent" },
    { kind: "v5", manifestHash: "b".repeat(64) },
    { kind: "v6", revision: "00000000000000000042" }
  ] as const;
  for (const [index, expectedAggregateVersion] of versions.entries()) {
    const result = await coordinator.runStory({
      transportOperationId: `story-version-${index}`,
      mutationId: mutationId(index),
      fingerprint: HASH_A,
      scope: "story:settings",
      expectedAggregateVersion
    }, (request) => {
      assert.equal(request.scope, "story:settings");
      assert.deepEqual(request.expectedAggregateVersion, expectedAggregateVersion);
      assert.ok(Object.isFrozen(request));
      assert.ok(Object.isFrozen(request.expectedAggregateVersion));
      return request.expectedAggregateVersion.kind;
    });
    assert.equal(result, expectedAggregateVersion.kind);
  }
});

test("story coordinator rejects malformed scope/version pairs before admission", async (t) => {
  const valid = storyRequest(1);
  const cases: ReadonlyArray<{ name: string; input: unknown }> = [
    { name: "settings scope", input: { ...valid, scope: "settings" } },
    { name: "empty story ID", input: { ...valid, scope: "story:" } },
    { name: "noncanonical story ID", input: { ...valid, scope: "story:has/slash" } },
    {
      name: "absent extra field",
      input: { ...valid, expectedAggregateVersion: { kind: "absent", revision: 1 } }
    },
    {
      name: "V5 short hash",
      input: { ...valid, expectedAggregateVersion: { kind: "v5", manifestHash: "a".repeat(63) } }
    },
    {
      name: "V6 numeric revision",
      input: { ...valid, expectedAggregateVersion: { kind: "v6", revision: 1 } }
    },
    {
      name: "V6 zero revision",
      input: { ...valid, expectedAggregateVersion: { kind: "v6", revision: "00000000000000000000" } }
    },
    {
      name: "unknown version",
      input: { ...valid, expectedAggregateVersion: { kind: "legacy", revision: "00000000000000000001" } }
    }
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      let called = false;
      await assert.rejects(
        createMutationCoordinator().runStory(fixture.input, () => {
          called = true;
        }),
        hasServiceError("invalid_request", 400)
      );
      assert.equal(called, false);
    });
  }
});

test("one coordinator admits settings and different stories but conflicts on the same story", async () => {
  const coordinator = createMutationCoordinator();
  const storyHold = deferred();
  const settingsHold = deferred();
  const firstStory = coordinator.runStory(storyRequest(1), async () => {
    await storyHold.promise;
  });
  const settings = coordinator.runSettings(settingsRequest(2), async () => {
    await settingsHold.promise;
  });
  await assert.rejects(
    coordinator.runStory({
      ...storyRequest(3),
      scope: storyRequest(1).scope
    }, () => undefined),
    hasServiceError("resource_busy", 409)
  );
  assert.equal(await coordinator.runStory(storyRequest(4), () => "other"), "other");
  storyHold.resolve();
  settingsHold.resolve();
  await Promise.all([firstStory, settings]);
});

const MAINTENANCE_STORY_ID =
  "st1_n3zxisks5umrl45huvqjyeeku7ifobqn2iljtcnuwh5uf7w6d3aq";

test("read-path story maintenance skips a story a live mutation already claims", async () => {
  const coordinator = createMutationCoordinator();
  const hold = deferred();
  const mutation = coordinator.runStory({
    ...storyRequest(1),
    scope: `story:${MAINTENANCE_STORY_ID}`
  }, async () => {
    await hold.promise;
    return "mutation";
  });

  // Reads recover residue opportunistically. A live claim must skip that
  // sweep, never fail the read that asked for it.
  let swept = false;
  assert.equal(
    await coordinator.runStoryMaintenanceWhenIdle(MAINTENANCE_STORY_ID, () => {
      swept = true;
      return true;
    }),
    null
  );
  assert.equal(swept, false);

  hold.resolve();
  assert.equal(await mutation, "mutation");
  assert.equal(
    await coordinator.runStoryMaintenanceWhenIdle(MAINTENANCE_STORY_ID, () => true),
    true
  );
});

test("maintenance outside a read path still conflicts on a claimed story", async () => {
  const coordinator = createMutationCoordinator();
  const hold = deferred();
  const mutation = coordinator.runStory({
    ...storyRequest(1),
    scope: `story:${MAINTENANCE_STORY_ID}`
  }, async () => {
    await hold.promise;
  });

  await assert.rejects(
    coordinator.runStoryMaintenance(MAINTENANCE_STORY_ID, () => true),
    hasServiceError("resource_busy", 409)
  );

  hold.resolve();
  await mutation;
});

test("same-scope contention rejects immediately and never queues", async () => {
  const coordinator = createMutationCoordinator();
  const hold = deferred();
  const first = coordinator.runSettings(settingsRequest(1), async () => {
    await hold.promise;
    return "first";
  });

  let contenderCalled = false;
  await assert.rejects(
    coordinator.runSettings(settingsRequest(2), () => {
      contenderCalled = true;
      return "second";
    }),
    hasServiceError("resource_busy", 409)
  );
  assert.equal(contenderCalled, false);

  hold.resolve();
  assert.equal(await first, "first");
  assert.equal(await coordinator.runSettings(settingsRequest(3), () => "third"), "third");
});

test("post-admission preparation never runs for malformed or busy contenders", async () => {
  const coordinator = createMutationCoordinator();
  const hold = deferred();
  const first = coordinator.runSettings(settingsRequest(1), async () => {
    await hold.promise;
  });
  let preparationCalls = 0;
  const prepare = () => {
    preparationCalls += 1;
    return { fingerprint: HASH_A, payload: "parsed-document" };
  };

  await assert.rejects(
    coordinator.runAfterSettingsAdmission(
      { ...settingsAdmissionRequest(2), mutationId: "malformed" },
      prepare,
      () => "must not run"
    ),
    hasServiceError("invalid_request", 400)
  );
  await assert.rejects(
    coordinator.runAfterSettingsAdmission(
      settingsAdmissionRequest(2),
      prepare,
      () => "must not run"
    ),
    hasServiceError("resource_busy", 409)
  );
  assert.equal(preparationCalls, 0);

  hold.resolve();
  await first;
  const result = await coordinator.runAfterSettingsAdmission(
    settingsAdmissionRequest(3),
    prepare,
    (request, payload) => {
      assert.equal(payload, "parsed-document");
      assert.equal(request.fingerprint, HASH_A);
      assert.deepEqual(Reflect.ownKeys(request), [
        "transportOperationId",
        "mutationId",
        "fingerprint",
        "scope",
        "expectedAggregateVersion"
      ]);
      assert.ok(Object.isFrozen(request));
      assert.ok(Object.isFrozen(request.expectedAggregateVersion));
      return request.expectedAggregateVersion.stateGeneration;
    }
  );
  assert.equal(result, 3);
  assert.equal(preparationCalls, 1);
});

test("scope remains occupied after cancellation until the handler settles", async () => {
  const coordinator = createMutationCoordinator();
  const controller = new AbortController();
  const entered = deferred();
  const sawAbort = deferred();
  const settle = deferred();
  const first = coordinator.runSettings(settingsRequest(1), async () => {
    entered.resolve();
    controller.signal.addEventListener("abort", () => sawAbort.resolve(), { once: true });
    await settle.promise;
    throw controller.signal.reason;
  });

  await entered.promise;
  controller.abort(new Error("canceled"));
  await sawAbort.promise;
  await assert.rejects(
    coordinator.runSettings(settingsRequest(2), () => "must not run"),
    hasServiceError("resource_busy", 409)
  );

  settle.resolve();
  await assert.rejects(first, /canceled/);
  assert.equal(await coordinator.runSettings(settingsRequest(3), () => "released"), "released");
});

test("rejected handlers release their scope", async () => {
  const coordinator = createMutationCoordinator();
  const failure = new Error("handler failed");
  await assert.rejects(coordinator.runSettings(settingsRequest(1), async () => {
    throw failure;
  }), failure);
  assert.equal(await coordinator.runSettings(settingsRequest(2), () => "recovered"), "recovered");
});

test("four distinct scopes fill the global slots and the fifth never queues", async () => {
  assert.equal(MUTATION_COORDINATOR_GLOBAL_LIMIT, 4);
  const coordinator = createMutationCoordinator();
  const holds = Array.from({ length: MUTATION_COORDINATOR_GLOBAL_LIMIT }, () => deferred());
  const entered = holds.map(() => deferred());
  const active = holds.map((hold, index) => coordinator.runStory(storyRequest(index), async () => {
    entered[index]!.resolve();
    await hold.promise;
    return index;
  }));

  try {
    await Promise.all(entered.map(({ promise }) => promise));
    let fifthCalled = false;
    await assert.rejects(
      coordinator.runStory(storyRequest(MUTATION_COORDINATOR_GLOBAL_LIMIT), () => {
        fifthCalled = true;
        return -1;
      }),
      hasServiceError("resource_busy", 409)
    );
    assert.equal(fifthCalled, false);

    holds[0]!.resolve();
    assert.equal(await active[0], 0);
    assert.equal(
      await coordinator.runStory(storyRequest(MUTATION_COORDINATOR_GLOBAL_LIMIT), () => 4),
      4
    );
  } finally {
    for (const hold of holds) hold.resolve();
    await Promise.allSettled(active);
  }
});

test("settings admission remains bounded across repeated claim/release cycles", {
  timeout: 30_000
}, async (context) => {
  const coordinator = createMutationCoordinator();
  const iterations = 20_000;
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    await coordinator.runSettings(settingsRequest(index + 1), () => undefined);
  }
  const elapsed = performance.now() - startedAt;
  context.diagnostic(`${iterations.toLocaleString()} admissions in ${elapsed.toFixed(1)}ms`);
  assert.ok(elapsed < 10_000, `coordinator admission took ${elapsed.toFixed(1)}ms`);
});

function settingsRequest(stateGeneration: number): {
  transportOperationId: string;
  mutationId: string;
  fingerprint: string;
  scope: "settings";
  expectedAggregateVersion: { kind: "settings"; stateGeneration: number };
} {
  return {
    transportOperationId: `operation-${stateGeneration}`,
    mutationId: mutationId(stateGeneration),
    fingerprint: HASH_A,
    scope: "settings",
    expectedAggregateVersion: { kind: "settings", stateGeneration }
  };
}

function settingsAdmissionRequest(stateGeneration: number): {
  transportOperationId: string;
  mutationId: string;
  scope: "settings";
  expectedAggregateVersion: { kind: "settings"; stateGeneration: number };
} {
  const { fingerprint: _fingerprint, ...admission } = settingsRequest(stateGeneration);
  return admission;
}

function storyRequest(index: number): {
  transportOperationId: string;
  mutationId: string;
  fingerprint: string;
  scope: `story:test-${number}`;
  expectedAggregateVersion: { kind: "v6"; revision: string };
} {
  return {
    transportOperationId: `story-operation-${index}`,
    mutationId: mutationId(index),
    fingerprint: HASH_A,
    scope: `story:test-${index}`,
    expectedAggregateVersion: {
      kind: "v6",
      revision: String(index + 1).padStart(20, "0")
    }
  };
}

function mutationId(index: number): string {
  return `m1.1767225600000.${index.toString(16).padStart(32, "0")}`;
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function hasServiceError(code: string, status: number): (error: unknown) => boolean {
  return (error) => error instanceof ServiceError && error.code === code && error.status === status;
}

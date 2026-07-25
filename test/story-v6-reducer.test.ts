import assert from "node:assert/strict";
import test from "node:test";
import type { StoryManifestV5 } from "../server/story-format.js";
import { StoryFormatError } from "../server/story-format-facts.js";
import { storyIdForMutation } from "../server/story-identity.js";
import type {
  ProviderTerminalOutcome,
  StoryV6Event,
  StoryV6ReducerState
} from "../server/story-v6-events.js";
import { reduceStoryV6 } from "../server/story-v6-reducer.js";
import type {
  DeletedStoryManifestV6,
  LiveStoryManifestV6,
  ProviderPointer,
  StoryManifestV6,
  StorySummaryV6
} from "../server/story-v6-types.js";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const CREATE_ID = "m1.1767225600000.00000000000000000000000000000001";
const LOCAL_ID = "m1.1767225600000.00000000000000000000000000000002";
const PROVIDER_ID = "m1.1767225600000.00000000000000000000000000000003";
const ACK_ID = "m1.1767225600000.00000000000000000000000000000004";
const DELETE_ID = "m1.1767225600000.00000000000000000000000000000005";
const CREATE_STORY_ID = storyIdForMutation(CREATE_ID);
const PROVIDER: ProviderPointer = { mutationId: PROVIDER_ID, fingerprintHash: HASH_B };

test("story V6 reducer: create and import are the only absent transitions", () => {
  for (const kind of ["create-prepared", "import-prepared"] as const) {
    const content = storyContent(CREATE_STORY_ID, kind);
    const summary = storySummary(content, kind);
    const output = reduceStoryV6({ kind: "absent" }, { kind, mutationId: CREATE_ID, content, summary });
    assert.deepEqual(output, {
      format: "1667-story",
      schemaVersion: 6,
      kind: "live",
      id: CREATE_STORY_ID,
      revision: "00000000000000000001",
      previousManifestHash: null,
      content,
      summary,
      unresolvedProvider: null,
      lastTransaction: { receiptKind: "user", mutationId: CREATE_ID, phase: "prepared" }
    });
  }
});

test("story V6 reducer: local prepared replaces content and preserves unresolved provider", () => {
  const input = live(PROVIDER);
  const content = storyContent(input.id, "local");
  const summary = storySummary(content, "local");
  const output = requireManifest(reduceStoryV6(present(input), {
    kind: "local-prepared",
    expectedManifestHash: HASH_A,
    mutationId: LOCAL_ID,
    content,
    summary
  }));

  assert.equal(output.kind, "live");
  if (output.kind !== "live") assert.fail("Expected live output");
  assert.equal(output.revision, "00000000000000000002");
  assert.equal(output.previousManifestHash, HASH_A);
  assert.strictEqual(output.content, content);
  assert.strictEqual(output.summary, summary);
  assert.strictEqual(output.unresolvedProvider, input.unresolvedProvider);
  assert.deepEqual(output.lastTransaction, prepared(LOCAL_ID));
});

test("story V6 reducer: provider started preserves content and installs matching pointers", () => {
  const input = live(null);
  const output = requireLive(reduceStoryV6(present(input), {
    kind: "provider-started",
    expectedManifestHash: HASH_A,
    provider: PROVIDER
  }));

  assert.equal(output.revision, "00000000000000000002");
  assert.equal(output.previousManifestHash, HASH_A);
  assert.strictEqual(output.content, input.content);
  assert.strictEqual(output.summary, input.summary);
  assert.strictEqual(output.unresolvedProvider, PROVIDER);
  assert.deepEqual(output.lastTransaction, {
    receiptKind: "user",
    mutationId: PROVIDER_ID,
    phase: "started"
  });
});

test("story V6 reducer: provider terminal success replaces content while error preserves it", () => {
  const input = live(PROVIDER);
  const content = storyContent(input.id, "provider result");
  const summary = storySummary(content, "provider result");
  const success = requireLive(reduceStoryV6(present(input), terminal({ kind: "success", content, summary })));
  assert.equal(success.revision, "00000000000000000002");
  assert.equal(success.previousManifestHash, HASH_A);
  assert.strictEqual(success.content, content);
  assert.strictEqual(success.summary, summary);
  assert.equal(success.unresolvedProvider, null);
  assert.deepEqual(success.lastTransaction, prepared(PROVIDER_ID));

  const failure = requireLive(reduceStoryV6(present(input), terminal({ kind: "error" })));
  assert.equal(failure.revision, "00000000000000000002");
  assert.equal(failure.previousManifestHash, HASH_A);
  assert.strictEqual(failure.content, input.content);
  assert.strictEqual(failure.summary, input.summary);
  assert.equal(failure.unresolvedProvider, null);
  assert.deepEqual(failure.lastTransaction, prepared(PROVIDER_ID));
});

test("story V6 reducer: acknowledgement clears matching live and deleted pointers", () => {
  for (const input of [live(PROVIDER), deleted(PROVIDER)] as const) {
    const output = requireManifest(reduceStoryV6(present(input), {
      kind: "acknowledge-prepared",
      expectedManifestHash: HASH_A,
      provider: PROVIDER,
      acknowledgementMutationId: ACK_ID
    }));
    assert.equal(output.kind, input.kind);
    assert.equal(output.revision, increment(input.revision));
    assert.equal(output.previousManifestHash, HASH_A);
    assert.equal(output.unresolvedProvider, null);
    assert.deepEqual(output.lastTransaction, prepared(ACK_ID));
    if (input.kind === "live" && output.kind === "live") {
      assert.strictEqual(output.content, input.content);
      assert.strictEqual(output.summary, input.summary);
    }
  }
});

test("story V6 reducer: delete preserves unresolved pointer and removes live payload", () => {
  const input = live(PROVIDER);
  const output = requireManifest(reduceStoryV6(present(input), {
    kind: "delete-prepared",
    expectedManifestHash: HASH_A,
    mutationId: DELETE_ID,
    deletedAt: LATER
  }));
  assert.deepEqual(output, {
    format: "1667-story",
    schemaVersion: 6,
    kind: "deleted",
    id: input.id,
    revision: "00000000000000000002",
    previousManifestHash: HASH_A,
    deletedAt: LATER,
    unresolvedProvider: PROVIDER,
    lastTransaction: prepared(DELETE_ID)
  });
});

test("story V6 reducer: provider failure terminalizes a deleted story", () => {
  const input = deleted(PROVIDER);
  const output = requireManifest(reduceStoryV6(
    present(input),
    terminal({ kind: "error" })
  ));
  assert.deepEqual(output, {
    ...input,
    revision: "00000000000000000003",
    previousManifestHash: HASH_A,
    unresolvedProvider: null,
    lastTransaction: prepared(PROVIDER_ID)
  });
  assert.throws(
    () => reduceStoryV6(
      present(input),
      terminal({
        kind: "success",
        content: storyContent("story-one", "replacement"),
        summary: storySummary(
          storyContent("story-one", "replacement"),
          "replacement"
        )
      })
    ),
    StoryFormatError
  );
});

test("story V6 reducer: exact retry and GC reuse input; eligible reap returns absent", () => {
  for (const input of [live(null), live(PROVIDER), deleted(null), deleted(PROVIDER)]) {
    const state = present(input);
    assert.strictEqual(reduceStoryV6(state, retry("receipt-retry")), input);
    assert.strictEqual(reduceStoryV6(state, retry("receipt-gc")), input);
  }
  assert.equal(reduceStoryV6(present(deleted(null)), retry("physical-reap-after-expiry")), null);
});

test("story V6 reducer: exhaustive state/event legality table fails closed", () => {
  const states = {
    absent: { kind: "absent" } as StoryV6ReducerState,
    "live-clear": present(live(null)),
    "live-pending": present(live(PROVIDER)),
    "deleted-clear": present(deleted(null)),
    "deleted-pending": present(deleted(PROVIDER))
  } as const;
  const legal: Record<keyof typeof states, ReadonlySet<StoryV6Event["kind"]>> = {
    absent: new Set<StoryV6Event["kind"]>(["create-prepared", "import-prepared"]),
    "live-clear": new Set<StoryV6Event["kind"]>([
      "local-prepared", "provider-started", "delete-prepared", "receipt-retry", "receipt-gc"
    ]),
    "live-pending": new Set<StoryV6Event["kind"]>([
      "local-prepared", "provider-terminal-prepared", "acknowledge-prepared", "delete-prepared",
      "receipt-retry", "receipt-gc"
    ]),
    "deleted-clear": new Set<StoryV6Event["kind"]>([
      "receipt-retry", "receipt-gc", "physical-reap-after-expiry"
    ]),
    "deleted-pending": new Set<StoryV6Event["kind"]>([
      "provider-terminal-prepared", "acknowledge-prepared",
      "receipt-retry", "receipt-gc"
    ])
  };
  const eventKinds: StoryV6Event["kind"][] = [
    "create-prepared", "import-prepared", "local-prepared", "provider-started",
    "provider-terminal-prepared", "acknowledge-prepared", "delete-prepared",
    "receipt-retry", "receipt-gc", "physical-reap-after-expiry"
  ];

  for (const [stateName, state] of Object.entries(states)) {
    for (const kind of eventKinds) {
      const operation = () => reduceStoryV6(state, makeEvent(kind));
      if (legal[stateName as keyof typeof states].has(kind)) assert.doesNotThrow(operation, `${stateName} + ${kind}`);
      else assert.throws(operation, StoryFormatError, `${stateName} + ${kind}`);
    }
  }
});

test("story V6 reducer: rejects hash, provider, identity, time, and acknowledgement mismatches", () => {
  for (const kind of ["create-prepared", "import-prepared"] as const) {
    const content = storyContent("story-one", "wrong deterministic identity");
    assert.throws(() => reduceStoryV6({ kind: "absent" }, {
      kind,
      mutationId: CREATE_ID,
      content,
      summary: storySummary(content, "wrong deterministic identity")
    }), /must match/);
  }
  const localEvent = eventOf("local-prepared");
  assert.throws(() => reduceStoryV6(present(live(null)), {
    ...localEvent, expectedManifestHash: HASH_C
  }), /Expected manifest hash/);
  assert.throws(() => reduceStoryV6(present(live(null)), {
    ...localEvent, expectedManifestHash: undefined
  } as unknown as StoryV6Event), /Invalid expected manifest hash/);
  const terminalEvent = eventOf("provider-terminal-prepared");
  assert.throws(() => reduceStoryV6(present(live(PROVIDER)), {
    ...terminalEvent, provider: { ...PROVIDER, fingerprintHash: HASH_C }
  }), /does not match/);
  assert.throws(() => reduceStoryV6(present(live(PROVIDER)), {
    kind: "acknowledge-prepared", expectedManifestHash: HASH_A, provider: PROVIDER,
    acknowledgementMutationId: PROVIDER_ID
  }), /must differ/);
  assert.throws(() => reduceStoryV6(present(live(null)), {
    ...localEvent, content: storyContent("other-story", "bad")
  }), /must match/);
  const deleteEvent = eventOf("delete-prepared");
  assert.throws(() => reduceStoryV6(present(live(null)), {
    ...deleteEvent, deletedAt: "2026-01-01"
  }), /Invalid deletion time/);
});

test("story V6 reducer: every changing existing edge rejects revision overflow", () => {
  const maximum = "18446744073709551615";
  const cases: Array<[StoryManifestV6, StoryV6Event]> = [
    [{ ...live(null), revision: maximum }, makeEvent("local-prepared")],
    [{ ...live(null), revision: maximum }, makeEvent("provider-started")],
    [{ ...live(PROVIDER), revision: maximum }, makeEvent("provider-terminal-prepared")],
    [{ ...deleted(PROVIDER), revision: maximum }, makeEvent("provider-terminal-prepared")],
    [{ ...live(PROVIDER), revision: maximum }, makeEvent("acknowledge-prepared")],
    [{ ...deleted(PROVIDER), revision: maximum }, makeEvent("acknowledge-prepared")],
    [{ ...live(null), revision: maximum }, makeEvent("delete-prepared")]
  ];
  for (const [manifest, event] of cases) {
    assert.throws(() => reduceStoryV6(present(manifest), event), /revision overflow/);
  }
});

test("story V6 reducer: deterministic structural sharing leaves inputs untouched", () => {
  const input = live(PROVIDER);
  const event = makeEvent("local-prepared");
  const inputSnapshot = structuredClone(input);
  const eventSnapshot = structuredClone(event);
  const first = requireLive(reduceStoryV6(present(input), event));
  const second = requireLive(reduceStoryV6(present(input), event));

  assert.deepEqual(first, second);
  assert.deepEqual(input, inputSnapshot);
  assert.deepEqual(event, eventSnapshot);
  assert.strictEqual(first.unresolvedProvider, input.unresolvedProvider);
  if (event.kind !== "local-prepared") assert.fail("Expected local event");
  assert.strictEqual(first.content, event.content);
  assert.strictEqual(first.summary, event.summary);
});

function makeEvent(kind: StoryV6Event["kind"]): StoryV6Event {
  const content = storyContent("story-one", "replacement");
  const summary = storySummary(content, "replacement");
  switch (kind) {
    case "create-prepared":
    case "import-prepared": {
      const creationContent = storyContent(CREATE_STORY_ID, "replacement");
      return {
        kind,
        mutationId: CREATE_ID,
        content: creationContent,
        summary: storySummary(creationContent, "replacement")
      };
    }
    case "local-prepared":
      return { kind, expectedManifestHash: HASH_A, mutationId: LOCAL_ID, content, summary };
    case "provider-started":
      return { kind, expectedManifestHash: HASH_A, provider: PROVIDER };
    case "provider-terminal-prepared":
      return { kind, expectedManifestHash: HASH_A, provider: PROVIDER, outcome: { kind: "error" } };
    case "acknowledge-prepared":
      return { kind, expectedManifestHash: HASH_A, provider: PROVIDER, acknowledgementMutationId: ACK_ID };
    case "delete-prepared":
      return { kind, expectedManifestHash: HASH_A, mutationId: DELETE_ID, deletedAt: LATER };
    case "receipt-retry":
    case "receipt-gc":
    case "physical-reap-after-expiry":
      return { kind, expectedManifestHash: HASH_A };
  }
}

function eventOf<K extends StoryV6Event["kind"]>(kind: K): Extract<StoryV6Event, { kind: K }> {
  return makeEvent(kind) as Extract<StoryV6Event, { kind: K }>;
}

function terminal(outcome: ProviderTerminalOutcome): StoryV6Event {
  return {
    kind: "provider-terminal-prepared",
    expectedManifestHash: HASH_A,
    provider: PROVIDER,
    outcome
  };
}

function retry(
  kind: "receipt-retry" | "receipt-gc" | "physical-reap-after-expiry"
): StoryV6Event {
  return { kind, expectedManifestHash: HASH_A };
}

function present(manifest: StoryManifestV6): StoryV6ReducerState {
  return { kind: "present", manifest, manifestHash: HASH_A };
}

function live(unresolvedProvider: ProviderPointer | null): LiveStoryManifestV6 {
  const content = storyContent("story-one", "original");
  return {
    format: "1667-story",
    schemaVersion: 6,
    kind: "live",
    id: content.id,
    revision: "00000000000000000001",
    previousManifestHash: null,
    content,
    summary: storySummary(content, "original"),
    unresolvedProvider,
    lastTransaction: unresolvedProvider === null ? null : {
      receiptKind: "user",
      mutationId: unresolvedProvider.mutationId,
      phase: "started"
    }
  };
}

function deleted(unresolvedProvider: ProviderPointer | null): DeletedStoryManifestV6 {
  return {
    format: "1667-story",
    schemaVersion: 6,
    kind: "deleted",
    id: "story-one",
    revision: "00000000000000000002",
    previousManifestHash: HASH_C,
    deletedAt: NOW,
    unresolvedProvider,
    lastTransaction: prepared(DELETE_ID)
  };
}

function storyContent(id: string, title: string): StoryManifestV5 {
  return {
    format: "1667-story",
    schemaVersion: 5,
    id,
    title,
    createdAt: NOW,
    updatedAt: NOW,
    activeWordCount: 0,
    nodes: [],
    facts: [],
    activeRootId: null,
    bookmarks: [],
    recentNodeIds: [],
    chapterBreaks: []
  };
}

function storySummary(content: StoryManifestV5, title: string): StorySummaryV6 {
  return {
    id: content.id,
    title,
    updatedAt: content.updatedAt,
    partCount: 0,
    words: "00000000000000000000",
    forked: false,
    lineCount: "00000000000000000000"
  };
}

function prepared(mutationId: string) {
  return { receiptKind: "user" as const, mutationId, phase: "prepared" as const };
}

function requireManifest(value: StoryManifestV6 | null): StoryManifestV6 {
  if (value === null) assert.fail("Expected a manifest");
  return value;
}

function requireLive(value: StoryManifestV6 | null): LiveStoryManifestV6 {
  const manifest = requireManifest(value);
  if (manifest.kind !== "live") assert.fail("Expected a live manifest");
  return manifest;
}

function increment(revision: string): string {
  return (BigInt(revision) + 1n).toString().padStart(20, "0");
}

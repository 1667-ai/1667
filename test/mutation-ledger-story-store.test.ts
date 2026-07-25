import assert from "node:assert/strict";
import test from "node:test";
import {
  hashPreparedMutationRecord,
  hashStartedMutationRecord
} from "../server/mutation-ledger-codec.js";
import type {
  AcknowledgedMutationRecord,
  CompletedMutationRecord,
  MutationId,
  PreparedProviderAcknowledgementRecord,
  PreparedUserMutationRecord,
  StartedMutationRecord
} from "../server/mutation-ledger-types.js";
import {
  HASH_A,
  HASH_B,
  hasCode,
  testStore
} from "./mutation-ledger-store-fixture.js";

const STORY_ID = "story-one";
const AGGREGATE_KEY = `story:${STORY_ID}` as const;
const PROVIDER_ID = "m1.1767225600000.111102030405060708090a0b0c0d0e0f" as MutationId;
const ACK_ID = "m1.1767225600000.222202030405060708090a0b0c0d0e0f" as MutationId;
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);

test("story ledger persists a provider started/prepared/completed chain by direct lookup", async (t) => {
  const { store } = await testStore(t, "1667-story-ledger-");
  const started = startedRecord();
  const prepared = providerPreparedRecord(started);
  const completed = completedRecord(prepared);

  assert.deepEqual(await store.loadStoryReceipt(AGGREGATE_KEY, PROVIDER_ID), emptyReceipt());
  await store.writeStoryRecord(started);
  await store.writeStoryRecord(prepared);
  await store.writeStoryRecord(completed);
  await store.writeStoryRecord(started);
  await store.writeStoryRecord(prepared);
  await store.writeStoryRecord(completed);

  const receipt = await store.loadStoryReceipt(AGGREGATE_KEY, PROVIDER_ID);
  assert.deepEqual(receipt, {
    started,
    prepared,
    completed,
    acknowledged: null
  });
  assert.ok(Object.isFrozen(receipt));
});

test("story ledger keeps provider acknowledgement evidence in its two exact receipts", async (t) => {
  const { store } = await testStore(t, "1667-story-ledger-ack-");
  const started = startedRecord();
  const prepared = acknowledgementPreparedRecord(started);
  const acknowledged = acknowledgedRecord(started, prepared);
  const completed = completedRecord(prepared);

  await store.writeStoryRecord(started);
  await store.writeStoryRecord(prepared);
  await store.writeStoryRecord(acknowledged);
  await store.writeStoryRecord(completed);

  assert.deepEqual(await store.loadStoryReceipt(AGGREGATE_KEY, PROVIDER_ID), {
    started,
    prepared: null,
    completed: null,
    acknowledged
  });
  assert.deepEqual(await store.loadStoryReceipt(AGGREGATE_KEY, ACK_ID), {
    started: null,
    prepared,
    completed,
    acknowledged: null
  });
});

test("story ledger rejects impossible provider record order without publishing later evidence", async (t) => {
  const first = await testStore(t, "1667-story-ledger-order-");
  const started = startedRecord();
  const providerPrepared = providerPreparedRecord(started);
  await assert.rejects(first.store.writeStoryRecord(providerPrepared), hasCode("internal"));
  assert.deepEqual(
    await first.store.loadStoryReceipt(AGGREGATE_KEY, PROVIDER_ID),
    emptyReceipt()
  );

  const second = await testStore(t, "1667-story-ledger-ack-order-");
  const acknowledgementPrepared = acknowledgementPreparedRecord(started);
  await second.store.writeStoryRecord(started);
  await assert.rejects(
    second.store.writeStoryRecord(acknowledgedRecord(started, acknowledgementPrepared)),
    hasCode("internal")
  );
  assert.deepEqual(await second.store.loadStoryReceipt(AGGREGATE_KEY, PROVIDER_ID), {
    started,
    prepared: null,
    completed: null,
    acknowledged: null
  });
});

test("story receipt collector retains ambiguity and removes terminal chains in dependency order", async (t) => {
  const { store } = await testStore(t, "1667-story-ledger-collector-");
  const started = startedRecord();
  await store.writeStoryRecord(started);
  assert.equal(
    await store.collectTerminalStoryReceipt(
      AGGREGATE_KEY,
      PROVIDER_ID,
      Date.parse("2026-07-01T00:00:00.000Z"),
      new Set()
    ),
    false,
    "an unacknowledged provider start is never age-pruned"
  );

  const acknowledgement = acknowledgementPreparedRecord(started);
  await store.writeStoryRecord(acknowledgement);
  await store.writeStoryRecord(acknowledgedRecord(started, acknowledgement));
  await store.writeStoryRecord(completedRecord(acknowledgement));

  assert.equal(
    await store.collectTerminalStoryReceipt(
      AGGREGATE_KEY,
      PROVIDER_ID,
      Date.parse("2026-04-02T00:00:05.000Z"),
      new Set([PROVIDER_ID])
    ),
    false,
    "a manifest-referenced receipt is never collected"
  );
  assert.equal(
    await store.collectTerminalStoryReceipt(
      AGGREGATE_KEY,
      ACK_ID,
      Date.parse("2026-04-02T00:00:05.000Z"),
      new Set()
    ),
    false,
    "the acknowledgement receipt cannot leave its retained original dangling"
  );
  assert.equal(
    await store.collectTerminalStoryReceipt(
      AGGREGATE_KEY,
      PROVIDER_ID,
      Date.parse("2026-03-31T00:00:00.000Z"),
      new Set()
    ),
    false,
    "terminal evidence remains through the complete retry window"
  );
  assert.equal(
    await store.collectTerminalStoryReceipt(
      AGGREGATE_KEY,
      PROVIDER_ID,
      Date.parse("2026-04-02T00:00:05.000Z"),
      new Set()
    ),
    true
  );
  assert.deepEqual(
    await store.loadStoryReceipt(AGGREGATE_KEY, PROVIDER_ID),
    emptyReceipt()
  );
  assert.equal(
    await store.collectTerminalStoryReceipt(
      AGGREGATE_KEY,
      ACK_ID,
      Date.parse("2026-04-02T00:00:05.000Z"),
      new Set()
    ),
    true
  );
  assert.deepEqual(
    await store.loadStoryReceipt(AGGREGATE_KEY, ACK_ID),
    emptyReceipt()
  );
});

function startedRecord(): StartedMutationRecord {
  return {
    schema: 1,
    kind: "started",
    aggregateKey: AGGREGATE_KEY,
    mutationId: PROVIDER_ID,
    fingerprintHash: HASH_C,
    method: "continueStory",
    oldStateHash: HASH_A,
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

function providerPreparedRecord(
  started: StartedMutationRecord
): PreparedUserMutationRecord {
  return {
    schema: 1,
    kind: "prepared",
    purpose: "mutation",
    aggregateKey: AGGREGATE_KEY,
    key: PROVIDER_ID,
    fingerprintHash: started.fingerprintHash,
    method: started.method,
    oldStateHash: HASH_B,
    newStateHash: HASH_D,
    startedRecordHash: hashStartedMutationRecord(started),
    result: storyResult("00000000000000000003"),
    preparedAt: "2026-01-01T00:00:01.000Z"
  };
}

function acknowledgementPreparedRecord(
  started: StartedMutationRecord
): PreparedProviderAcknowledgementRecord {
  return {
    schema: 1,
    kind: "prepared",
    purpose: "provider-acknowledgement",
    aggregateKey: AGGREGATE_KEY,
    key: ACK_ID,
    fingerprintHash: HASH_E,
    method: "acknowledgeUnknownOutcomes",
    oldStateHash: HASH_B,
    newStateHash: HASH_D,
    originalProviderMutationId: PROVIDER_ID,
    originalStartedRecordHash: hashStartedMutationRecord(started),
    result: storyResult("00000000000000000003"),
    preparedAt: "2026-01-01T00:00:02.000Z"
  };
}

function acknowledgedRecord(
  started: StartedMutationRecord,
  acknowledgement: PreparedProviderAcknowledgementRecord
): AcknowledgedMutationRecord {
  return {
    schema: 1,
    kind: "acknowledged",
    aggregateKey: AGGREGATE_KEY,
    mutationId: PROVIDER_ID,
    startedRecordHash: hashStartedMutationRecord(started),
    acknowledgementMutationId: ACK_ID,
    acknowledgementPreparedHash: hashPreparedMutationRecord(acknowledgement),
    acknowledgedAt: "2026-01-01T00:00:03.000Z"
  };
}

function completedRecord(
  prepared: PreparedUserMutationRecord | PreparedProviderAcknowledgementRecord
): CompletedMutationRecord {
  return {
    schema: 1,
    kind: "completed",
    aggregateKey: AGGREGATE_KEY,
    key: prepared.key,
    preparedRecordHash: hashPreparedMutationRecord(prepared),
    completedAt: "2026-01-01T00:00:04.000Z"
  };
}

function storyResult(revision: string) {
  return {
    kind: "story" as const,
    storyId: STORY_ID,
    storyRevision: revision,
    summary: {
      id: STORY_ID,
      title: "Story",
      updatedAt: "2026-01-01T00:00:00.000Z",
      partCount: 0,
      words: "00000000000000000000",
      forked: false,
      lineCount: "00000000000000000000"
    }
  };
}

function emptyReceipt() {
  return {
    started: null,
    prepared: null,
    completed: null,
    acknowledged: null
  };
}

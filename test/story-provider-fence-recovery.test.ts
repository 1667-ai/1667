import { providerOperation } from "./story-mutation-fixtures.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderError,
  ServiceError
} from "../server/errors.js";
import {
  providerRecoveryFromArchive,
  type ArchivedMutationOutboxRecord
} from "../server/mutation-outbox.js";
import { StoryMutationStore } from "../server/story-mutation-store.js";
import {
  MUTATION_INPUT_PROTOCOL_VERSION
} from "../shared/worker-protocol.js";
import type {
  StoryAggregateVersion
} from "../shared/story-aggregate-version.js";
import {
  ACK_MUTATION_ID,
  DELETE_MUTATION_ID,
  FIXED_NOW,
  hasServiceError,
  MUTATION_ID,
  OTHER_FINGERPRINT,
  request,
  requestFor,
  setup,
  STORY_ID,
  THIRD_MUTATION_ID
} from "./story-mutation-fixtures.js";

const BLOCKED_WARNING_ID =
  "m1.1767225600001.1123456789abcdef0123456789abcdef";
const PRE_Q_WARNING_ID =
  "m1-lqu5m2o0-1123456789abcdef0123456789abcdef";

test("recovery follows the provider fence after a newer request is blocked", async (t) => {
  const fixture = await setup(t, "1667-q-provider-fence-recovery-");
  await makeProviderOutcomeUnknown(fixture);
  let current = await fixture.stories.loadVersioned(STORY_ID);
  const warningAggregateVersion = current.aggregateVersion!;
  const providerRecovery = {
    kind: "target" as const,
    providerMutationId: MUTATION_ID
  };
  let providerCalled = false;
  await assert.rejects(
    fixture.mutations.runProviderOperation(
      requestFor(
        BLOCKED_WARNING_ID,
        OTHER_FINGERPRINT,
        warningAggregateVersion
      ),
      "rewriteNode",
      providerOperation(
        async () => {
          providerCalled = true;
          return true;
        },
        () => true
      )
    ),
    hasServiceError("generation_outcome_unknown")
  );
  assert.equal(providerCalled, false);

  const recovering = new StoryMutationStore(
    fixture.stories,
    fixture.coordinator,
    fixture.dataDir,
    {
      ledger: fixture.ledger,
      now: () => FIXED_NOW
    }
  );
  await recovering.init();
  const status = await recovering.getUnknownOutcomeStatus(
    STORY_ID,
    BLOCKED_WARNING_ID,
    providerRecovery
  );
  assert.deepEqual(status, {
    state: "pending",
    pendingProviderMutationId: MUTATION_ID,
    deleted: false,
    aggregateVersion: {
      kind: "v6",
      revision: "00000000000000000002"
    }
  });
  if (status.state !== "pending") assert.fail("Expected pending provider state");
  await recovering.runAcknowledge(
    requestFor(
      ACK_MUTATION_ID,
      "c".repeat(64),
      status.aggregateVersion
    ),
    BLOCKED_WARNING_ID,
    providerRecovery
  );
  const acknowledgement = await fixture.ledger.loadStoryReceipt(
    `story:${STORY_ID}`,
    ACK_MUTATION_ID
  );
  if (acknowledgement.prepared?.purpose !== "provider-acknowledgement") {
    assert.fail("Expected a provider acknowledgement receipt");
  }
  assert.equal(
    acknowledgement.prepared.originalProviderMutationId,
    MUTATION_ID
  );

  current = await fixture.stories.loadVersioned(STORY_ID);
  await assert.rejects(
    recovering.runProviderOperation(
      requestFor(
        THIRD_MUTATION_ID,
        "d".repeat(64),
        current.aggregateVersion!
      ),
      "rewriteNode",
      providerOperation(
        async (_runtime, providerStarted) => {
          providerCalled = true;
          await providerStarted();
          throw new ProviderError("Retry reached the provider", 503);
        },
        () => true
      )
    ),
    (error: unknown) => error instanceof ProviderError
  );
  assert.equal(providerCalled, true);
});

test("a stale warning cannot acknowledge a newer provider fence", async (t) => {
  const fixture = await setup(t, "1667-q-stale-provider-warning-");
  const newerProviderMutationId = BLOCKED_WARNING_ID;
  const staleAcknowledgementMutationId =
    "m1.1767225600003.5123456789abcdef0123456789abcdef";
  await makeProviderOutcomeUnknown(fixture);
  let current = await fixture.stories.loadVersioned(STORY_ID);
  const warningAggregateVersion = current.aggregateVersion!;
  const providerRecovery = {
    kind: "target" as const,
    providerMutationId: MUTATION_ID
  };
  await assert.rejects(
    fixture.mutations.runProviderOperation(
      requestFor(
        BLOCKED_WARNING_ID,
        OTHER_FINGERPRINT,
        warningAggregateVersion
      ),
      "rewriteNode",
      providerOperation(
        async () => assert.fail("Blocked request reached the provider"),
        () => true
      )
    ),
    hasServiceError("generation_outcome_unknown")
  );
  const blockedStatus = await fixture.mutations.getUnknownOutcomeStatus(
    STORY_ID,
    BLOCKED_WARNING_ID,
    providerRecovery
  );
  if (blockedStatus.state !== "pending") {
    assert.fail("Expected pending provider state");
  }
  await fixture.mutations.runAcknowledge(
    requestFor(
      ACK_MUTATION_ID,
      "c".repeat(64),
      blockedStatus.aggregateVersion
    ),
    BLOCKED_WARNING_ID,
    providerRecovery
  );

  current = await fixture.stories.loadVersioned(STORY_ID);
  await assert.rejects(
    fixture.mutations.runProviderOperation(
      requestFor(
        newerProviderMutationId,
        "d".repeat(64),
        current.aggregateVersion!
      ),
      "rewriteNode",
      providerOperation(
        async (_runtime, providerStarted) => {
          await providerStarted();
          throw new ServiceError(
            503,
            "Newer provider reply was lost",
            "internal"
          );
        },
        () => true
      )
    ),
    hasServiceError("internal")
  );

  assert.deepEqual(
    await fixture.mutations.getUnknownOutcomeStatus(
      STORY_ID,
      BLOCKED_WARNING_ID,
      providerRecovery
    ),
    { state: "resolved", deleted: false }
  );
  const newerStatus = await fixture.mutations.getUnknownOutcomeStatus(
    STORY_ID,
    newerProviderMutationId
  );
  if (newerStatus.state !== "pending") {
    assert.fail("Expected the newer provider fence to remain pending");
  }
  await assert.rejects(
    fixture.mutations.runAcknowledge(
      requestFor(
        staleAcknowledgementMutationId,
        "e".repeat(64),
        newerStatus.aggregateVersion
      ),
      BLOCKED_WARNING_ID,
      providerRecovery
    ),
    hasServiceError("conflict")
  );
  assert.equal(
    (
      await fixture.mutations.getUnknownOutcomeStatus(
        STORY_ID,
        newerProviderMutationId
      )
    ).state,
    "pending"
  );
});

test("pre-Q warnings bypass Q ledger lookup", async (t) => {
  const fixture = await setup(t, "1667-q-pre-q-provider-warning-");
  await makeProviderOutcomeUnknown(fixture);
  const current = await fixture.stories.loadVersioned(STORY_ID);
  const warningAggregateVersion = current.aggregateVersion!;

  assert.deepEqual(
    await fixture.mutations.getUnknownOutcomeStatus(
      STORY_ID,
      PRE_Q_WARNING_ID
    ),
    { state: "resolved", deleted: false }
  );

  const legacyRecovery = {
    kind: "legacy" as const,
    warningAggregateVersion
  };
  const status = await fixture.mutations.getUnknownOutcomeStatus(
    STORY_ID,
    PRE_Q_WARNING_ID,
    legacyRecovery
  );
  if (status.state !== "pending") {
    assert.fail("Expected the matching provider fence");
  }
  assert.equal(status.pendingProviderMutationId, MUTATION_ID);
  await fixture.mutations.runAcknowledge(
    requestFor(
      ACK_MUTATION_ID,
      "c".repeat(64),
      status.aggregateVersion
    ),
    PRE_Q_WARNING_ID,
    legacyRecovery
  );
  assert.equal(
    (
      await fixture.mutations.getUnknownOutcomeStatus(
        STORY_ID,
        PRE_Q_WARNING_ID,
        legacyRecovery
      )
    ).state,
    "resolved"
  );
});

test("legacy archive recovery selects only its matching provider fence", async (t) => {
  const fixture = await setup(t, "1667-q-legacy-provider-warning-");
  const newerProviderMutationId =
    "m1.1767225600002.6123456789abcdef0123456789abcdef";
  const staleAcknowledgementMutationId =
    "m1.1767225600003.7123456789abcdef0123456789abcdef";
  await makeProviderOutcomeUnknown(fixture);
  let current = await fixture.stories.loadVersioned(STORY_ID);
  const warningAggregateVersion = current.aggregateVersion!;
  const legacyRecovery = providerRecoveryFromArchive(
    legacyArchive(warningAggregateVersion)
  );
  if (legacyRecovery === undefined) {
    assert.fail("Expected legacy provider recovery context");
  }
  await assert.rejects(
    fixture.mutations.runProviderOperation(
      requestFor(
        BLOCKED_WARNING_ID,
        OTHER_FINGERPRINT,
        warningAggregateVersion
      ),
      "rewriteNode",
      providerOperation(
        async () => assert.fail("Blocked request reached the provider"),
        () => true
      )
    ),
    hasServiceError("generation_outcome_unknown")
  );

  const blockedStatus = await fixture.mutations.getUnknownOutcomeStatus(
    STORY_ID,
    BLOCKED_WARNING_ID,
    legacyRecovery
  );
  if (blockedStatus.state !== "pending") {
    assert.fail("Expected the original provider fence");
  }
  assert.equal(
    blockedStatus.pendingProviderMutationId,
    MUTATION_ID
  );
  await fixture.mutations.runAcknowledge(
    requestFor(
      ACK_MUTATION_ID,
      "c".repeat(64),
      blockedStatus.aggregateVersion
    ),
    BLOCKED_WARNING_ID,
    legacyRecovery
  );

  current = await fixture.stories.loadVersioned(STORY_ID);
  await assert.rejects(
    fixture.mutations.runProviderOperation(
      requestFor(
        newerProviderMutationId,
        "d".repeat(64),
        current.aggregateVersion!
      ),
      "rewriteNode",
      providerOperation(
        async (_runtime, providerStarted) => {
          await providerStarted();
          throw new ServiceError(
            503,
            "Newer provider reply was lost",
            "internal"
          );
        },
        () => true
      )
    ),
    hasServiceError("internal")
  );

  assert.deepEqual(
    await fixture.mutations.getUnknownOutcomeStatus(
      STORY_ID,
      BLOCKED_WARNING_ID,
      legacyRecovery
    ),
    { state: "resolved", deleted: false }
  );
  const newerStatus = await fixture.mutations.getUnknownOutcomeStatus(
    STORY_ID,
    newerProviderMutationId
  );
  if (newerStatus.state !== "pending") {
    assert.fail("Expected the newer provider fence");
  }
  await assert.rejects(
    fixture.mutations.runAcknowledge(
      requestFor(
        staleAcknowledgementMutationId,
        "e".repeat(64),
        newerStatus.aggregateVersion
      ),
      BLOCKED_WARNING_ID,
      legacyRecovery
    ),
    hasServiceError("conflict")
  );
  assert.equal(
    (
      await fixture.mutations.getUnknownOutcomeStatus(
        STORY_ID,
        newerProviderMutationId
      )
    ).state,
    "pending"
  );
});

test("a provider target survives a pointer-preserving deletion", async (t) => {
  const fixture = await setup(t, "1667-q-deleted-provider-target-");
  await makeProviderOutcomeUnknown(fixture);
  const warningAggregateVersion = (
    await fixture.stories.loadVersioned(STORY_ID)
  ).aggregateVersion!;
  const providerRecovery = {
    kind: "target" as const,
    providerMutationId: MUTATION_ID
  };
  await assert.rejects(
    fixture.mutations.runProviderOperation(
      requestFor(
        BLOCKED_WARNING_ID,
        OTHER_FINGERPRINT,
        warningAggregateVersion
      ),
      "rewriteNode",
      providerOperation(
        async () => assert.fail("Blocked request reached the provider"),
        () => true
      )
    ),
    hasServiceError("generation_outcome_unknown")
  );
  await fixture.mutations.runDelete(requestFor(
    DELETE_MUTATION_ID,
    "d".repeat(64),
    warningAggregateVersion
  ));

  const status = await fixture.mutations.getUnknownOutcomeStatus(
    STORY_ID,
    BLOCKED_WARNING_ID,
    providerRecovery
  );
  assert.equal(status.state, "pending");
  if (status.state !== "pending") assert.fail("Expected pending provider state");
  assert.equal(status.deleted, true);
  const acknowledged = await fixture.mutations.runAcknowledge(
    requestFor(
      ACK_MUTATION_ID,
      "e".repeat(64),
      status.aggregateVersion
    ),
    BLOCKED_WARNING_ID,
    providerRecovery
  );
  assert.equal(acknowledged.story, null);
});

async function makeProviderOutcomeUnknown(
  fixture: Awaited<ReturnType<typeof setup>>
): Promise<void> {
  await assert.rejects(
    fixture.mutations.runProviderOperation(
      request(fixture.v5Hash),
      "autonameStory",
      providerOperation(
        async (_stories, providerStarted) => {
          await providerStarted();
          throw new ServiceError(
            503,
            "Provider reply was lost",
            "internal"
          );
        },
        () => null
      )
    ),
    hasServiceError("internal")
  );
}

function legacyArchive(
  expectedAggregateVersion: StoryAggregateVersion
): ArchivedMutationOutboxRecord {
  return {
    format: "1667-mutation-outbox-archive",
    schemaVersion: 1,
    intent: {
      format: "1667-mutation-outbox",
      schemaVersion: 1,
      mutationId: BLOCKED_WARNING_ID,
      sequence: 1,
      protocolVersion: MUTATION_INPUT_PROTOCOL_VERSION,
      method: "rewriteNode",
      input: { storyId: STORY_ID },
      expectedAggregateVersion,
      createdAt: "2026-01-01T00:00:00.000Z"
    },
    resolution: {
      kind: "plain",
      code: "generation_outcome_unknown",
      message: "The model request stopped.",
      status: 409
    },
    resolvedAt: "2026-01-01T00:00:01.000Z"
  };
}

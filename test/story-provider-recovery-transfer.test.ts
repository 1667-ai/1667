import { providerOperation } from "./story-mutation-fixtures.js";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  ProviderError,
  ProviderRecoveryRequiredError,
  ServiceError
} from "../server/errors.js";
import {
  createMutationCoordinator
} from "../server/mutation-coordinator.js";
import {
  MutationLedgerStore
} from "../server/mutation-ledger-store.js";
import {
  MutationOutbox,
  providerRecoveryFromArchive
} from "../server/mutation-outbox.js";
import {
  MutationReceiptStore
} from "../server/mutation-receipts.js";
import {
  StoryMutationStore
} from "../server/story-mutation-store.js";
import { StoryStore } from "../server/stories.js";
import {
  WorkerRequestCancellation
} from "../server/worker-request-cancellation.js";
import {
  WorkerErrorReporter
} from "../server/worker-error-reporter.js";
import {
  createDurableMutationId
} from "../shared/durable-mutation-id.js";
import {
  MUTATION_INPUT_PROTOCOL_VERSION
} from "../shared/worker-protocol.js";
import {
  decodeWorkerMessage
} from "../tui/src/worker-message.js";
import {
  requestFor,
  setup,
  STORY_ID
} from "./story-mutation-fixtures.js";

test("a blocked provider request preserves its recovery target across a crash", async (t) => {
  const fixture = await setup(
    t,
    "1667-provider-recovery-transfer-"
  );
  const startedAt = Date.now();
  const now = () => new Date(startedAt);
  const providerMutationId = createDurableMutationId(startedAt);
  const warningMutationId = createDurableMutationId(startedAt + 1);
  const editMutationId = createDurableMutationId(startedAt + 2);
  const acknowledgementMutationId = createDurableMutationId(
    startedAt + 3
  );
  const retryMutationId = createDurableMutationId(startedAt + 4);
  const mutations = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    {
      ledger: fixture.ledger,
      now
    }
  );
  await mutations.init();

  await assert.rejects(
    mutations.runProviderOperation(
      requestFor(
        providerMutationId,
        "a".repeat(64),
        {
          kind: "v5",
          manifestHash: fixture.v5Hash
        }
      ),
      "autonameStory",
      providerOperation(
        async (_runtime, providerStarted) => {
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
    hasCode("internal")
  );

  const warningVersion = (
    await fixture.stories.loadVersioned(STORY_ID)
  ).aggregateVersion!;
  const warningInput = {
    storyId: STORY_ID,
    nodeId: "missing",
    instruction: "Retained request"
  };
  const receiptDir = path.join(
    fixture.dataDir,
    "compatibility-mutation-receipts"
  );
  let receipts = new MutationReceiptStore(
    receiptDir,
    async () => {
      throw new Error("A blocked request has no result");
    }
  );
  await receipts.init();
  const outboxDir = path.join(fixture.dataDir, "mutation-outbox");
  const outbox = new MutationOutbox(outboxDir);
  await outbox.init();
  await outbox.enqueue(
    warningMutationId,
    "rewriteNode",
    warningInput,
    warningVersion
  );

  let providerCalled = false;
  const firstError = await captureError(() => receipts.run(
    warningMutationId,
    "rewriteNode",
    warningInput,
    async () => await mutations.runProviderOperation(
      requestFor(
        warningMutationId,
        "b".repeat(64),
        warningVersion
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
    MUTATION_INPUT_PROTOCOL_VERSION,
    () => undefined
  ));
  assertRecoveryTarget(firstError, providerMutationId);
  assert.equal(providerCalled, false);
  assert.equal(
    (await receipts.inspect(warningMutationId))?.state,
    "pending"
  );
  assert.equal((await outbox.list()).length, 1);

  await mutations.runLocal(
    requestFor(
      editMutationId,
      "c".repeat(64),
      warningVersion
    ),
    "renameStory",
    (story) => {
      story.title = "Edited while recovery was retained";
      return undefined;
    }
  );

  const restartedStories = new StoryStore(
    path.join(fixture.dataDir, "stories")
  );
  await restartedStories.init();
  const restartedLedger = new MutationLedgerStore(fixture.dataDir);
  const restartedMutations = new StoryMutationStore(
    restartedStories,
    createMutationCoordinator(),
    fixture.dataDir,
    {
      ledger: restartedLedger,
      now
    }
  );
  await restartedMutations.init();
  receipts = new MutationReceiptStore(
    receiptDir,
    async () => {
      throw new Error("A blocked request has no result");
    }
  );
  await receipts.init();

  const replayError = await captureError(() => receipts.run(
    warningMutationId,
    "rewriteNode",
    warningInput,
    async () => await restartedMutations.runProviderOperation(
      requestFor(
        warningMutationId,
        "b".repeat(64),
        warningVersion
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
    MUTATION_INPUT_PROTOCOL_VERSION,
    () => undefined
  ));
  assertRecoveryTarget(replayError, providerMutationId);
  assert.equal(providerCalled, false);

  const cancellation = new WorkerRequestCancellation(
    true,
    warningMutationId
  );
  cancellation.cancel("deadline");
  const deadlineError = cancellation.failure(replayError).error;
  assertRecoveryTarget(deadlineError, providerMutationId);
  const wireMessage = await WorkerErrorReporter.disabled().workerMessage(
    {
      workerInstanceId: "1".repeat(32),
      sequence: 1n
    },
    deadlineError,
    {
      operation: "rewriteNode",
      mutationId: warningMutationId
    }
  );
  const decoded = decodeWorkerMessage(wireMessage);
  if (decoded?.type !== "error") {
    assert.fail("Expected a worker error message");
  }
  assert.equal(decoded.providerMutationId, providerMutationId);
  assert.equal(
    decoded.failure.code,
    "generation_outcome_unknown"
  );

  const restartedOutbox = new MutationOutbox(outboxDir);
  const archived = await restartedOutbox.archive(
    warningMutationId,
    decoded.failure,
    decoded.providerMutationId
  );
  assert.equal(archived.schemaVersion, 2);
  const recovery = providerRecoveryFromArchive(archived);
  assert.deepEqual(recovery, {
    kind: "target",
    providerMutationId
  });

  const status = await restartedMutations.getUnknownOutcomeStatus(
    STORY_ID,
    warningMutationId,
    recovery
  );
  assert.equal(status.state, "pending");
  if (status.state !== "pending") {
    assert.fail("Expected the original provider request");
  }
  assert.equal(
    status.pendingProviderMutationId,
    providerMutationId
  );
  await restartedMutations.runAcknowledge(
    requestFor(
      acknowledgementMutationId,
      "d".repeat(64),
      status.aggregateVersion
    ),
    warningMutationId,
    recovery
  );

  const currentVersion = (
    await restartedStories.loadVersioned(STORY_ID)
  ).aggregateVersion!;
  await assert.rejects(
    restartedMutations.runProviderOperation(
      requestFor(
        retryMutationId,
        "e".repeat(64),
        currentVersion
      ),
      "autonameStory",
      providerOperation(
        async (_runtime, providerStarted) => {
          providerCalled = true;
          await providerStarted();
          throw new ProviderError("Retry reached provider", 503);
        },
        () => null
      )
    ),
    (error: unknown) => error instanceof ProviderError
  );
  assert.equal(providerCalled, true);
});

async function captureError(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  assert.fail("Expected an error");
}

function assertRecoveryTarget(
  error: unknown,
  providerMutationId: string
): asserts error is ProviderRecoveryRequiredError {
  assert.equal(error instanceof ProviderRecoveryRequiredError, true);
  assert.equal(
    (error as ProviderRecoveryRequiredError).providerMutationId,
    providerMutationId
  );
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error !== null && typeof error === "object"
    && "code" in error
    && (error as { code: unknown }).code === code;
}

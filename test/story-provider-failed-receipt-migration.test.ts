import { providerOperation } from "./story-mutation-fixtures.js";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  ProviderRecoveryRequiredError,
  ServiceError
} from "../server/errors.js";
import {
  createMutationCoordinator
} from "../server/mutation-coordinator.js";
import {
  MutationOutbox
} from "../server/mutation-outbox.js";
import {
  MutationReceiptStore,
  mutationFingerprint
} from "../server/mutation-receipts.js";
import {
  StoryMutationStore
} from "../server/story-mutation-store.js";
import {
  createDurableMutationId
} from "../shared/durable-mutation-id.js";
import {
  PRE_DIAGNOSTIC_WORKER_PROTOCOL_VERSION
} from "../shared/worker-protocol.js";
import {
  requestFor,
  setup,
  STORY_ID
} from "./story-mutation-fixtures.js";

for (const alreadyArchived of [false, true]) {
  test(
    `failed provider warning receipt recovers exact target${
      alreadyArchived ? " over a schema-version-1 archive" : ""
    }`,
    async (t) => {
      const fixture = await setup(
        t,
        "1667-provider-failed-receipt-migration-"
      );
      const startedAt = Date.now();
      const providerMutationId = createDurableMutationId(startedAt);
      const warningMutationId = createDurableMutationId(startedAt + 1);
      const mutations = new StoryMutationStore(
        fixture.stories,
        createMutationCoordinator(),
        fixture.dataDir,
        {
          ledger: fixture.ledger,
          now: () => new Date(startedAt)
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
              throw new ServiceError(503, "Lost provider reply", "internal");
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
      const outboxDir = path.join(fixture.dataDir, "mutation-outbox");
      const outbox = new MutationOutbox(outboxDir);
      await outbox.init();
      await outbox.enqueue(
        warningMutationId,
        "rewriteNode",
        warningInput,
        warningVersion
      );
      const [enqueuedIntent] = await outbox.list();
      assert.notEqual(enqueuedIntent, undefined);
      const legacyIntent = {
        ...enqueuedIntent!,
        protocolVersion: PRE_DIAGNOSTIC_WORKER_PROTOCOL_VERSION
      };
      await writeFile(
        path.join(outboxDir, `${warningMutationId}.json`),
        `${JSON.stringify(legacyIntent)}\n`
      );
      const receiptDir = path.join(
        fixture.dataDir,
        "compatibility-mutation-receipts"
      );
      const receipts = new MutationReceiptStore(
        receiptDir,
        async () => {
          throw new Error("A blocked request has no result");
        }
      );
      await receipts.init();
      await writeFile(
        path.join(receiptDir, `${warningMutationId}.json`),
        `${JSON.stringify({
          format: "1667-mutation",
          schemaVersion: 1,
          mutationId: warningMutationId,
          protocolVersion: PRE_DIAGNOSTIC_WORKER_PROTOCOL_VERSION,
          fingerprint: mutationFingerprint(
            "rewriteNode",
            warningInput,
            PRE_DIAGNOSTIC_WORKER_PROTOCOL_VERSION
          ),
          method: "rewriteNode",
          state: "failed",
          createdAt: new Date(startedAt).toISOString(),
          failure: {
            kind: "plain",
            code: "generation_outcome_unknown",
            message: "The model request stopped. You can try again.",
            status: 409
          }
        })}\n`
      );
      if (alreadyArchived) {
        const archiveDir = path.join(
          fixture.dataDir,
          "mutation-outbox-archive"
        );
        await mkdir(archiveDir);
        await writeFile(
          path.join(archiveDir, `${warningMutationId}.json`),
          `${JSON.stringify({
            format: "1667-mutation-outbox-archive",
            schemaVersion: 1,
            intent: legacyIntent,
            resolution: {
              kind: "plain",
              code: "generation_outcome_unknown",
              message: "The model request stopped. You can try again.",
              status: 409
            },
            resolvedAt: new Date(startedAt + 2).toISOString()
          })}\n`
        );
      }

      let providerCalled = false;
      const replayError = await captureError(() => receipts.run(
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
        PRE_DIAGNOSTIC_WORKER_PROTOCOL_VERSION,
        () => undefined
      ));
      assert.equal(
        replayError instanceof ProviderRecoveryRequiredError,
        true
      );
      assert.equal(
        (replayError as ProviderRecoveryRequiredError)
          .providerMutationId,
        providerMutationId
      );
      assert.equal(providerCalled, false);

      const archived = await outbox.archive(
        warningMutationId,
        {
          kind: "plain",
          code: "generation_outcome_unknown",
          message: "The model request stopped. You can try again.",
          status: 409
        },
        providerMutationId
      );
      assert.equal(archived.schemaVersion, 2);
      assert.deepEqual(archived.providerRecovery, {
        kind: "target",
        providerMutationId
      });
      assert.deepEqual(await outbox.list(), []);
      assert.equal((await outbox.listArchived())[0]?.schemaVersion, 2);
    }
  );
}

test("failed pre-Q provider receipts remain non-executable", async (t) => {
  const fixture = await setup(
    t,
    "1667-provider-failed-pre-q-receipt-"
  );
  const mutationId =
    `m1-${Date.now().toString(36)}-${"c".padStart(32, "0")}`;
  const input = { id: STORY_ID };
  const receiptDir = path.join(
    fixture.dataDir,
    "compatibility-mutation-receipts"
  );
  const receipts = new MutationReceiptStore(
    receiptDir,
    async () => {
      throw new Error("A blocked request has no result");
    }
  );
  await receipts.init();
  await writeFile(
    path.join(receiptDir, `${mutationId}.json`),
    `${JSON.stringify({
      format: "1667-mutation",
      schemaVersion: 1,
      mutationId,
      protocolVersion: PRE_DIAGNOSTIC_WORKER_PROTOCOL_VERSION,
      fingerprint: mutationFingerprint(
        "autonameStory",
        input,
        PRE_DIAGNOSTIC_WORKER_PROTOCOL_VERSION
      ),
      method: "autonameStory",
      state: "failed",
      createdAt: new Date().toISOString(),
      failure: {
        kind: "plain",
        code: "generation_outcome_unknown",
        message: "The model request stopped. You can try again.",
        status: 409
      }
    })}\n`
  );

  let providerCalled = false;
  const recoveryError = await captureError(() => receipts.run(
    mutationId,
    "autonameStory",
    input,
    async (plan) => {
      if (plan.generationAction(false) === "execute") {
        providerCalled = true;
      }
      return null;
    },
    PRE_DIAGNOSTIC_WORKER_PROTOCOL_VERSION,
    () => undefined
  ));

  assert.equal(
    recoveryError instanceof ProviderRecoveryRequiredError,
    true
  );
  assert.equal(
    (recoveryError as ProviderRecoveryRequiredError).providerMutationId,
    mutationId
  );
  assert.equal(providerCalled, false);
});

async function captureError(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  assert.fail("Expected an error");
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error !== null && typeof error === "object"
    && "code" in error
    && (error as { code: unknown }).code === code;
}

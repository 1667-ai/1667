import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ServiceError } from "../../server/errors.js";
import { createMutationCoordinator } from "../../server/mutation-coordinator.js";
import { MutationOutbox } from "../../server/mutation-outbox.js";
import {
  MutationReceiptStore,
  mutationFingerprint
} from "../../server/mutation-receipts.js";
import { StoryMutationStore } from "../../server/story-mutation-store.js";
import { StoryService } from "../../server/story-service.js";
import { createDurableMutationId } from "../../shared/durable-mutation-id.js";
import {
  PRE_DIAGNOSTIC_WORKER_PROTOCOL_VERSION
} from "../../shared/worker-protocol.js";
import {
  requestFor,
  setup,
  STORY_ID
} from "../../test/story-mutation-fixtures.js";
import { createWorkerStoryApi } from "../src/worker-api.js";

test("startup upgrades an active legacy warning before publication", async () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  const fixture = await setup(
    {
      after: (cleanup) => {
        cleanups.push(cleanup as () => void | Promise<void>);
      }
    },
    "1667-worker-provider-warning-upgrade-"
  );
  const startedAt = Date.now();
  const providerMutationId = createDurableMutationId(startedAt);
  const warningMutationId = createDurableMutationId(startedAt + 1);
  const editMutationId = createDurableMutationId(startedAt + 2);
  let backend: Awaited<ReturnType<typeof createWorkerStoryApi>> | null = null;
  try {
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
    expect(await rejection(mutations.runProvider(
      requestFor(
        providerMutationId,
        "a".repeat(64),
        {
          kind: "v5",
          manifestHash: fixture.v5Hash
        }
      ),
      "autonameStory",
      async (_runtime, providerStarted) => {
        await providerStarted();
        throw new ServiceError(
          503,
          "Provider reply was lost",
          "internal"
        );
      },
      () => null
    ))).toMatchObject({ code: "internal" });

    const warningVersion = (
      await fixture.stories.loadVersioned(STORY_ID)
    ).aggregateVersion!;
    const warningInput = {
      storyId: STORY_ID,
      nodeId: "missing",
      body: {
        start: 0,
        end: 0,
        expected: "x",
        instruction: "Retained request"
      }
    };
    const outbox = new MutationOutbox(
      path.join(fixture.dataDir, "mutation-outbox")
    );
    await outbox.init();
    await outbox.enqueue(
      warningMutationId,
      "rewriteNode",
      warningInput,
      warningVersion
    );
    const [enqueuedIntent] = await outbox.list();
    if (enqueuedIntent === undefined) {
      throw new Error("Expected retained intent");
    }
    const legacyIntent = {
      ...enqueuedIntent,
      protocolVersion: PRE_DIAGNOSTIC_WORKER_PROTOCOL_VERSION
    };
    await writeFile(
      path.join(
        fixture.dataDir,
        "mutation-outbox",
        `${warningMutationId}.json`
      ),
      `${JSON.stringify(legacyIntent)}\n`
    );
    const receiptDir = path.join(fixture.dataDir, "mutation-receipts");
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
    await mutations.runLocal(
      requestFor(
        editMutationId,
        "c".repeat(64),
        warningVersion
      ),
      "renameStory",
      (story) => {
        story.title = "Edited while recovery was retained";
      }
    );

    const machineDir = path.join(fixture.dataDir, "machine");
    await mkdir(machineDir, { mode: 0o700 });
    backend = await createWorkerStoryApi({
      dataDir: fixture.dataDir,
      machineDir
    });
    const warnings = await backend.recovery;

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      mutationId: warningMutationId,
      providerRecovery: {
        kind: "target",
        providerMutationId
      },
      resolution: "archived",
      error: { code: "generation_outcome_unknown" }
    });
    expect(await outbox.list()).toEqual([]);
    expect((await outbox.listArchived())[0]).toMatchObject({
      schemaVersion: 2,
      providerRecovery: {
        kind: "target",
        providerMutationId
      }
    });
    const recovered = await backend.api.acknowledgeUnknownOutcomes(
      STORY_ID,
      warningMutationId,
      warnings[0]!.providerRecovery
    );
    expect(recovered?.title).toBe(
      "Edited while recovery was retained"
    );
  } finally {
    await backend?.dispose();
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
});

test("startup archives provider replay errors without blocking", async () => {
  const dataDir = await mkdtemp(path.join(
    tmpdir(),
    "1667-worker-replay-warning-"
  ));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  let story = await service.createStory("Replay warning");
  story = await service.createNode(story.id, {
    parentId: null,
    text: "A detailed opening."
  });
  await service.dispose();

  const timestamp = Date.now().toString(36);
  const uncertainId = createDurableMutationId();
  const uncertainInput = {
    id: story.id,
    expectedTitle: story.title
  };
  await writeFile(
    path.join(
      dataDir,
      "mutation-receipts",
      `${uncertainId}.json`
    ),
    `${JSON.stringify({
      format: "1667-mutation",
      schemaVersion: 1,
      mutationId: uncertainId,
      fingerprint: mutationFingerprint(
        "autonameStory",
        uncertainInput
      ),
      method: "autonameStory",
      state: "provider_started",
      createdAt: new Date().toISOString()
    })}\n`
  );
  const outbox = new MutationOutbox(
    path.join(dataDir, "mutation-outbox")
  );
  await outbox.init();
  await outbox.enqueue(
    uncertainId,
    "autonameStory",
    uncertainInput
  );
  const terminalId =
    `m1-${timestamp}-${"4".padStart(32, "0")}`;
  await outbox.enqueue(
    terminalId,
    "renameStory",
    { id: story.id }
  );

  const backend = await createWorkerStoryApi({ dataDir });
  try {
    await backend.recovery;
    expect(backend.recoveryWarnings).toHaveLength(2);
    expect(
      backend.recoveryWarnings.map(({ error }) => error.code)
    ).toEqual([
      "generation_outcome_unknown",
      "invalid_request"
    ]);
    expect(
      backend.recoveryWarnings.map(({ resolution }) => resolution)
    ).toEqual(["archived", "cleared"]);
    expect(
      (await backend.api.listStories()).map(({ id }) => id)
    ).toContain(story.id);
    expect(await outbox.list()).toEqual([]);
    expect(JSON.parse(await readFile(
      path.join(
        dataDir,
        "mutation-outbox-archive",
        `${uncertainId}.json`
      ),
      "utf8"
    ))).toMatchObject({
      format: "1667-mutation-outbox-archive",
      schemaVersion: 2,
      intent: {
        mutationId: uncertainId,
        method: "autonameStory"
      },
      resolution: {
        code: "generation_outcome_unknown"
      },
      providerRecovery: {
        kind: "target",
        providerMutationId: uncertainId
      }
    });
  } finally {
    await backend.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected rejection");
}

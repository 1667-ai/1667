import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  realpath,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDurableMutationId
} from "../shared/durable-mutation-id.js";
import { ServiceError } from "../server/errors.js";
import {
  InternalErrorReporter
} from "../server/internal-error-reporter.js";
import {
  internalErrorLogPath
} from "../server/internal-error-log.js";
import {
  createMutationCoordinator
} from "../server/mutation-coordinator.js";
import {
  MutationLedgerStore
} from "../server/mutation-ledger-store.js";
import { MutationOutbox } from "../server/mutation-outbox.js";
import {
  StoryMutationStore
} from "../server/story-mutation-store.js";
import { StoryService } from "../server/story-service.js";
import { StoryStore } from "../server/stories.js";

test("provider fence recovery records why dispatch did not start", async (t) => {
  const dataDir = await mkdtemp(path.join(
    tmpdir(),
    "1667-provider-fence-recovery-log-"
  ));
  const machineDir = await realpath(
    await mkdtemp(path.join(
      tmpdir(),
      "1667-provider-fence-recovery-machine-"
    ))
  );
  t.after(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(machineDir, { recursive: true, force: true });
  });

  const seed = StoryService.withoutDiagnostics({ dataDir });
  await seed.init();
  const story = await seed.createStory("Private story text sentinel");
  await seed.dispose();

  const stories = new StoryStore(path.join(dataDir, "stories"));
  await stories.init();
  const ledger = new MutationLedgerStore(dataDir);
  const mutations = new StoryMutationStore(
    stories,
    createMutationCoordinator(),
    dataDir,
    { ledger }
  );
  await mutations.init();
  const loaded = await stories.loadVersioned(story.id);
  assert.notEqual(loaded.aggregateVersion, null);
  const providerMutationCreatedAt = Date.now();
  const pendingProviderMutationId = createDurableMutationId(
    providerMutationCreatedAt
  );
  await assert.rejects(
    mutations.runProvider(
      {
        transportOperationId: "provider-fence-fixture",
        mutationId: pendingProviderMutationId,
        fingerprint: "a".repeat(64),
        scope: `story:${story.id}`,
        expectedAggregateVersion: loaded.aggregateVersion!
      },
      "autonameStory",
      async (_runtime, providerStarted) => {
        await providerStarted();
        throw new ServiceError(
          503,
          "Private provider failure sentinel",
          "internal"
        );
      },
      () => null
    ),
    hasCode("internal")
  );

  const warningMutationId = createDurableMutationId(
    providerMutationCreatedAt + 1
  );
  const current = await stories.loadVersioned(story.id);
  const outbox = new MutationOutbox(
    path.join(dataDir, "mutation-outbox")
  );
  await outbox.init();
  await outbox.enqueue(
    warningMutationId,
    "rewriteNode",
    { storyId: story.id },
    current.aggregateVersion!
  );
  await outbox.archive(warningMutationId, {
    kind: "plain",
    code: "generation_outcome_unknown",
    message: "The model request stopped.",
    status: 409
  }, pendingProviderMutationId);
  const reporter = await InternalErrorReporter.open(machineDir);
  const recovering = new StoryService({
    dataDir,
    machineDir,
    errorReporter: reporter
  });
  try {
    await recovering.init();
    const privateWarningId =
      "https://private-endpoint.invalid/Private prompt sentinel";
    const untrustedStatus = await recovering.getUnknownOutcomeStatus(
      story.id,
      privateWarningId,
      {
        kind: "legacy",
        warningAggregateVersion: current.aggregateVersion!
      }
    );
    assert.equal(untrustedStatus.state, "pending");
    const status = await recovering.getUnknownOutcomeStatus(
      story.id,
      warningMutationId
    );
    assert.equal(status.state, "pending");
    assert.deepEqual(
      await ledger.loadStoryReceipt(
        `story:${story.id}`,
        warningMutationId
      ),
      {
        started: null,
        prepared: null,
        completed: null,
        acknowledged: null
      }
    );
    await assert.rejects(
      recovering.acknowledgeUnknownOutcomes(
        story.id,
        warningMutationId,
        "Private acknowledgement input sentinel"
      )
    );
  } finally {
    await recovering.dispose();
    await reporter.close();
  }

  const log = await readFile(
    internalErrorLogPath(machineDir),
    "utf8"
  );
  const entries = log.trim().split("\n").map((line) =>
    JSON.parse(line)) as LogEntry[];
  const redirect = entries.find(
    ({ operation, error }) =>
      operation === "story-fence-redirect"
      && String(error?.message).includes(warningMutationId)
  );
  assert.equal(redirect?.service, "provider-recovery");
  assert.match(
    String(redirect?.error?.message),
    /Provider dispatch did not start/
  );
  assert.match(String(redirect?.error?.message), new RegExp(story.id));
  assert.match(
    String(redirect?.error?.message),
    mutationPattern(warningMutationId)
  );
  assert.match(
    String(redirect?.error?.message),
    mutationPattern(pendingProviderMutationId)
  );
  const retirement = entries.find(
    ({ operation }) => operation === "story-fence-retire"
  );
  assert.equal(retirement?.service, "provider-recovery");
  assert.match(
    String(retirement?.error?.message),
    /Provider fence retirement failed/
  );
  assert.match(
    String(retirement?.error?.message),
    new RegExp(story.id)
  );
  assert.match(
    String(retirement?.error?.message),
    mutationPattern(warningMutationId)
  );
  assert.equal(retirement?.error?.cause, undefined);
  assert.doesNotMatch(log, /Private story text sentinel/);
  assert.doesNotMatch(log, /Private provider failure sentinel/);
  assert.doesNotMatch(log, /Private acknowledgement input sentinel/);
  assert.doesNotMatch(log, /Private prompt sentinel/);
  assert.doesNotMatch(log, /private-endpoint/);
});

interface LogEntry {
  service?: unknown;
  operation?: unknown;
  error?: { message?: unknown; cause?: unknown };
}

function mutationPattern(mutationId: string): RegExp {
  return new RegExp(mutationId.replaceAll(".", "\\."));
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error !== null && typeof error === "object"
    && "code" in error
    && (error as { code: unknown }).code === code;
}

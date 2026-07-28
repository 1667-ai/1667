import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DataDirectoryLock } from "../server/data-directory-lock.js";
import { internalErrorLogPath } from "../server/internal-error-log.js";
import { InternalErrorReporter } from "../server/internal-error-reporter.js";
import { MutationOutbox } from "../server/mutation-outbox.js";
import { StoryService } from "../server/story-service.js";

test("archive cleanup retries the directory barrier after unlink", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-outbox-unlink-barrier-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mutationId =
    "m1.1767225600000.5123456789abcdef0123456789abcdef";
  const outbox = new MutationOutbox(dir);
  await outbox.init();
  await outbox.enqueue(mutationId, "autonameStory", { id: "story" });
  await outbox.archive(mutationId, internalFailure());
  const archiveDir = path.join(
    path.dirname(dir),
    `${path.basename(dir)}-archive`
  );
  let unlinkAttempts = 0;
  let directorySyncs = 0;
  const retrying = new MutationOutbox(dir, {
    async unlinkDurable(file) {
      unlinkAttempts += 1;
      await rm(file);
      return {
        status: "visible-not-durable",
        error: new Error("Injected directory barrier failure")
      };
    },
    async syncDirectory(directory) {
      directorySyncs += 1;
      assert.equal(directory, archiveDir);
    }
  });

  await assert.rejects(
    retrying.dismissArchived(mutationId),
    /visible, but durability could not be confirmed/
  );
  assert.equal(unlinkAttempts, 1);
  assert.equal(directorySyncs, 0);

  await retrying.dismissArchived(mutationId);
  assert.equal(unlinkAttempts, 2);
  assert.equal(directorySyncs, 1);
  assert.deepEqual(await retrying.listArchived(), []);
});

test("active cleanup does not sync a genuinely absent cancellation", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-outbox-absent-cancel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mutationId =
    "m1.1767225600000.3123456789abcdef0123456789abcdef";
  const outbox = new MutationOutbox(dir);
  await outbox.init();
  await outbox.enqueue(mutationId, "renameStory", {
    id: "story",
    title: "Saved"
  });
  let unlinkAttempts = 0;
  let directorySyncs = 0;
  const removing = new MutationOutbox(dir, {
    async unlinkDurable(file) {
      unlinkAttempts += 1;
      await rm(file);
      return { status: "durable" };
    },
    async syncDirectory() {
      directorySyncs += 1;
      throw new Error("A no-op removal must not sync");
    }
  });

  await removing.remove(mutationId);
  assert.equal(unlinkAttempts, 2);
  assert.equal(directorySyncs, 0);
  assert.deepEqual(await removing.list(), []);
});

test("HTTP services retire resolved archived warnings", async (t) => {
  const dataDir = await initializedDataDirectory(
    t,
    "1667-outbox-http-warning-"
  );
  const mutationId =
    "m1.1767225600000.4123456789abcdef0123456789abcdef";
  const outbox = await archivedProviderWarning(
    dataDir,
    mutationId,
    "m1.1767225600001.5123456789abcdef0123456789abcdef"
  );
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  try {
    assert.deepEqual(
      await service.getUnknownOutcomeStatus("other-story", mutationId),
      { state: "resolved", deleted: true }
    );
    assert.equal(service.archivedMutationWarnings.length, 1);
    assert.deepEqual(
      await service.getUnknownOutcomeStatus("story", mutationId),
      { state: "resolved", deleted: true }
    );
    assert.deepEqual(service.archivedMutationWarnings, []);
    assert.deepEqual(await outbox.listArchived(), []);
  } finally {
    await service.dispose();
  }
});

test("HTTP warning cleanup retries without replacing resolved state", async (t) => {
  const dataDir = await initializedDataDirectory(
    t,
    "1667-outbox-http-warning-partial-"
  );
  const machineDir = await realpath(
    await mkdtemp(path.join(
      tmpdir(),
      "1667-outbox-http-warning-machine-"
    ))
  );
  t.after(() => rm(machineDir, { recursive: true, force: true }));
  const mutationId =
    "m1.1767225600000.6123456789abcdef0123456789abcdef";
  const outbox = await archivedProviderWarning(
    dataDir,
    mutationId,
    "m1.1767225600001.6123456789abcdef0123456789abcdef"
  );
  const reporter = await InternalErrorReporter.open(machineDir);
  const service = new StoryService({
    dataDir,
    machineDir,
    errorReporter: reporter
  });
  try {
    await service.init();
    const blockedArchive = archiveFile(dataDir, mutationId);
    await rm(blockedArchive);
    await mkdir(blockedArchive);

    assert.deepEqual(
      await service.getUnknownOutcomeStatus("story", mutationId),
      { state: "resolved", deleted: true }
    );
    assert.deepEqual(warningIds(service), [mutationId]);
    await rm(blockedArchive, { recursive: true });
    for (
      let attempt = 0;
      attempt < 100 && service.archivedMutationWarnings.length > 0;
      attempt += 1
    ) {
      await delay(5);
    }
    assert.deepEqual(service.archivedMutationWarnings, []);
    assert.deepEqual(await outbox.listArchived(), []);
  } finally {
    await service.dispose();
    await reporter.close();
  }

  const log = await readFile(internalErrorLogPath(machineDir), "utf8");
  const entry = JSON.parse(log.trim()) as {
    operation?: unknown;
    error?: { message?: unknown; cause?: unknown };
  };
  assert.equal(entry.operation, "warning-retire");
  assert.match(String(entry.error?.message), new RegExp(mutationId));
  assert.equal(entry.error?.cause, undefined);
});

test("HTTP disposal stops a scheduled archive cleanup retry", async (t) => {
  const dataDir = await initializedDataDirectory(
    t,
    "1667-outbox-http-warning-dispose-"
  );
  const mutationId =
    "m1.1767225600000.7123456789abcdef0123456789abcdef";
  await archivedProviderWarning(
    dataDir,
    mutationId,
    "m1.1767225600001.7123456789abcdef0123456789abcdef"
  );
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  const blockedArchive = archiveFile(dataDir, mutationId);
  await rm(blockedArchive);
  await mkdir(blockedArchive);

  assert.deepEqual(
    await service.getUnknownOutcomeStatus("story", mutationId),
    { state: "resolved", deleted: true }
  );
  assert.deepEqual(warningIds(service), [mutationId]);
  await service.dispose();
  await rm(blockedArchive, { recursive: true });
  await delay(75);
  assert.deepEqual(warningIds(service), [mutationId]);
});

async function initializedDataDirectory(
  t: TestContext,
  prefix: string
): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const lock = new DataDirectoryLock(dataDir);
  await lock.acquire();
  await lock.release();
  return dataDir;
}

async function archivedProviderWarning(
  dataDir: string,
  mutationId: string,
  providerMutationId: string
): Promise<MutationOutbox> {
  const outbox = new MutationOutbox(path.join(dataDir, "mutation-outbox"));
  await outbox.init();
  await outbox.enqueue(mutationId, "autonameStory", { id: "story" });
  await outbox.archive(mutationId, {
    kind: "plain",
    code: "generation_outcome_unknown",
    message: "The model request stopped.",
    status: 409
  }, providerMutationId);
  return outbox;
}

function internalFailure() {
  return {
    kind: "plain" as const,
    code: "internal" as const,
    message: "Internal server error",
    status: 500
  };
}

function archiveFile(dataDir: string, mutationId: string): string {
  return path.join(
    dataDir,
    "mutation-outbox-archive",
    `${mutationId}.json`
  );
}

function warningIds(service: StoryService): string[] {
  return service.archivedMutationWarnings.map(
    ({ intent }) => intent.mutationId
  );
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

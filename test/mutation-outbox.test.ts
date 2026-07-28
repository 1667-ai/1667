import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MutationOutbox,
  providerRecoveryFromArchive
} from "../server/mutation-outbox.js";
import { StoryService } from "../server/story-service.js";
import { DataDirectoryLock } from "../server/data-directory-lock.js";
import { MUTATION_INPUT_PROTOCOL_VERSION } from "../shared/worker-protocol.js";

test("mutation outbox records survive restart and clear durably", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-outbox-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mutationId = `m1-${Date.now().toString(36)}-${"1".padStart(32, "0")}`;
  let outbox = new MutationOutbox(dir);
  await outbox.init();
  await outbox.enqueue(mutationId, "createStory", { title: "Retained" });

  outbox = new MutationOutbox(dir);
  await outbox.init();
  assert.deepEqual(await outbox.list(), [{
    format: "1667-mutation-outbox",
    schemaVersion: 1,
    mutationId,
    sequence: 1,
    protocolVersion: MUTATION_INPUT_PROTOCOL_VERSION,
    method: "createStory",
    input: { title: "Retained" },
    createdAt: (await outbox.list())[0]!.createdAt
  }]);
  await outbox.remove(mutationId);
  assert.deepEqual(await outbox.list(), []);
});

test("mutation outbox replays in durable admission order, not filename order", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-outbox-order-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const timestamp = Date.now().toString(36);
  const admittedFirst = `m1-${timestamp}-${"f".padStart(32, "f")}`;
  const admittedSecond = `m1-${timestamp}-${"0".padStart(32, "0")}`;
  const outbox = new MutationOutbox(dir);
  await outbox.init();
  await outbox.enqueue(admittedFirst, "renameStory", { id: "story", title: "A" });
  await outbox.enqueue(admittedSecond, "renameStory", { id: "story", title: "B" });

  assert.deepEqual((await new MutationOutbox(dir).list()).map(({ mutationId, sequence }) =>
    ({ mutationId, sequence })), [
    { mutationId: admittedFirst, sequence: 1 },
    { mutationId: admittedSecond, sequence: 2 }
  ]);
});

test("mutation outbox cancellation survives restart", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-outbox-cancel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mutationId = `m1-${Date.now().toString(36)}-${"c".padStart(32, "0")}`;
  const outbox = new MutationOutbox(dir);
  await outbox.init();
  await outbox.enqueue(mutationId, "continueStory", { storyId: "story" });
  await outbox.cancel(mutationId);

  const [record] = await new MutationOutbox(dir).list();
  assert.equal(record?.mutationId, mutationId);
  assert.equal(Number.isFinite(Date.parse(record?.cancelledAt ?? "")), true);
  assert.deepEqual(await new MutationOutbox(dir).listCancellationMarkers(), [mutationId]);
});

test("mutation outbox cancellation fences a publication that lands later", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-outbox-cancel-race-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mutationId = `m1-${Date.now().toString(36)}-${"e".padStart(32, "0")}`;
  const outbox = new MutationOutbox(dir);
  await outbox.init();

  await outbox.cancel(mutationId);
  await outbox.enqueue(mutationId, "createStory", { title: "Must not replay" });

  const restarted = new MutationOutbox(dir);
  assert.deepEqual(await restarted.listCancellationMarkers(), [mutationId]);
  assert.equal((await restarted.list())[0]?.mutationId, mutationId);
  await restarted.remove(mutationId);
  assert.deepEqual(await restarted.listCancellationMarkers(), []);
  assert.deepEqual(await restarted.list(), []);
});

test("mutation outbox durably dismisses an acknowledged archive", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-outbox-dismiss-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mutationId = `m1-${Date.now().toString(36)}-${"d".padStart(32, "0")}`;
  const outbox = new MutationOutbox(dir);
  await outbox.init();
  await outbox.enqueue(mutationId, "autonameStory", { id: "story" });
  await outbox.archive(mutationId, {
    kind: "plain",
    code: "internal",
    message: "Internal server error",
    status: 500
  });
  assert.equal((await outbox.listArchived()).length, 1);
  await outbox.dismissArchived(mutationId);
  await outbox.dismissArchived(mutationId);
  assert.deepEqual(await new MutationOutbox(dir).listArchived(), []);
});

test("mutation outbox retains the exact provider recovery target", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-outbox-provider-target-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const warningMutationId =
    "m1.1767225600000.6123456789abcdef0123456789abcdef";
  const providerMutationId =
    "m1.1767225600001.7123456789abcdef0123456789abcdef";
  const outbox = new MutationOutbox(dir);
  await outbox.init();
  await outbox.enqueue(
    warningMutationId,
    "autonameStory",
    { id: "story" },
    { kind: "v6", revision: "00000000000000000002" }
  );
  await assert.rejects(
    outbox.archive(warningMutationId, {
      kind: "plain",
      code: "generation_outcome_unknown",
      message: "Unknown provider outcome",
      status: 409
    }),
    /corrupt/
  );
  await outbox.archive(
    warningMutationId,
    {
      kind: "plain",
      code: "generation_outcome_unknown",
      message: "Unknown provider outcome",
      status: 409
    },
    providerMutationId
  );

  const archived = (await outbox.listArchived())[0];
  assert.equal(archived?.schemaVersion, 2);
  assert.deepEqual(archived?.providerRecovery, {
    kind: "target",
    providerMutationId
  });
});

test("exact archives retire stale intents without replacing their target", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-outbox-exact-retire-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const warningMutationId =
    "m1.1767225600000.a123456789abcdef0123456789abcdef";
  const providerMutationId =
    "m1.1767225600001.b123456789abcdef0123456789abcdef";
  const otherProviderMutationId =
    "m1.1767225600002.c123456789abcdef0123456789abcdef";
  const resolution = {
    kind: "plain" as const,
    code: "generation_outcome_unknown" as const,
    message: "The model request stopped. You can try again.",
    status: 409
  };
  const outbox = new MutationOutbox(dir);
  await outbox.init();
  await outbox.enqueue(
    warningMutationId,
    "autonameStory",
    { id: "story" },
    { kind: "v6", revision: "00000000000000000002" }
  );
  const archived = await outbox.archive(
    warningMutationId,
    resolution,
    providerMutationId
  );
  await writeFile(
    path.join(dir, `${warningMutationId}.json`),
    `${JSON.stringify(archived.intent)}\n`
  );

  await assert.rejects(
    outbox.archive(
      warningMutationId,
      resolution,
      otherProviderMutationId
    ),
    /corrupt/
  );
  assert.deepEqual(
    (await outbox.listArchived())[0]?.providerRecovery,
    { kind: "target", providerMutationId }
  );

  const records = await outbox.list();
  const retained = await outbox.retireExactlyArchivedIntents(
    records,
    await outbox.listArchived()
  );
  assert.deepEqual(retained, []);
  assert.deepEqual(await outbox.list(), []);
});

test("pre-Q provider warnings remain schema-version-1 archives", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-outbox-pre-q-warning-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mutationId =
    `m1-${Date.now().toString(36)}-${"7".padStart(32, "0")}`;
  const outbox = new MutationOutbox(dir);
  await outbox.init();
  await outbox.enqueue(mutationId, "autonameStory", { id: "story" });
  await assert.rejects(
    outbox.archive(mutationId, {
      kind: "plain",
      code: "generation_outcome_unknown",
      message: "The model request stopped. You can try again.",
      status: 409
    }, "m1.1767225600001.8123456789abcdef0123456789abcdef"),
    /corrupt/
  );
  const archived = await outbox.archive(mutationId, {
    kind: "plain",
    code: "generation_outcome_unknown",
    message: "The model request stopped. You can try again.",
    status: 409
  });

  assert.equal(archived.schemaVersion, 1);
  assert.equal(providerRecoveryFromArchive(archived), undefined);
  const archiveFile = path.join(
    path.dirname(dir),
    `${path.basename(dir)}-archive`,
    `${mutationId}.json`
  );
  await writeFile(archiveFile, `${JSON.stringify({
    ...archived,
    schemaVersion: 2,
    providerRecovery: {
      kind: "target",
      providerMutationId:
        "m1.1767225600001.8123456789abcdef0123456789abcdef"
    }
  })}\n`);
  await assert.rejects(
    new MutationOutbox(dir).listArchived(),
    /corrupt/
  );
});

test("mutation outbox reads legacy archives without accepting new fields", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-outbox-legacy-archive-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mutationId =
    "m1.1767225600000.8123456789abcdef0123456789abcdef";
  const expectedAggregateVersion = {
    kind: "v6" as const,
    revision: "00000000000000000002"
  };
  const archiveDir = path.join(
    path.dirname(dir),
    `${path.basename(dir)}-archive`
  );
  await mkdir(archiveDir, { recursive: true });
  const legacyArchive = {
    format: "1667-mutation-outbox-archive",
    schemaVersion: 1,
    intent: {
      format: "1667-mutation-outbox",
      schemaVersion: 1,
      mutationId,
      sequence: 1,
      protocolVersion: MUTATION_INPUT_PROTOCOL_VERSION,
      method: "autonameStory",
      input: { id: "story" },
      expectedAggregateVersion,
      createdAt: new Date().toISOString()
    },
    resolution: {
      kind: "plain",
      code: "generation_outcome_unknown",
      message: "The model request stopped.",
      status: 409
    },
    resolvedAt: new Date().toISOString()
  };
  const archiveFile = path.join(archiveDir, `${mutationId}.json`);
  await writeFile(archiveFile, `${JSON.stringify(legacyArchive)}\n`);

  const [archived] = await new MutationOutbox(dir).listArchived();
  assert.deepEqual(
    archived === undefined
      ? undefined
      : providerRecoveryFromArchive(archived),
    {
      kind: "legacy",
      warningAggregateVersion: expectedAggregateVersion
    }
  );

  await writeFile(archiveFile, `${JSON.stringify({
    ...legacyArchive,
    intent: {
      ...legacyArchive.intent,
      method: "renameStory"
    }
  })}\n`);
  const [nonProviderArchive] =
    await new MutationOutbox(dir).listArchived();
  assert.equal(
    nonProviderArchive === undefined
      ? undefined
      : providerRecoveryFromArchive(nonProviderArchive),
    undefined
  );

  await writeFile(archiveFile, `${JSON.stringify({
    ...legacyArchive,
    providerRecovery: {
      kind: "target",
      providerMutationId:
        "m1.1767225600001.9123456789abcdef0123456789abcdef"
    }
  })}\n`);
  await assert.rejects(
    new MutationOutbox(dir).listArchived(),
    /corrupt/
  );

  await writeFile(archiveFile, `${JSON.stringify({
    ...legacyArchive,
    schemaVersion: 2
  })}\n`);
  await assert.rejects(
    new MutationOutbox(dir).listArchived(),
    /corrupt/
  );

  const providerRecovery = {
    kind: "target",
    providerMutationId:
      "m1.1767225600001.9123456789abcdef0123456789abcdef"
  };
  await writeFile(archiveFile, `${JSON.stringify({
    ...legacyArchive,
    schemaVersion: 2,
    intent: {
      ...legacyArchive.intent,
      method: "renameStory"
    },
    providerRecovery
  })}\n`);
  await assert.rejects(
    new MutationOutbox(dir).listArchived(),
    /corrupt/
  );

  await writeFile(archiveFile, `${JSON.stringify({
    ...legacyArchive,
    schemaVersion: 2,
    resolution: {
      kind: "plain",
      code: "mutation_outcome_unknown",
      message: "The mutation outcome is unknown.",
      status: 409
    },
    providerRecovery
  })}\n`);
  await assert.rejects(
    new MutationOutbox(dir).listArchived(),
    /corrupt/
  );
});

test("legacy internal archive messages stay private during recovery", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-outbox-legacy-error-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mutationId = `m1-${Date.now().toString(36)}-${"a".padStart(32, "0")}`;
  const outbox = new MutationOutbox(dir);
  await outbox.init();
  await outbox.enqueue(mutationId, "autonameStory", { id: "story" });
  await assert.rejects(
    outbox.archive(mutationId, {
      kind: "plain",
      code: "internal",
      message: "Internal server error",
      status: 500
    }, "m1.1767225600001.a123456789abcdef0123456789abcdef"),
    /corrupt/
  );
  await outbox.archive(mutationId, {
    kind: "plain",
    code: "internal",
    message: "Internal server error",
    status: 500
  });
  const archiveFile = path.join(
    path.dirname(dir),
    `${path.basename(dir)}-archive`,
    `${mutationId}.json`
  );
  const archive = JSON.parse(await readFile(archiveFile, "utf8"));
  archive.resolution = {
    code: "internal",
    message: "Private legacy path: /srv/1667/settings.json",
    status: 500
  };
  await writeFile(archiveFile, `${JSON.stringify(archive)}\n`);

  assert.deepEqual(
    (await new MutationOutbox(dir).listArchived())[0]?.resolution,
    {
      kind: "plain",
      code: "internal",
      message: "Internal server error",
      status: 500
    }
  );
});

test("mutation outbox rejects read-only records", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-outbox-corrupt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mutationId = `m1-${Date.now().toString(36)}-${"2".padStart(32, "0")}`;
  await writeFile(path.join(dir, `${mutationId}.json`), `${JSON.stringify({
    format: "1667-mutation-outbox",
    schemaVersion: 1,
    mutationId,
    method: "listStories",
    input: {},
    createdAt: new Date().toISOString()
  })}\n`);

  await assert.rejects(new MutationOutbox(dir).list(), /corrupt/);
});

test("HTTP-mode services refuse retained embedded mutations", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-outbox-backend-fence-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await initializeLockAwareDirectory(dataDir);
  const outbox = new MutationOutbox(path.join(dataDir, "mutation-outbox"));
  await outbox.init();
  await outbox.enqueue(
    `m1-${Date.now().toString(36)}-${"3".padStart(32, "0")}`,
    "deleteStory",
    { id: "possibly-deleted" }
  );

  const httpService = StoryService.withoutDiagnostics({ dataDir });
  await assert.rejects(httpService.init(), /start the TUI with --embedded/);

  const workerService = StoryService.withoutDiagnostics({
    dataDir,
    mutationRecovery: "external"
  });
  await workerService.init();
  await workerService.dispose();
});

async function initializeLockAwareDirectory(dataDir: string): Promise<void> {
  const lock = new DataDirectoryLock(dataDir);
  await lock.acquire();
  await lock.release();
}

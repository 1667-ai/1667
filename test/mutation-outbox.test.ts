import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MutationOutbox } from "../server/mutation-outbox.js";
import { StoryService } from "../server/story-service.js";
import { DataDirectoryLock } from "../server/data-directory-lock.js";
import { WORKER_PROTOCOL_VERSION } from "../shared/worker-protocol.js";

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
    protocolVersion: WORKER_PROTOCOL_VERSION,
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
    code: "generation_outcome_unknown",
    message: "Unknown provider outcome",
    status: 409
  });
  assert.equal((await outbox.listArchived()).length, 1);
  await outbox.dismissArchived(mutationId);
  await outbox.dismissArchived(mutationId);
  assert.deepEqual(await new MutationOutbox(dir).listArchived(), []);
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

  const httpService = new StoryService({ dataDir });
  await assert.rejects(httpService.init(), /start the TUI with --embedded/);

  const workerService = new StoryService({ dataDir, mutationRecovery: "external" });
  await workerService.init();
  await workerService.dispose();
});

test("HTTP-mode services expose archived ambiguity warnings", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-outbox-http-warning-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await initializeLockAwareDirectory(dataDir);
  const outbox = new MutationOutbox(path.join(dataDir, "mutation-outbox"));
  await outbox.init();
  const mutationId = `m1-${Date.now().toString(36)}-${"4".padStart(32, "0")}`;
  await outbox.enqueue(mutationId, "autonameStory", { id: "story" });
  await outbox.archive(mutationId, {
    code: "generation_outcome_unknown",
    message: "The provider outcome is unknown.",
    status: 409
  });

  const service = new StoryService({ dataDir });
  await service.init();
  try {
    assert.deepEqual(service.archivedMutationWarnings.map(({ intent, resolution }) => ({
      mutationId: intent.mutationId,
      method: intent.method,
      code: resolution.code
    })), [{ mutationId, method: "autonameStory", code: "generation_outcome_unknown" }]);
  } finally {
    await service.dispose();
  }
});

async function initializeLockAwareDirectory(dataDir: string): Promise<void> {
  const lock = new DataDirectoryLock(dataDir);
  await lock.acquire();
  await lock.release();
}

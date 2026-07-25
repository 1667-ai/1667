import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DataDirectoryLock } from "../server/data-directory-lock.js";
import { ServiceLifecycle } from "../server/service-lifecycle.js";
import { StoryService } from "../server/story-service.js";

test("service lifecycle retries after an initializer throws synchronously", async () => {
  const lifecycle = new ServiceLifecycle();
  let attempts = 0;

  await assert.rejects(lifecycle.init(() => {
    attempts += 1;
    throw new Error("synchronous initialization failure");
  }), /synchronous initialization failure/);
  await lifecycle.init(async () => { attempts += 1; });

  assert.equal(attempts, 2);
  lifecycle.assertReady();
  await lifecycle.dispose(async () => undefined);
});

test("story service rejects work before initialization without touching storage", async (t) => {
  const dataDir = await temporaryDataDirectory(t, "1667-service-before-init-");
  const service = new StoryService({ dataDir });

  await assert.rejects(service.createStory("Too early"), /not initialized/);
  assert.deepEqual(await readdir(dataDir), []);

  await service.dispose();
  await assert.rejects(service.listStories(), /shutting down/);
  assert.deepEqual(await readdir(dataDir), []);
});

test("story service shares initialization and disposal across concurrent callers", async (t) => {
  const dataDir = await temporaryDataDirectory(t, "1667-service-lifecycle-");
  const service = new StoryService({ dataDir });

  const startup = service.init();
  await assert.rejects(service.createStory("Still too early"), /not initialized/);
  await Promise.all([startup, service.init()]);
  await service.init();
  const story = await service.createStory("Ready once");
  assert.equal((await service.loadStory(story.id)).title, "Ready once");

  await Promise.all([service.dispose(), service.dispose()]);
  await service.dispose();
  await assert.rejects(service.loadStory(story.id), /shutting down/);
});

test("story service can retry initialization after lock contention", async (t) => {
  const dataDir = await temporaryDataDirectory(t, "1667-service-init-retry-");
  const owner = new DataDirectoryLock(dataDir);
  await owner.acquire();
  t.after(() => owner.release());
  const service = new StoryService({ dataDir });

  await assert.rejects(service.init(), /already open/);
  await owner.release();
  await service.init();
  assert.deepEqual(await service.listStories(), []);
  await service.dispose();
});

test("disposal overtaking initialization leaves the service closed", async (t) => {
  const dataDir = await temporaryDataDirectory(t, "1667-service-init-dispose-");
  const service = new StoryService({ dataDir });

  const initialization = service.init();
  const disposal = service.dispose();
  await assert.rejects(initialization, /shutting down/);
  await disposal;
  await assert.rejects(service.listStories(), /shutting down/);

  const nextOwner = new DataDirectoryLock(dataDir);
  await nextOwner.acquire();
  await nextOwner.release();
});

async function temporaryDataDirectory(
  t: test.TestContext,
  prefix: string
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

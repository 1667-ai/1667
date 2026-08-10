import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DataDirectoryLock } from "../server/data-directory-lock.js";
import { ServiceLifecycle } from "../server/service-lifecycle.js";
import { StoryService } from "../server/story-service.js";
import { ServiceError } from "../server/errors.js";
import { PartialRewriteStash } from "../server/rewrite-partial.js";
import { createGenerationRecord } from "../shared/generation-record.js";

class CancellableStoryService extends StoryService {
  async runCancellable<T>(
    signal: AbortSignal,
    work: (active: AbortSignal) => Promise<T>
  ): Promise<T> {
    return await this.cancellable(signal, work);
  }

  partialRewriteStash(): PartialRewriteStash {
    return (this as unknown as {
      rewritePartials: PartialRewriteStash;
    }).rewritePartials;
  }
}

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
  const service = StoryService.withoutDiagnostics({ dataDir });

  await assert.rejects(service.createStory("Too early"), /not initialized/);
  assert.deepEqual(await readdir(dataDir), []);

  await service.dispose();
  await assert.rejects(service.listStories(), /shutting down/);
  assert.deepEqual(await readdir(dataDir), []);
});

test("story service shares initialization and disposal across concurrent callers", async (t) => {
  const dataDir = await temporaryDataDirectory(t, "1667-service-lifecycle-");
  const service = StoryService.withoutDiagnostics({ dataDir });

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

test("story service disposal releases verified partial rewrite prose", async (t) => {
  const dataDir = await temporaryDataDirectory(t, "1667-service-partials-");
  const service = new CancellableStoryService({
    dataDir,
    diagnostics: "disabled"
  });
  await service.init();
  const partials = service.partialRewriteStash();
  const reservation = partials.reserve("story", "node", "attempt", 4_096);
  partials.remember(reservation, {
    storyId: "story",
    nodeId: "node",
    attemptId: "attempt",
    streamedDigest: "digest",
    effect: {
      kind: "rewrite",
      nodeId: "node",
      expectedText: "old prose",
      expectedInstruction: "",
      text: "sensitive provider prose",
      generationRecord: createGenerationRecord({
        kind: "rewrite-in-place",
        createdAt: "2026-01-01T00:00:00.000Z",
        provider: { provider: "dry-run", model: "dry-run" },
        effective: { wireProtocol: "dry-run", fields: [], adjustments: [] },
        prompt: { operation: "rewrite", entries: [] }
      })
    }
  });
  assert.notEqual(partials.get("story", "node", "attempt"), null);

  await service.dispose();

  assert.equal(partials.get("story", "node", "attempt"), null);
});

test("story service can retry initialization after lock contention", async (t) => {
  const dataDir = await temporaryDataDirectory(t, "1667-service-init-retry-");
  const owner = new DataDirectoryLock(dataDir);
  await owner.acquire();
  t.after(() => owner.release());
  const service = StoryService.withoutDiagnostics({ dataDir });

  await assert.rejects(service.init(), /already open/);
  await owner.release();
  await service.init();
  assert.deepEqual(await service.listStories(), []);
  await service.dispose();
});

test("disposal overtaking initialization leaves the service closed", async (t) => {
  const dataDir = await temporaryDataDirectory(t, "1667-service-init-dispose-");
  const service = StoryService.withoutDiagnostics({ dataDir });

  const initialization = service.init();
  const disposal = service.dispose();
  await assert.rejects(initialization, /shutting down/);
  await disposal;
  await assert.rejects(service.listStories(), /shutting down/);

  const nextOwner = new DataDirectoryLock(dataDir);
  await nextOwner.acquire();
  await nextOwner.release();
});

test("story service preserves uncertain aborts for receipt-free generation", async (t) => {
  const dataDir = await temporaryDataDirectory(t, "1667-service-uncertain-generation-");
  const service = new CancellableStoryService({
    dataDir,
    diagnostics: "disabled"
  });
  await service.init();
  t.after(() => service.dispose());
  const controller = new AbortController();
  const uncertain = new ServiceError(
    503,
    "Provider outcome is unknown",
    "mutation_outcome_unknown"
  );

  await assert.rejects(
    service.runCancellable(controller.signal, async () => {
      controller.abort(uncertain);
      return null;
    }),
    (error: unknown) => error === uncertain
  );
});

async function temporaryDataDirectory(
  t: test.TestContext,
  prefix: string
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

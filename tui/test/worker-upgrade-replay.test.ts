import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDurableMutationId } from "../../shared/durable-mutation-id.js";
import { createMutationCoordinator } from "../../server/mutation-coordinator.js";
import { MutationLedgerStore } from "../../server/mutation-ledger-store.js";
import { MutationOutbox } from "../../server/mutation-outbox.js";
import { mutationFingerprint } from "../../server/mutation-receipts.js";
import { parseStoryManifestBytes } from "../../server/story-v6-codec.js";
import {
  InjectedStoryMutationCrash,
  StoryMutationStore,
  type StoryMutationStoreHooks
} from "../../server/story-mutation-store.js";
import { StoryStore } from "../../server/stories.js";
import { createWorkerStoryApi } from "../src/worker-api.js";

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the promise to reject");
}

/**
 * Cross-build upgrade contract: a pre-tiering build wrote a durable outbox
 * intent and ledger records for EVERY mutation, including local ones. After
 * an upgrade, the retained intent replays without the manifest-only marker,
 * so it must take the full receipt/ledger path against that evidence and
 * converge — never the receipt-free local tier.
 */
async function buildRetainedLocalMutation(point: "afterPublish" | "afterPrepared"): Promise<{
  dataDir: string;
  vaultParent: string;
  storyId: string;
  mutationId: string;
  title: string;
  manifestFile: string;
  outbox: MutationOutbox;
  ledger: MutationLedgerStore;
}> {
  const vaultParent = await realpath(
    await mkdtemp(path.join(tmpdir(), "1667-upgrade-replay-"))
  );
  const dataDir = path.join(vaultParent, "vault");
  const machineDir = path.join(vaultParent, "machine");
  await mkdir(machineDir, { mode: 0o700 });

  // Phase 0: a real worker initializes the vault exactly as any build does.
  const seeded = await createWorkerStoryApi({ dataDir, machineDir });
  let storyId: string;
  let expectedAggregateVersion: NonNullable<unknown>;
  try {
    await seeded.recovery;
    const stories = await seeded.api.listStories();
    storyId = stories[0]!.id;
    const payload = await seeded.api.loadStory(storyId);
    if (payload.aggregateVersion === undefined) {
      throw new Error("Seeded story is missing successor-Q version metadata");
    }
    expectedAggregateVersion = payload.aggregateVersion;
  } finally {
    await seeded.dispose();
  }

  // Phase 1: reproduce the pre-tiering build's crash residue — the durable
  // intent is written before the request is sent, and the aggregate
  // transaction stops at the injected point with its ledger records behind.
  const mutationId = createDurableMutationId();
  const title = `Retained rename ${point}`;
  const input = { id: storyId, title };
  const fingerprint = mutationFingerprint("renameStory", input);
  const outbox = new MutationOutbox(path.join(dataDir, "mutation-outbox"));
  await outbox.init();
  await outbox.enqueue(
    mutationId,
    "renameStory",
    input,
    expectedAggregateVersion as never
  );

  const storiesDir = path.join(dataDir, "stories");
  const stories = new StoryStore(storiesDir);
  await stories.init();
  const ledger = new MutationLedgerStore(dataDir);
  let injected = false;
  const hooks: StoryMutationStoreHooks = {
    [point]: () => {
      if (injected) return;
      injected = true;
      throw new InjectedStoryMutationCrash(point);
    }
  };
  const crashing = new StoryMutationStore(
    stories,
    createMutationCoordinator(),
    dataDir,
    { ledger, hooks }
  );
  await crashing.init();
  const crash = await rejection(crashing.runLocal(
    {
      transportOperationId: "upgrade-replay-test",
      mutationId,
      fingerprint,
      scope: `story:${storyId}`,
      expectedAggregateVersion: expectedAggregateVersion as never
    },
    "renameStory",
    (story) => { story.title = title; }
  ));
  expect(crash instanceof InjectedStoryMutationCrash).toBeTrue();

  return {
    dataDir,
    vaultParent,
    storyId,
    mutationId,
    title,
    manifestFile: path.join(storiesDir, storyId, "manifest.json"),
    outbox,
    ledger
  };
}

test("a retained settle-stopped createNode replays with the streamed prose surviving", async () => {
  // A stopped generation settles its paid prose through createNode with a
  // genId. That request keeps the full tier, so the durable intent is the
  // only copy that survives a crash in the window before the worker commits.
  const vaultParent = await realpath(
    await mkdtemp(path.join(tmpdir(), "1667-settle-replay-"))
  );
  const dataDir = path.join(vaultParent, "vault");
  const machineDir = path.join(vaultParent, "machine");
  await mkdir(machineDir, { mode: 0o700 });
  const prose = "Streamed prose that was already paid for.";
  let storyId: string;
  try {
    const seeded = await createWorkerStoryApi({ dataDir, machineDir });
    let parentId: string | null;
    let expectedAggregateVersion: NonNullable<unknown>;
    try {
      await seeded.recovery;
      const stories = await seeded.api.listStories();
      storyId = stories[0]!.id;
      const payload = await seeded.api.loadStory(storyId);
      parentId = payload.path.at(-1)?.id ?? null;
      if (payload.aggregateVersion === undefined) {
        throw new Error("Seeded story is missing successor-Q version metadata");
      }
      expectedAggregateVersion = payload.aggregateVersion;
    } finally {
      await seeded.dispose();
    }

    // The crash window: the intent is durable, the request was never sent.
    const mutationId = createDurableMutationId();
    const outbox = new MutationOutbox(path.join(dataDir, "mutation-outbox"));
    await outbox.init();
    await outbox.enqueue(
      mutationId,
      "createNode",
      {
        storyId,
        body: {
          parentId,
          instruction: "Continue",
          text: prose,
          genId: crypto.randomUUID()
        }
      },
      expectedAggregateVersion as never
    );

    const backend = await createWorkerStoryApi({ dataDir, machineDir });
    try {
      expect(await backend.recovery).toEqual([]);
      expect(await outbox.list()).toEqual([]);
      const replayed = await backend.api.loadStory(storyId);
      expect(replayed.path.at(-1)?.text).toBe(prose);
    } finally {
      await backend.dispose();
    }
  } finally {
    await rm(vaultParent, { recursive: true, force: true });
  }
});

test("upgrade replay of a published local mutation converges through the full tier", async () => {
  const fixture = await buildRetainedLocalMutation("afterPublish");
  const machineDir = path.join(fixture.vaultParent, "machine");
  const backend = await createWorkerStoryApi({
    dataDir: fixture.dataDir,
    machineDir
  });
  try {
    // The replay resolves against the recorded evidence without warnings or
    // re-execution: the intent settles, the committed title stands exactly
    // once, and recovery writes the missing terminal record.
    expect(await backend.recovery).toEqual([]);
    expect(await fixture.outbox.list()).toEqual([]);
    expect(await fixture.outbox.listArchived()).toEqual([]);
    const replayed = await backend.api.loadStory(fixture.storyId);
    expect(replayed.title).toBe(fixture.title);
    const receipt = await fixture.ledger.loadStoryReceipt(
      `story:${fixture.storyId}`,
      fixture.mutationId
    );
    expect(receipt.prepared).not.toBe(null);
    expect(receipt.completed).not.toBe(null);
    const parsed = parseStoryManifestBytes(
      await readFile(fixture.manifestFile),
      fixture.storyId
    );
    if (parsed.kind !== "v6-live") throw new Error("Expected live V6");
    expect(parsed.manifest.lastTransaction?.mutationId).toBe(fixture.mutationId);
  } finally {
    await backend.dispose();
    await rm(fixture.vaultParent, { recursive: true, force: true });
  }
});

test("upgrade replay of an unpublished local mutation re-executes through the full tier", async () => {
  const fixture = await buildRetainedLocalMutation("afterPrepared");
  const machineDir = path.join(fixture.vaultParent, "machine");
  const backend = await createWorkerStoryApi({
    dataDir: fixture.dataDir,
    machineDir
  });
  try {
    // The staged manifest and its prepared record are retired together, then
    // the retained request re-executes with the full pipeline: no stranded
    // prepared record, no torn stage, and exactly one committed rename.
    expect(await backend.recovery).toEqual([]);
    expect(await fixture.outbox.list()).toEqual([]);
    const replayed = await backend.api.loadStory(fixture.storyId);
    expect(replayed.title).toBe(fixture.title);
    expect(await rejection(access(`${fixture.manifestFile}.next`))).toMatchObject({
      code: "ENOENT"
    });
    const receipt = await fixture.ledger.loadStoryReceipt(
      `story:${fixture.storyId}`,
      fixture.mutationId
    );
    expect(receipt.prepared).not.toBe(null);
    expect(receipt.completed).not.toBe(null);
    const parsed = parseStoryManifestBytes(
      await readFile(fixture.manifestFile),
      fixture.storyId
    );
    if (parsed.kind !== "v6-live") throw new Error("Expected live V6");
    expect(parsed.manifest.lastTransaction?.mutationId).toBe(fixture.mutationId);
  } finally {
    await backend.dispose();
    await rm(fixture.vaultParent, { recursive: true, force: true });
  }
});

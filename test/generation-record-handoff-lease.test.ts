import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { continueStory } from "../server/generation-http.js";
import { GenerationAdmissionRegistry } from "../server/generation-admission.js";
import { commitNode } from "../server/node-commit.js";
import { LEGACY_PROMPT_CACHE_CONTEXT, PromptCacheRuntime } from "../server/provider-cache-policy.js";
import { sha256 } from "../server/story-format.js";
import { StoryStore } from "../server/stories.js";
import type { SettingsStore } from "../server/settings.js";
import type { CreateNodeRequest, GenerationSettings } from "../shared/types.js";

/**
 * `GenerationAdmissionRegistry.withGenerationRecordHandoff` owns the
 * consume-on-success lifecycle for a stop-save handoff: it hands the handoff
 * to the commit, then releases its revision pin and clears the record only
 * once that commit resolves — never before, and never at all if the commit
 * throws. These integration tests drive that lease through
 * `server/node-commit.ts`'s real commit path against a real StoryStore, the
 * same seam `test/generation-record-stop-save.test.ts` exercises.
 */

function stopAfterFirstDelta(controller: AbortController): {
  onDelta: (text: string) => void;
  text: () => string;
} {
  let text = "";
  let stopped = false;
  return {
    onDelta: (delta: string) => {
      text += delta;
      if (!stopped) {
        stopped = true;
        controller.abort();
      }
    },
    text: () => text
  };
}

function trackedAdmission(): { admission: GenerationAdmissionRegistry; releasedRevisionIds: string[][] } {
  const releasedRevisionIds: string[][] = [];
  const admission = new GenerationAdmissionRegistry((_storyId, revisionIds) => {
    const pinned = [...revisionIds];
    releasedRevisionIds.push(pinned);
    return () => pinned.push("released");
  });
  return { admission, releasedRevisionIds };
}

test("a resolved stop-save commit releases the handoff's pin", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-lease-resolve-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");
  const { admission, releasedRevisionIds } = trackedAdmission();
  const controller = new AbortController();
  const stop = stopAfterFirstDelta(controller);

  const stopped = await continueStory(
    story.id,
    { parentId: null, instruction: "Continue.", genId: "gen-lease-resolve" },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    admission,
    stop.onDelta,
    controller.signal
  );
  assert.equal(stopped, null);
  assert.notEqual(admission.generationRecordHandoffFor(story.id, "gen-lease-resolve"), undefined);
  assert.equal(releasedRevisionIds[0]!.includes("released"), false);

  const saved = await commitNode(
    stories,
    stubSettingsStore(dryRunSettings()),
    admission,
    story.id,
    { parentId: null, instruction: "Continue.", text: stop.text(), genId: "gen-lease-resolve" } as CreateNodeRequest
  );
  const node = saved.nodes.find((candidate) => candidate.genId === "gen-lease-resolve");
  if (node === undefined) throw new Error("stop-save did not commit a take");
  assert.equal(node.generationRecordIds?.length, 1);

  // The lease only releases once the commit it wrapped resolved.
  assert.equal(admission.generationRecordHandoffFor(story.id, "gen-lease-resolve"), undefined);
  assert.equal(releasedRevisionIds.length, 1);
  assert.equal(releasedRevisionIds[0]!.includes("released"), true);
  await stories.waitForMaintenance();
});

test("a rejected stop-save commit retains the handoff and its pin", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-lease-reject-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");
  const root = await stories.createNode(story.id, null, "Original root prose.", "");
  const rootId = root.nodes[0]!.id;
  const rootText = root.nodes[0]!.text;
  const { admission, releasedRevisionIds } = trackedAdmission();
  const controller = new AbortController();
  const stop = stopAfterFirstDelta(controller);

  const stopped = await continueStory(
    story.id,
    {
      appendTo: rootId,
      expectedTextHash: sha256(rootText),
      instruction: "",
      genId: "gen-lease-reject"
    },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    admission,
    stop.onDelta,
    controller.signal
  );
  assert.equal(stopped, null);
  assert.notEqual(admission.generationRecordHandoffFor(story.id, "gen-lease-reject"), undefined);

  // The root's text changes underneath the stopped attempt, so the
  // expectedTextHash the client still holds no longer matches — the
  // stop-save commit's own append validation must throw.
  await stories.editNode(story.id, rootId, {
    text: "The root changed before the stop-save arrived.",
    expectedTextHash: sha256(rootText)
  });

  await assert.rejects(
    commitNode(
      stories,
      stubSettingsStore(dryRunSettings()),
      admission,
      story.id,
      {
        appendTo: rootId,
        expectedTextHash: sha256(rootText),
        instruction: "",
        text: stop.text(),
        genId: "gen-lease-reject"
      } as CreateNodeRequest
    ),
    (error) => error instanceof Error && /changed while writing/.test(error.message)
  );

  // The lease callback threw, so the registry must not have released
  // anything — the handoff is still there for a later, corrected retry.
  assert.notEqual(admission.generationRecordHandoffFor(story.id, "gen-lease-reject"), undefined);
  assert.equal(releasedRevisionIds.length, 1);
  assert.equal(releasedRevisionIds[0]!.includes("released"), false);
  await stories.waitForMaintenance();
});

test("a duplicate stop-save replay consumes the lease without re-releasing the pin", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-lease-duplicate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");
  const { admission, releasedRevisionIds } = trackedAdmission();
  const controller = new AbortController();
  const stop = stopAfterFirstDelta(controller);

  const stopped = await continueStory(
    story.id,
    { parentId: null, instruction: "Continue.", genId: "gen-lease-duplicate" },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    admission,
    stop.onDelta,
    controller.signal
  );
  assert.equal(stopped, null);
  const partial = stop.text();

  const request = {
    parentId: null,
    instruction: "Continue.",
    text: partial,
    genId: "gen-lease-duplicate"
  } as CreateNodeRequest;
  const first = await commitNode(stories, stubSettingsStore(dryRunSettings()), admission, story.id, request);
  const firstNode = first.nodes.find((candidate) => candidate.genId === "gen-lease-duplicate");
  if (firstNode === undefined) throw new Error("stop-save did not commit a take");
  assert.equal(releasedRevisionIds.length, 1);

  // The same request lands again — a network retry of the createNode call
  // itself. commitTake's own genId dedup makes this a no-op duplicate before
  // the lease's callback ever looks at a (by now already-released) handoff.
  const replayed = await commitNode(stories, stubSettingsStore(dryRunSettings()), admission, story.id, request);
  assert.equal(replayed.nodes.length, first.nodes.length);
  const replayedNode = replayed.nodes.find((candidate) => candidate.genId === "gen-lease-duplicate");
  assert.deepEqual(replayedNode?.generationRecordIds, firstNode.generationRecordIds);

  // The already-released pin is not released a second time.
  assert.equal(releasedRevisionIds.length, 1);
  assert.equal(releasedRevisionIds[0]!.includes("released"), true);
  await stories.waitForMaintenance();
});

test("the pin releases exactly once even when consumption and a superseded discard both target the same genId", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-lease-race-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");
  const { admission, releasedRevisionIds } = trackedAdmission();
  const controller = new AbortController();
  const stop = stopAfterFirstDelta(controller);

  const stopped = await continueStory(
    story.id,
    { parentId: null, instruction: "Continue.", genId: "gen-lease-race" },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    admission,
    stop.onDelta,
    controller.signal
  );
  assert.equal(stopped, null);

  await commitNode(
    stories,
    stubSettingsStore(dryRunSettings()),
    admission,
    story.id,
    { parentId: null, instruction: "Continue.", text: stop.text(), genId: "gen-lease-race" } as CreateNodeRequest
  );
  assert.equal(releasedRevisionIds.length, 1);

  // A same-genId direct attempt's own completion races in after the
  // stop-save already consumed the lease — its discard must find nothing
  // left to release.
  admission.discardSupersededGenerationRecordHandoff(story.id, "gen-lease-race");

  assert.equal(releasedRevisionIds.length, 1);
  assert.equal(releasedRevisionIds[0]!.includes("released"), true);
  await stories.waitForMaintenance();
});

function dryRunSettings(): GenerationSettings {
  return {
    provider: "dry-run",
    baseUrl: "",
    model: "dry-run",
    apiKeyEnv: null,
    temperature: null,
    maxTokens: 256,
    systemPrompt: "Write.",
    contextWindow: null
  };
}

function stubSettingsStore(settings: GenerationSettings): SettingsStore {
  return {
    load: async () => settings,
    loadGeneration: async () => ({ settings, promptCache: LEGACY_PROMPT_CACHE_CONTEXT, imageInputCapability: null })
  } as unknown as SettingsStore;
}

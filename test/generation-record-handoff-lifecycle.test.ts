import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { GenerationAdmissionRegistry } from "../server/generation-admission.js";
import { GenerationResultError } from "../server/errors.js";
import { continueStory } from "../server/generation-http.js";
import { LEGACY_PROMPT_CACHE_CONTEXT, PromptCacheRuntime } from "../server/provider-cache-policy.js";
import type { SettingsStore } from "../server/settings.js";
import { StoryStore } from "../server/stories.js";
import type { GenerationSettings } from "../shared/types.js";

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

// A completed retry with the same generation ID supersedes the handoff from
// the stopped attempt. The direct commit must release the handoff lease.
test("a stopped continuation's handoff is released once a same-genId retry completes and commits directly", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-superseded-handoff-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const releasedRevisionIds: string[][] = [];
  const admission = new GenerationAdmissionRegistry((_storyId, revisionIds) => {
    const pinned = [...revisionIds];
    releasedRevisionIds.push(pinned);
    return () => pinned.push("released");
  });
  const controller = new AbortController();
  const stop = stopAfterFirstDelta(controller);

  const stopped = await continueStory(
    story.id,
    { parentId: null, instruction: "Continue.", genId: "gen-superseded" },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    admission,
    stop.onDelta,
    controller.signal
  );
  assert.equal(stopped, null);
  assert.notEqual(admission.generationRecordHandoffFor(story.id, "gen-superseded"), undefined);
  assert.equal(releasedRevisionIds.length, 1);
  assert.equal(releasedRevisionIds[0]!.includes("released"), false);

  const completed = await continueStory(
    story.id,
    { parentId: null, instruction: "Continue.", genId: "gen-superseded" },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    admission,
    () => {},
    new AbortController().signal
  );
  const node = completed?.nodes.find((candidate) => candidate.genId === "gen-superseded");
  if (node === undefined) throw new Error("direct completion did not commit a take");

  assert.equal(releasedRevisionIds.length, 1);
  assert.equal(releasedRevisionIds[0]!.includes("released"), true);
  assert.equal(admission.generationRecordHandoffFor(story.id, "gen-superseded"), undefined);
  assert.equal(admission.modelFor(story.id, "gen-superseded"), "dry-run");
  await stories.waitForMaintenance();
});

// A failed retry does not supersede the stopped attempt. The handoff must
// remain available for a later save or retry.
test("a stopped continuation's handoff survives when a same-genId retry's commit fails", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-superseded-handoff-fails-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");
  const root = await stories.createNode(story.id, null, "Root prose.", "");
  const rootId = root.nodes[0]!.id;

  const releasedRevisionIds: string[][] = [];
  const admission = new GenerationAdmissionRegistry((_storyId, revisionIds) => {
    const pinned = [...revisionIds];
    releasedRevisionIds.push(pinned);
    return () => pinned.push("released");
  });
  const controller = new AbortController();
  const stop = stopAfterFirstDelta(controller);

  const stopped = await continueStory(
    story.id,
    { parentId: rootId, instruction: "Continue.", genId: "gen-fails-retry" },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    admission,
    stop.onDelta,
    controller.signal
  );
  assert.equal(stopped, null);
  assert.notEqual(admission.generationRecordHandoffFor(story.id, "gen-fails-retry"), undefined);

  let deleted = false;
  const onDelta = async () => {
    if (deleted) return;
    deleted = true;
    await stories.deleteNode(story.id, rootId, 1);
  };

  await assert.rejects(
    continueStory(
      story.id,
      { parentId: rootId, instruction: "Continue.", genId: "gen-fails-retry" },
      stories,
      stubSettingsStore(dryRunSettings()),
      new PromptCacheRuntime(),
      admission,
      onDelta,
      new AbortController().signal
    ),
    (error) => error instanceof GenerationResultError && error.status === 409
  );

  assert.notEqual(admission.generationRecordHandoffFor(story.id, "gen-fails-retry"), undefined);
  assert.equal(releasedRevisionIds.length, 1);
  assert.equal(releasedRevisionIds[0]!.includes("released"), false);
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

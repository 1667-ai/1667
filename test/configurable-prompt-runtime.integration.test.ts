/**
 * Configurable-prompt runtime: Continue pinning, stopped saves, both
 * createNode commit paths, and Generation Record ownership.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDurableMutationId } from "../shared/durable-mutation-id.js";
import { DEFAULT_WRITING_PROMPT_SETTINGS } from "../shared/settings-v5-writing.js";
import type { CreateNodeRequest } from "../shared/types.js";
import { continueStory } from "../server/generation-http.js";
import {
  GenerationAdmissionRegistry,
  generatedTakeInstruction
} from "../server/generation-admission.js";
import { commitNode } from "../server/node-commit.js";
import { PromptCacheRuntime } from "../server/provider-cache-policy.js";
import { sha256 } from "../server/story-format.js";
import { StoryStore } from "../server/stories.js";
import { openService } from "./aside-test-helpers.js";
import {
  CUSTOM_CONTINUE_DIRECTION,
  OPERATION_GUIDANCE,
  dryRunSettings,
  stopAfterFirstDelta,
  stubSettingsStore
} from "./configurable-prompt-test-helpers.js";

test("empty Continue pins the configured default through stop-save createNode", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-prompt-pin-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");
  const admission = new GenerationAdmissionRegistry();
  const controller = new AbortController();
  const stop = stopAfterFirstDelta(controller);
  const writing = {
    ...DEFAULT_WRITING_PROMPT_SETTINGS,
    defaultContinueDirection: CUSTOM_CONTINUE_DIRECTION
  };

  const stopped = await continueStory(
    story.id,
    { parentId: null, instruction: "", genId: "gen-pin" },
    stories,
    stubSettingsStore(dryRunSettings(), writing),
    new PromptCacheRuntime(),
    admission,
    stop.onDelta,
    controller.signal
  );
  assert.equal(stopped, null);
  assert.equal(admission.continueDirectionFor(story.id, "gen-pin"), CUSTOM_CONTINUE_DIRECTION);
  const partial = stop.text();
  assert.notEqual(partial.length, 0);

  const saved = await commitNode(
    stories,
    stubSettingsStore(dryRunSettings(), writing),
    admission,
    story.id,
    { parentId: null, instruction: "", text: partial, genId: "gen-pin" } as CreateNodeRequest
  );
  const node = saved.nodes.find((candidate) => candidate.genId === "gen-pin");
  if (node === undefined) throw new Error("stop-save did not commit a take");
  assert.equal(node.instruction, CUSTOM_CONTINUE_DIRECTION);
  assert.equal(node.generationRecordIds?.length, 1);
  const record = await stories.loadGenerationRecord(story.id, node.id, node.generationRecordIds![0]!);
  assert.equal(record.kind, "continue");
  assert.equal(
    record.prompt.entries.some((entry) =>
      entry.kind === "request" && "text" in entry && entry.text === CUSTOM_CONTINUE_DIRECTION),
    true
  );
});

test("a genuine append does not pin Continue direction or change the saved instruction", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-prompt-append-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const created = await stories.create("Story");
  const seeded = await stories.createNode(created.id, null, "The latch was unlo", "Open.");
  const root = seeded.nodes[0]!;
  const admission = new GenerationAdmissionRegistry();
  const writing = {
    ...DEFAULT_WRITING_PROMPT_SETTINGS,
    defaultContinueDirection: CUSTOM_CONTINUE_DIRECTION
  };
  let capturedInstruction: string | undefined;
  await continueStory(
    created.id,
    { appendTo: root.id, expectedTextHash: sha256(root.text), instruction: "", genId: "gen-append" },
    stories,
    stubSettingsStore(dryRunSettings(), writing),
    new PromptCacheRuntime(),
    admission,
    () => {},
    new AbortController().signal,
    {
      bindIntent: async (_settings, context) => {
        capturedInstruction = (context as { instruction: string }).instruction;
      }
    }
  );
  assert.equal(admission.continueDirectionFor(created.id, "gen-append"), undefined);
  assert.equal(capturedInstruction, "Continue the story.");
  const reloaded = await stories.load(created.id);
  assert.equal(reloaded.nodes[0]!.instruction, "Open.");
});

test("StoryService createNode uses the pinned Continue direction for a stopped empty request", async (t) => {
  const { service } = await openService(t);
  const initial = await service.getSettings();
  assert.ok(initial.document);
  await service.saveSettings({
    transportOperationId: crypto.randomUUID(),
    mutationId: createDurableMutationId(),
    expectedStateGeneration: initial.stateGeneration,
    document: {
      ...initial.document,
      writing: {
        ...initial.document.writing,
        defaultContinueDirection: CUSTOM_CONTINUE_DIRECTION
      }
    }
  });
  const created = await service.createStory("Pinned direction");
  const controller = new AbortController();
  const stop = stopAfterFirstDelta(controller);
  const stopped = await service.continueStory(
    created.id,
    { parentId: null, instruction: "", genId: "gen-svc-pin" },
    stop.onDelta,
    controller.signal
  );
  assert.equal(stopped, null);
  const partial = stop.text();
  assert.notEqual(partial.length, 0);
  const saved = await service.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: partial,
    genId: "gen-svc-pin"
  });
  const node = saved.path.find((candidate) => candidate.genId === "gen-svc-pin");
  if (node === undefined) throw new Error("service stop-save did not commit a take");
  assert.equal(node.instruction, CUSTOM_CONTINUE_DIRECTION);
});

test("legacy createNode without a pin still uses the request body fallback", () => {
  const admission = new GenerationAdmissionRegistry();
  assert.equal(
    generatedTakeInstruction(admission, "story", "missing", ""),
    "Continue the story."
  );
  admission.rememberModel("story", "gen", "dry-run");
  admission.rememberContinueDirection("story", "gen", CUSTOM_CONTINUE_DIRECTION);
  assert.equal(
    generatedTakeInstruction(admission, "story", "gen", "ignored"),
    CUSTOM_CONTINUE_DIRECTION
  );
});

test("Continue with default writing captures the request and no extra guidance block", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-prompt-record-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");
  const continued = await continueStory(
    story.id,
    { parentId: null, instruction: "", genId: "gen-record" },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal
  );
  const node = continued?.nodes.find((candidate) => candidate.genId === "gen-record");
  if (node === undefined) throw new Error("continuation did not commit");
  assert.equal(node.instruction, "Continue the story.");
  const record = await stories.loadGenerationRecord(story.id, node.id, node.generationRecordIds![0]!);
  const contracts = record.prompt.entries.filter((entry) => entry.kind === "operation-contract");
  assert.ok(contracts.length >= 1);
  assert.equal(contracts.some((entry) => "text" in entry && entry.text === OPERATION_GUIDANCE), false);
});

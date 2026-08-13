import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDurableMutationId } from "../shared/durable-mutation-id.js";
import type { GenerationSettings, Story } from "../shared/types.js";
import { applyEffectiveGenerationSettings } from "../server/settings-v2-conversion.js";
import { ServiceError } from "../server/errors.js";
import { LEGACY_PROMPT_CACHE_CONTEXT, PromptCacheRuntime } from "../server/provider-cache-policy.js";
import {
  MutationReceiptPersistenceError,
  MutationReceiptStore
} from "../server/mutation-receipts.js";
import { askAside } from "../server/aside-http.js";
import type { ProviderStoryRuntime } from "../server/story-mutation-runtime.js";
import { openService } from "./aside-test-helpers.js";

test("Aside rejects oversized required context before provider start", async (t) => {
  const { service } = await openService(t);
  const initial = await service.getSettings();
  assert.ok(initial.document);
  await service.saveSettings({
    transportOperationId: crypto.randomUUID(),
    mutationId: createDurableMutationId(),
    expectedStateGeneration: initial.stateGeneration,
    document: applyEffectiveGenerationSettings(initial.document, {
      ...initial.effective,
      contextWindow: 2_048,
      maxTokens: 1_024
    })
  });
  const created = await service.createStory("Aside context admission");
  let providerStarted = false;
  const question = "a".repeat(8_192);

  await assert.rejects(
    service.askAside(
      created.id,
      { question },
      async () => {},
      new AbortController().signal,
      { providerStarted: () => { providerStarted = true; } }
    ),
    (error: unknown) => error instanceof ServiceError
      && error.status === 422
      && error.code === "content_too_large"
      && /required Aside context is too large/u.test(error.message)
  );
  assert.equal(providerStarted, false);
});

test("Aside binds its utility settings and rendered prompt before provider work", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-aside-generation-intent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receipts = new MutationReceiptStore(
    path.join(root, "receipts"),
    async () => { throw new Error("story replay is not used"); }
  );
  await receipts.init();

  const settingsA: GenerationSettings = {
    provider: "dry-run",
    baseUrl: "",
    model: "utility-a",
    apiKeyEnv: null,
    temperature: 0.5,
    maxTokens: 128,
    systemPrompt: "Utility profile A",
    contextWindow: null
  };
  let settings = settingsA;
  const story: Story = {
    id: "story",
    title: "Intent story",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nodes: [{
      id: "root",
      parentId: null,
      instruction: "",
      text: "The first source text.",
      model: "fixture",
      createdAt: "2026-01-01T00:00:00.000Z",
      activeChildId: null
    }],
    activeRootId: "root",
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: []
  };
  const stories = {
    loadForMutation: async () => story,
    hydratePath: async () => {},
    commitProviderEffect: async () => {
      throw new Error("provider work must not reach the effect commit");
    }
  } as unknown as ProviderStoryRuntime<"askAside">;
  const settingsStore = {
    loadGeneration: async () => ({
      settings,
      promptCache: LEGACY_PROMPT_CACHE_CONTEXT,
      imageInputCapability: null
    })
  } as never;
  const mutationId = createDurableMutationId();
  const input = { storyId: "story", question: "Why?" };
  let streamed = "";
  let firstAttempt = true;

  const run = async () => await receipts.run(
    mutationId,
    "askAside",
    input,
    async (execution) => await askAside(
      "story",
      { question: input.question },
      stories,
      settingsStore,
      new PromptCacheRuntime(),
      async (delta) => { streamed += delta; },
      new AbortController().signal,
      {
        entryPointsOpen: true,
        loadDocument: async () => null,
        bindIntent: async (effective, context) => {
          await execution.bindGenerationIntent(effective, context);
          if (firstAttempt) {
            firstAttempt = false;
            throw new MutationReceiptPersistenceError(new Error("retain request"));
          }
        }
      }
    ),
    undefined,
    () => {}
  );

  await assert.rejects(run(), (error) => error instanceof MutationReceiptPersistenceError);
  assert.equal(streamed, "");

  // Keep the mutation ID and request input. Change both the utility profile and
  // the source rendered into the prompt before the retained request retries.
  settings = { ...settingsA, model: "utility-b", systemPrompt: "Utility profile B" };
  story.nodes[0]!.text = "The changed source text.";
  await assert.rejects(run(), (error) => error instanceof ServiceError
    && error.code === "idempotency_conflict");
  assert.equal(streamed, "", "a changed retained Aside request must not stream twice");
});

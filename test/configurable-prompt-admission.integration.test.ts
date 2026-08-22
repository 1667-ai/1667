/**
 * Configurable-prompt runtime: pre-dispatch context refusals and
 * generation-intent recovery for default versus changed guidance.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDurableMutationId } from "../shared/durable-mutation-id.js";
import { DEFAULT_WRITING_PROMPT_SETTINGS } from "../shared/settings-v5-writing.js";
import { operationGuidanceContext } from "../shared/writing-prompt-runtime.js";
import { ProviderRecoveryRequiredError, ServiceError } from "../server/errors.js";
import { autonameStory, continueStory, rewriteNode } from "../server/generation-http.js";
import { GenerationAdmissionRegistry } from "../server/generation-admission.js";
import {
  MutationReceiptPersistenceError,
  MutationReceiptStore
} from "../server/mutation-receipts.js";
import { PromptCacheRuntime } from "../server/provider-cache-policy.js";
import { askAside } from "../server/aside-http.js";
import { createSummaryTake } from "../server/summary-take.js";
import type { ProviderStoryRuntime } from "../server/story-mutation-runtime.js";
import {
  OPERATION_GUIDANCE,
  OVERSIZE_GUIDANCE,
  dryRunSettings,
  emptyStory,
  rewriteStory,
  stubSettingsStore
} from "./configurable-prompt-test-helpers.js";

test("oversize Continue guidance refuses before provider dispatch", async () => {
  let providerStarted = false;
  const stories = {
    loadForMutation: async () => emptyStory(),
    hydratePath: async () => {}
  } as unknown as ProviderStoryRuntime<"continueStory">;
  await assert.rejects(
    continueStory(
      "story",
      { parentId: null, instruction: "", genId: "gen-oversize" },
      stories,
      stubSettingsStore(
        { ...dryRunSettings(), contextWindow: 64, maxTokens: 32 },
        { ...DEFAULT_WRITING_PROMPT_SETTINGS, defaultContinueDirection: OVERSIZE_GUIDANCE }
      ),
      new PromptCacheRuntime(),
      new GenerationAdmissionRegistry(),
      () => {},
      new AbortController().signal,
      { providerStarted: () => { providerStarted = true; } }
    ),
    (error: unknown) => error instanceof ServiceError
      && error.status === 400
      && /request prompt is too large/u.test(error.message)
  );
  assert.equal(providerStarted, false);
});

test("oversize Rewrite guidance refuses before provider dispatch", async () => {
  let providerStarted = false;
  const story = rewriteStory();
  const stories = {
    loadForMutation: async () => story,
    hydratePath: async () => {}
  } as unknown as ProviderStoryRuntime<"rewriteNode">;
  await assert.rejects(
    rewriteNode(
      "story",
      "root",
      { start: 0, end: 4, expected: "Root", instruction: "Tighten." },
      stories,
      stubSettingsStore(
        { ...dryRunSettings(), contextWindow: 64, maxTokens: 32 },
        { ...DEFAULT_WRITING_PROMPT_SETTINGS, rewriteGuidance: OVERSIZE_GUIDANCE }
      ),
      new PromptCacheRuntime(),
      () => {},
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      { providerStarted: () => { providerStarted = true; } }
    ),
    (error: unknown) => error instanceof ServiceError
      && error.status === 400
      && /request prompt is too large/u.test(error.message)
  );
  assert.equal(providerStarted, false);
});

test("oversize title guidance refuses before provider dispatch", async () => {
  let providerStarted = false;
  const story = rewriteStory();
  const stories = {
    loadForMutation: async () => story,
    hydratePath: async () => {}
  } as unknown as ProviderStoryRuntime<"autonameStory">;
  await assert.rejects(
    autonameStory(
      "story",
      stories,
      stubSettingsStore(
        { ...dryRunSettings(), contextWindow: 80, maxTokens: 64 },
        { ...DEFAULT_WRITING_PROMPT_SETTINGS, titleGuidance: OVERSIZE_GUIDANCE }
      ),
      new PromptCacheRuntime(),
      new AbortController().signal,
      () => { providerStarted = true; }
    ),
    (error: unknown) => error instanceof ServiceError
      && error.status === 400
      && /request prompt is too large/u.test(error.message)
  );
  assert.equal(providerStarted, false);
});

test("oversize summary guidance refuses before provider dispatch", async () => {
  let providerStarted = false;
  const story = rewriteStory();
  const stories = {
    loadForMutation: async () => story,
    hydratePath: async () => {}
  } as unknown as ProviderStoryRuntime<"createSummaryTake">;
  await assert.rejects(
    createSummaryTake(
      "story",
      { nodeId: "root" },
      stories,
      stubSettingsStore(
        { ...dryRunSettings(), contextWindow: 80, maxTokens: 64 },
        { ...DEFAULT_WRITING_PROMPT_SETTINGS, summaryGuidance: OVERSIZE_GUIDANCE }
      ),
      new PromptCacheRuntime(),
      () => {},
      new AbortController().signal,
      {},
      { providerStarted: () => { providerStarted = true; } }
    ),
    (error: unknown) => error instanceof ServiceError && error.status === 422
  );
  assert.equal(providerStarted, false);
});

test("oversize Aside guidance refuses before provider dispatch", async () => {
  let providerStarted = false;
  const story = rewriteStory();
  const stories = {
    loadForMutation: async () => story,
    hydratePath: async () => {}
  } as unknown as ProviderStoryRuntime<"askAside">;
  await assert.rejects(
    askAside(
      "story",
      { question: "Why?" },
      stories,
      stubSettingsStore(
        { ...dryRunSettings(), contextWindow: 80, maxTokens: 64 },
        { ...DEFAULT_WRITING_PROMPT_SETTINGS, asideGuidance: OVERSIZE_GUIDANCE }
      ),
      new PromptCacheRuntime(),
      () => {},
      new AbortController().signal,
      {
        entryPointsOpen: true,
        loadDocument: async () => null,
        providerStarted: () => { providerStarted = true; }
      }
    ),
    (error: unknown) => error instanceof ServiceError
      && error.status === 422
      && error.code === "content_too_large"
  );
  assert.equal(providerStarted, false);
});

test("Rewrite with nonempty guidance records both the guidance and the contract", async () => {
  const story = rewriteStory();
  let captured: { kind?: string; operationGuidance?: string } | undefined;
  const stories = {
    loadForMutation: async () => story
  } as unknown as ProviderStoryRuntime<"rewriteNode">;
  const stop = new Error("captured");
  await assert.rejects(
    rewriteNode(
      "story",
      "root",
      { start: 0, end: 4, expected: "Root", instruction: "Tighten." },
      stories,
      stubSettingsStore(
        dryRunSettings(),
        { ...DEFAULT_WRITING_PROMPT_SETTINGS, rewriteGuidance: OPERATION_GUIDANCE }
      ),
      new PromptCacheRuntime(),
      () => {},
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      {
        bindIntent: async (_settings, context) => {
          captured = context as { kind?: string; operationGuidance?: string };
          throw stop;
        }
      }
    ),
    (error) => error === stop
  );
  assert.equal(captured?.kind, "rewrite");
  assert.equal(captured?.operationGuidance, OPERATION_GUIDANCE);
});

test("default rewrite intent omits operationGuidance so the fingerprint stays pre-schema-5", () => {
  assert.deepEqual(operationGuidanceContext(""), {});
  assert.deepEqual(operationGuidanceContext(OPERATION_GUIDANCE), {
    operationGuidance: OPERATION_GUIDANCE
  });
});

test("pending generation intent with default prompts resumes; changed guidance conflicts before provider start", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-prompt-intent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receipts = new MutationReceiptStore(
    path.join(root, "receipts"),
    async () => { throw new Error("unused"); }
  );
  await receipts.init();
  const mutationId = createDurableMutationId();
  const input = { storyId: "story", instruction: "" };
  const settings = dryRunSettings();
  let first = true;
  let providerStarted = false;

  const run = async (guidance: string) => receipts.run(
    mutationId,
    "rewriteNode",
    input,
    async (execution) => {
      await execution.bindGenerationIntent(settings, {
        kind: "rewrite",
        ...operationGuidanceContext(guidance)
      });
      if (first) {
        first = false;
        throw new MutationReceiptPersistenceError(new Error("retain pending"));
      }
      providerStarted = true;
      return "ok";
    },
    undefined,
    () => {}
  );

  await assert.rejects(run(""), (error) => error instanceof MutationReceiptPersistenceError);
  assert.equal(await run(""), "ok");
  assert.equal(providerStarted, true);

  first = true;
  providerStarted = false;
  const changedId = createDurableMutationId();
  const runChanged = async (guidance: string) => receipts.run(
    changedId,
    "rewriteNode",
    input,
    async (execution) => {
      await execution.bindGenerationIntent(settings, {
        kind: "rewrite",
        ...operationGuidanceContext(guidance)
      });
      if (first) {
        first = false;
        throw new MutationReceiptPersistenceError(new Error("retain pending"));
      }
      providerStarted = true;
      return "ok";
    },
    undefined,
    () => {}
  );
  await assert.rejects(runChanged(""), (error) => error instanceof MutationReceiptPersistenceError);
  await assert.rejects(runChanged(OPERATION_GUIDANCE), (error: unknown) => error instanceof ServiceError
    && error.code === "idempotency_conflict"
    && /was not sent/u.test(error.message));
  assert.equal(providerStarted, false);
});

test("provider-started receipts with changed guidance stay uncertain and do not claim the request was not sent", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-prompt-started-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receipts = new MutationReceiptStore(
    path.join(root, "receipts"),
    async () => { throw new Error("unused"); }
  );
  await receipts.init();
  const mutationId = createDurableMutationId();
  const input = { storyId: "story", instruction: "" };
  const settings = dryRunSettings();
  let first = true;
  let providerStarted = 0;

  const run = async (guidance: string) => receipts.run(
    mutationId,
    "rewriteNode",
    input,
    async (execution) => {
      await execution.bindGenerationIntent(settings, {
        kind: "rewrite",
        ...operationGuidanceContext(guidance)
      });
      await execution.providerStarted();
      providerStarted += 1;
      if (first) {
        first = false;
        throw new MutationReceiptPersistenceError(new Error("retain started"));
      }
      return "must not dispatch again";
    },
    undefined,
    () => {}
  );

  await assert.rejects(run(""), (error) => error instanceof MutationReceiptPersistenceError);
  await assert.rejects(run(OPERATION_GUIDANCE), (error: unknown) => {
    assert.equal(error instanceof ProviderRecoveryRequiredError, true);
    assert.equal(error instanceof ServiceError && error.message.includes("was not sent"), false);
    return true;
  });
  assert.equal(providerStarted, 1);
});

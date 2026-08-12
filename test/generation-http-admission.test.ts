import assert from "node:assert/strict";
import test from "node:test";
import { continueStory, rewriteNode } from "../server/generation-http.js";
import { GenerationAdmissionRegistry } from "../server/generation-admission.js";
import { LEGACY_PROMPT_CACHE_CONTEXT, PromptCacheRuntime } from "../server/provider-cache-policy.js";
import type { SettingsStore } from "../server/settings.js";
import type { ProviderStoryRuntime } from "../server/story-mutation-runtime.js";
import type { FactBudgetDrop } from "../shared/fact-budget.js";
import type { GenerationSettings, Story } from "../shared/types.js";

const NOW = "2026-01-01T00:00:00.000Z";

// Review finding G (issue #281 round 2): the uninstructed-rewrite path
// admitted Facts against the request's *global* maxTokens instead of the
// much smaller output budget the rewrite itself sends. That reserved far
// more of the window than the real request needs, so admission could shed —
// or refuse to admit — a Fact that fits comfortably in the request actually
// sent to the provider.
test("rewrite admission reserves the rewrite's own output budget, not the global one", async () => {
  // A window generous enough for a big Fact once the rewrite's tiny real
  // output budget (~76 tokens for a one-word plain rewrite) is reserved, but
  // not once the request's global maxTokens (2,048) is reserved instead.
  const settings: GenerationSettings = {
    provider: "dry-run",
    baseUrl: "",
    model: "dry-run",
    apiKeyEnv: null,
    temperature: null,
    maxTokens: 2_048,
    systemPrompt: "Write.",
    contextWindow: 4_096
  };
  const bigFact = {
    id: "big-fact",
    tag: null,
    text: "x".repeat(8_000),
    activation: "always" as const,
    priority: "low" as const,
    keys: [],
    createdAt: NOW,
    updatedAt: NOW
  };
  const story: Story = {
    id: "story",
    title: "Story",
    createdAt: NOW,
    updatedAt: NOW,
    nodes: [{
      id: "root",
      parentId: null,
      instruction: "Begin",
      text: "Root prose continues onward.",
      model: "test",
      createdAt: NOW,
      activeChildId: null
    }],
    activeRootId: "root",
    tags: [],
    recentNodeIds: [],
    facts: [bigFact],
    chapterBreaks: []
  };
  const stories = {
    loadForMutation: async () => story
  } as unknown as ProviderStoryRuntime<"rewriteNode">;
  const settingsStore = {
    loadGeneration: async () => ({ settings, promptCache: LEGACY_PROMPT_CACHE_CONTEXT, imageInputCapability: null })
  } as unknown as SettingsStore;
  const stop = new Error("stop before streaming — bindIntent captured the admitted facts");
  let capturedFacts: string | null | undefined;
  const bindIntent = async (_settings: GenerationSettings, intent: unknown): Promise<void> => {
    capturedFacts = (intent as { facts: string | null }).facts;
    throw stop;
  };

  // No instruction: the popover's plain Regenerate, whose output budget is
  // the tight word-band estimate, not the global cap.
  await assert.rejects(
    rewriteNode(
      "story",
      "root",
      { start: 0, end: 4, expected: "Root" },
      stories,
      settingsStore,
      new PromptCacheRuntime(),
      () => {},
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      { bindIntent }
    ),
    (error) => error === stop
  );

  // Admitted against the rewrite's real ~76-token budget, the big Fact fits
  // (4,096 - 76 leaves ample room) and rides along whole.
  assert.notEqual(capturedFacts, null);
  assert.equal(capturedFacts?.includes("x".repeat(8_000)), true);
});

// Review finding I (issue #281 round 2): continueStory's onFactsDropped
// callback only ever saw admission's window-pressure drops. A Fact removed
// earlier — by its own budgetTokens cap or by the story's Facts budget —
// never reached the callback, so the writer's post-generation report said
// nothing was dropped even though a Fact was silently absent from the prompt.
test("continueStory reports own-cap and story-budget drops, not only window-pressure ones", async () => {
  const overCapFact = {
    id: "over-cap",
    tag: null,
    text: "This fact's text is far longer than its own five-token budget cap allows.",
    activation: "always" as const,
    budgetTokens: 5,
    keys: [],
    createdAt: NOW,
    updatedAt: NOW
  };
  const story: Story = {
    id: "story",
    title: "Story",
    createdAt: NOW,
    updatedAt: NOW,
    nodes: [{
      id: "root",
      parentId: null,
      instruction: "Begin",
      text: "Root prose.",
      model: "test",
      createdAt: NOW,
      activeChildId: null
    }],
    activeRootId: "root",
    tags: [],
    recentNodeIds: [],
    facts: [overCapFact],
    chapterBreaks: []
  };
  const stories = {
    loadForMutation: async () => story
  } as unknown as ProviderStoryRuntime<"continueStory">;
  const settings: GenerationSettings = {
    provider: "dry-run",
    baseUrl: "",
    model: "dry-run",
    apiKeyEnv: null,
    temperature: null,
    maxTokens: 256,
    systemPrompt: "Write.",
    // No window at all: window-pressure shedding never engages, isolating
    // the own-cap drop this test is about.
    contextWindow: null
  };
  const settingsStore = {
    loadGeneration: async () => ({ settings, promptCache: LEGACY_PROMPT_CACHE_CONTEXT, imageInputCapability: null })
  } as unknown as SettingsStore;
  const stop = new Error("stop before streaming — onFactsDropped already fired");
  const bindIntent = async (): Promise<void> => { throw stop; };
  let reported: readonly FactBudgetDrop[] | undefined;

  await assert.rejects(
    continueStory(
      "story",
      { parentId: null, instruction: "Continue.", genId: "own-cap-drop" },
      stories,
      settingsStore,
      new PromptCacheRuntime(),
      new GenerationAdmissionRegistry(),
      () => {},
      new AbortController().signal,
      { bindIntent, onFactsDropped: (dropped) => { reported = dropped; } }
    ),
    (error) => error === stop
  );

  assert.deepEqual(reported, [{ factId: "over-cap", reason: "fact-budget" }]);
});

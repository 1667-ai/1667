import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createChapterBreak } from "../server/chapter-breaks.js";
import { summarizeChapter } from "../server/chapter-summary.js";
import { GenerationAdmissionRegistry } from "../server/generation-admission.js";
import { continueStory, rewriteNode } from "../server/generation-http.js";
import { LEGACY_PROMPT_CACHE_CONTEXT, PromptCacheRuntime } from "../server/provider-cache-policy.js";
import { attachProviderRuntime } from "../server/provider-runtime.js";
import type { SettingsStore } from "../server/settings.js";
import { sha256 } from "../server/story-format.js";
import { StoryObjectStore } from "../server/story-objects.js";
import { StoryStore } from "../server/stories.js";
import { createGenerationRecord } from "../shared/generation-record.js";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
import { MAX_GENERATION_RECORD_IDS, type GenerationSettings } from "../shared/types.js";

test("a full append history refuses before the provider starts", async (t) => {
  const { stories, storyId, nodeId } = await storyWithNodeAtCapacity(t, "append");
  const before = await stories.loadHydrated(storyId);
  const node = before.nodes.find((candidate) => candidate.id === nodeId)!;
  let providerStarted = false;
  let deltas = 0;

  await assert.rejects(
    continueStory(
      storyId,
      {
        appendTo: nodeId,
        expectedTextHash: sha256(node.text),
        instruction: "",
        genId: "gen-capacity-append"
      },
      stories,
      settingsStore(dryRunSettings()),
      new PromptCacheRuntime(),
      new GenerationAdmissionRegistry(),
      () => { deltas += 1; },
      new AbortController().signal,
      { providerStarted: () => { providerStarted = true; } }
    ),
    /maximum of 4096 Generation Records/u
  );
  assert.equal(providerStarted, false);
  assert.equal(deltas, 0);
  const unchanged = await stories.loadHydrated(storyId);
  assert.equal(unchanged.nodes.find((candidate) => candidate.id === nodeId)!.text, node.text);
  await stories.waitForMaintenance();
});

test("a full in-place rewrite history refuses before the provider starts", async (t) => {
  const { stories, storyId, nodeId } = await storyWithNodeAtCapacity(t, "rewrite");
  const before = await stories.loadHydrated(storyId);
  const node = before.nodes.find((candidate) => candidate.id === nodeId)!;
  let providerStarted = false;
  let deltas = 0;

  await assert.rejects(
    rewriteNode(
      storyId,
      nodeId,
      { start: 0, end: node.text.length, expected: node.text, instruction: "Make it vivid." },
      stories,
      settingsStore(dryRunSettings()),
      new PromptCacheRuntime(),
      () => { deltas += 1; },
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      { providerStarted: () => { providerStarted = true; } }
    ),
    /maximum of 4096 Generation Records/u
  );
  assert.equal(providerStarted, false);
  assert.equal(deltas, 0);
  const unchanged = await stories.loadHydrated(storyId);
  assert.equal(unchanged.nodes.find((candidate) => candidate.id === nodeId)!.text, node.text);
  await stories.waitForMaintenance();
});

test("a full chapter-summary history refuses refresh before the provider starts", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-capacity-summary-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");
  const created = await stories.createNode(story.id, null, "A closed chapter.", "");
  let breakId = "";
  await stories.mutate(story.id, (fresh) => {
    breakId = createChapterBreak(fresh, created.nodes[0]!.id, "Chapter one").id;
  });
  await summarizeChapter(
    story.id,
    breakId,
    stories,
    settingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    new AbortController().signal
  );
  const seeded = await stories.load(story.id);
  const summary = seeded.nodes.find((node) => node.chapterBreakId === breakId)!;
  await fillHistory(stories, dir, story.id, summary.id);
  let providerStarted = false;

  await assert.rejects(
    summarizeChapter(
      story.id,
      breakId,
      stories,
      settingsStore(dryRunSettings()),
      new PromptCacheRuntime(),
      new AbortController().signal,
      { providerStarted: () => { providerStarted = true; } }
    ),
    /maximum of 4096 Generation Records/u
  );
  assert.equal(providerStarted, false);
  const unchanged = await stories.load(story.id);
  assert.equal(unchanged.nodes.find((node) => node.id === summary.id)!.text, summary.text);
  await stories.waitForMaintenance();
});

async function storyWithNodeAtCapacity(t: TestContext, suffix: string) {
  const dir = await mkdtemp(path.join(tmpdir(), `1667-generation-record-capacity-${suffix}-`));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");
  const created = await stories.createNode(story.id, null, "The old cat sat on the mat.", "");
  const nodeId = created.nodes[0]!.id;
  await fillHistory(stories, dir, story.id, nodeId);
  return { dir, stories, storyId: story.id, nodeId };
}

async function fillHistory(
  stories: StoryStore,
  dir: string,
  storyId: string,
  nodeId: string
): Promise<void> {
  const objects = new StoryObjectStore(path.join(dir, storyId));
  await objects.init();
  const recordId = await objects.storeGenerationRecord(createGenerationRecord({
    kind: "continue",
    createdAt: "2026-08-10T00:00:00.000Z",
    provider: { provider: "dry-run", model: "dry-run" },
    effective: { wireProtocol: "dry-run", fields: [], adjustments: [] },
    prompt: { operation: "continue", entries: [] }
  }));
  await stories.mutate(storyId, (story) => {
    story.nodes.find((node) => node.id === nodeId)!.generationRecordIds =
      Array.from({ length: MAX_GENERATION_RECORD_IDS }, () => recordId);
  });
}

function dryRunSettings(): GenerationSettings {
  return attachProviderRuntime({
    provider: "dry-run",
    baseUrl: "",
    model: "dry-run",
    apiKeyEnv: null,
    temperature: null,
    maxTokens: 256,
    systemPrompt: "Write.",
    contextWindow: null
  }, {
    preset: "dry-run",
    auth: { type: "none" },
    headers: [],
    timeouts: { responseHeaderMs: 1_000, firstTokenMs: 1_000, idleMs: 1_000, totalMs: 5_000 },
    allowInsecureHttp: false,
    effort: "default",
    tokenProbabilities: null,
    sampling: EMPTY_SAMPLING_V2,
    capabilities: {
      temperature: "supported",
      assistantPrefill: "unsupported",
      reasoningEffort: "unsupported",
      promptCaching: "unsupported"
    }
  }, true);
}

function settingsStore(settings: GenerationSettings): SettingsStore {
  return {
    loadGeneration: async () => ({ settings, promptCache: LEGACY_PROMPT_CACHE_CONTEXT, imageInputCapability: null })
  } as unknown as SettingsStore;
}

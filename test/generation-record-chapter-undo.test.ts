import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDurableMutationId } from "../shared/durable-mutation-id.js";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";
import {
  chapterBreakRemovalFingerprint,
  createChapterBreak,
  removeChapterBreak,
  restoreChapterBreak,
  type RemovedChapterBreak
} from "../server/chapter-breaks.js";
import { MUTATION_RECEIPT_DIRECTORY } from "../server/chapter-break-undo-liveness.js";
import { summarizeChapter } from "../server/chapter-summary.js";
import { MutationReceiptStore } from "../server/mutation-receipts.js";
import { LEGACY_PROMPT_CACHE_CONTEXT, PromptCacheRuntime } from "../server/provider-cache-policy.js";
import { attachProviderRuntime } from "../server/provider-runtime.js";
import type { SettingsStore } from "../server/settings.js";
import { StoryObjectStore } from "../server/story-objects.js";
import { buildStoryPayload } from "../server/story-payload.js";
import { StoryStore } from "../server/stories.js";

test("chapter-summary undo keeps its Generation Record graph live through removal cleanup", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-chapter-undo-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storyDir = path.join(dir, "stories");
  const receiptDir = path.join(dir, MUTATION_RECEIPT_DIRECTORY);
  let receipts: MutationReceiptStore | undefined;
  const stories = new StoryStore(
    storyDir,
    { liveGenerationRecordIds: (storyId) => receipts!.liveGenerationRecordIds(storyId) }
  );
  await stories.init();
  receipts = new MutationReceiptStore(
    receiptDir,
    async (id) => buildStoryPayload(await stories.load(id))
  );
  await receipts.init();
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
  const before = await stories.load(story.id);
  const summary = before.nodes.find((node) => node.chapterBreakId === breakId)!;
  const recordId = summary.generationRecordIds?.[0];
  if (recordId === undefined) throw new Error("chapter summary did not store a Generation Record");

  const preview = await stories.loadForMutation(story.id);
  const expectedRemoved = removeChapterBreak(preview, breakId);
  const removedFingerprint = chapterBreakRemovalFingerprint(expectedRemoved);
  const mutationId = createDurableMutationId();
  let removed: RemovedChapterBreak | undefined;
  await receipts.run(
    mutationId,
    "removeChapterBreak",
    { storyId: story.id, breakId, removedFingerprint },
    async (plan) => {
      const preserved = await plan.preserveChapterBreakRemoval(
        removedFingerprint,
        async () => expectedRemoved
      );
      await stories.mutate(story.id, (fresh) => { removed = removeChapterBreak(fresh, breakId); });
      assert.deepEqual(removed, preserved);
      // Force the dangerous ordering: cleanup completes while the outer
      // receipt is still pending. Its pre-commit artifact must already own
      // the detached Generation Record graph.
      await stories.waitForMaintenance();
      return { payload: buildStoryPayload(await stories.load(story.id)), removed: preserved };
    },
    undefined,
    async () => {}
  );

  const storedReceipt = JSON.parse(
    await readFile(path.join(receiptDir, `${mutationId}.json`), "utf8")
  ) as { artifact?: { storyId?: string } };
  assert.equal(storedReceipt.artifact?.storyId, story.id);
  const objects = new StoryObjectStore(path.join(storyDir, story.id));
  await objects.readGenerationRecord(recordId);

  if (removed === undefined) throw new Error("chapter removal did not return its undo payload");
  await stories.mutate(story.id, (fresh) => { restoreChapterBreak(fresh, breakId, removed!); });
  const restored = await stories.load(story.id);
  const restoredSummary = restored.nodes.find((node) => node.id === summary.id)!;
  assert.deepEqual(restoredSummary.generationRecordIds, [recordId]);
  assert.equal((await stories.loadGenerationRecord(story.id, summary.id, recordId)).kind, "chapter-summary");
  await stories.waitForMaintenance();
});

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

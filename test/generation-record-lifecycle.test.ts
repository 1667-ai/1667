import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { summarizeChapter } from "../server/chapter-summary.js";
import { createChapterBreak } from "../server/chapter-breaks.js";
import { continueStory, rewriteNode } from "../server/generation-http.js";
import { GenerationAdmissionRegistry } from "../server/generation-admission.js";
import { LEGACY_PROMPT_CACHE_CONTEXT, PromptCacheRuntime } from "../server/provider-cache-policy.js";
import { attachProviderRuntime } from "../server/provider-runtime.js";
import { StoryObjectStore } from "../server/story-objects.js";
import {
  chunkId,
  chunkText,
  createRevision,
  type ObjectHash,
  revisionId,
  sha256
} from "../server/story-format.js";
import { STORY_LIST_IO_CONCURRENCY, StoryStore } from "../server/stories.js";
import { createSummaryTake } from "../server/summary-take.js";
import type { SettingsStore } from "../server/settings.js";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
import { MAX_GENERATION_RECORD_TEXT_CHARS } from "../shared/generation-record.js";
import { MAX_GENERATION_RECORD_IDS, type GenerationSettings } from "../shared/types.js";

/**
 * Generation Records: every model request that creates or changes a take
 * gets a durable, content-addressed record beside it (mirrors issue #291's
 * token-probability storage — see test/token-probability-storage.test.ts).
 * The dry-run provider fabricates deterministic completions, which is what
 * makes these end-to-end assertions possible without a real model.
 *
 * This file covers the per-commit lifecycle — create, over-limit, append,
 * in-place rewrite, delete — and the manifest field that carries a take's
 * record ids. See test/generation-record-pipeline.test.ts for the ordered
 * prompt-pipeline content a record captures, and
 * test/generation-record-http.test.ts for the HTTP routes.
 */

test("a continuation stores a Generation Record, ordered first on the node's history", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const result = await continueStory(
    story.id,
    { parentId: null, instruction: "Continue.", genId: "gen-store" },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal
  );
  const node = result?.nodes[0];
  if (node === undefined) throw new Error("continuation did not commit a take");
  assert.deepEqual(node.generationRecordIds?.length, 1);

  const summaries = await stories.loadGenerationRecordSummaries(story.id, node.id);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]!.kind, "continue");
  assert.equal(summaries[0]!.id, node.generationRecordIds![0]);
  // Shape contract: a summary carries only the history-list projection —
  // never a full record's prompt pipeline or effective parameters, which
  // stay behind the per-id detail route (see server/stories.ts's
  // loadGenerationRecordSummaries doc comment on why it must never retain a
  // full record beyond its own projection step).
  assert.deepEqual(Object.keys(summaries[0]!).sort(), ["createdAt", "id", "kind"]);

  const record = await stories.loadGenerationRecord(story.id, node.id, summaries[0]!.id);
  assert.equal(record.format, "1667-generation-record");
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.kind, "continue");
  assert.equal(record.provider.provider, "dry-run");
  assert.equal(record.prompt.operation, "continue");
  assert.equal(record.effective.wireProtocol, "dry-run");
  // A request block is always present — the volatile instruction this take
  // actually asked for.
  assert.ok(record.prompt.entries.some((entry) => entry.kind === "request" && entry.source === "text"));

  const again = await stories.loadGenerationRecord(story.id, node.id, summaries[0]!.id);
  assert.deepEqual(again, record);
  await stories.waitForMaintenance();
});

test("an over-limit prompt stores an explicit unsupported record instead of a truncated pipeline", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-bound-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const result = await continueStory(
    story.id,
    {
      parentId: null,
      instruction: "x".repeat(MAX_GENERATION_RECORD_TEXT_CHARS + 1),
      genId: "gen-over-limit"
    },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal
  );
  const node = result?.nodes[0];
  if (node === undefined) throw new Error("continuation did not commit a take");
  const recordId = node.generationRecordIds?.[0];
  if (recordId === undefined) throw new Error("continuation did not store a Generation Record");

  const record = await stories.loadGenerationRecord(story.id, node.id, recordId);
  assert.equal(record.kind, "unsupported");
  assert.deepEqual(record.prompt.entries, []);
  assert.match(record.unsupportedReason ?? "", /exceeds the 65536-character limit/u);
  await stories.waitForMaintenance();
});

test("an append adds a second Generation Record after the first, both readable in order", async (t) => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  t.after(() => { console.warn = originalWarn; });
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-append-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const first = await continueStory(
    story.id,
    { parentId: null, instruction: "Continue.", genId: "gen-append-root" },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal
  );
  const rootId = first?.nodes[0]?.id;
  if (rootId === undefined) throw new Error("root continuation did not commit a take");
  const beforeText = first!.nodes.find((node) => node.id === rootId)!.text;
  const firstRecordId = first!.nodes.find((node) => node.id === rootId)!.generationRecordIds![0]!;

  const second = await continueStory(
    story.id,
    {
      appendTo: rootId,
      expectedTextHash: sha256(beforeText),
      instruction: "",
      genId: "gen-append-tail"
    },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal
  );
  const afterNode = second?.nodes.find((node) => node.id === rootId);
  if (afterNode === undefined) throw new Error("append did not commit");

  const ids = afterNode.generationRecordIds!;
  assert.equal(ids.length, 2);
  assert.equal(ids[0], firstRecordId);
  assert.notEqual(ids[1], firstRecordId);

  const summaries = await stories.loadGenerationRecordSummaries(story.id, rootId);
  assert.deepEqual(summaries.map((summary) => summary.id), ids);
  assert.equal(summaries[0]!.kind, "continue");
  assert.equal(summaries[1]!.kind, "append");
  const appendRecord = await stories.loadGenerationRecord(story.id, rootId, ids[1]!);
  assert.equal(appendRecord.range?.start, beforeText.length);
  assert.equal(appendRecord.range?.end, afterNode.text.length);
  // The append shrinks the root's live revision set (its old, pre-append
  // text is no longer the current one), which schedules a deferred sweep.
  // Drain it before this test's own temp-directory cleanup runs, or the
  // two race: a sweep still reading a generation-record object after `rm`
  // has already removed the directory logs a spurious "missing object"
  // warning that has nothing to do with story storage correctness.
  await stories.waitForMaintenance();
  assert.deepEqual(warnings, [], "expected no storage warnings while appending and settling cleanup");
});

test("cancelling a full Generation Record history read releases its bounded work", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-history-cancel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");
  const result = await continueStory(
    story.id,
    { parentId: null, instruction: "Continue.", genId: "gen-history-cancel" },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal
  );
  const node = result?.nodes[0];
  const recordId = node?.generationRecordIds?.[0];
  if (node === undefined || recordId === undefined) throw new Error("continuation did not store a Generation Record");
  await stories.mutate(story.id, (fresh) => {
    fresh.nodes.find((candidate) => candidate.id === node.id)!.generationRecordIds =
      Array.from({ length: MAX_GENERATION_RECORD_IDS }, () => recordId);
  });
  await stories.waitForMaintenance();

  const controller = new AbortController();
  const cancellation = new Error("history read cancelled");
  let calls = 0;
  const originalRead = StoryObjectStore.prototype.readGenerationRecord;
  t.mock.method(
    StoryObjectStore.prototype,
    "readGenerationRecord",
    async function (this: StoryObjectStore, id: ObjectHash) {
      calls += 1;
      if (calls === 1) setTimeout(() => controller.abort(cancellation), 1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return await originalRead.call(this, id);
    }
  );

  await assert.rejects(
    stories.loadGenerationRecordSummaries(story.id, node.id, controller.signal),
    (error) => error === cancellation
  );
  assert.ok(
    calls <= STORY_LIST_IO_CONCURRENCY,
    `cancellation must stop new history reads after the active batch, got ${calls}`
  );
});

test("an in-place rewrite records the replaced range as a Generation Record", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-rewrite-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const created = await stories.createNode(story.id, null, "The old cat sat on the mat.", "");
  const nodeId = created.nodes[0]!.id;

  const start = "The old cat".length;
  const end = "The old cat sat".length;
  const expected = created.nodes[0]!.text.slice(start, end);
  await rewriteNode(
    story.id,
    nodeId,
    { start, end, expected, instruction: "Make it vivid." },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    () => {},
    new AbortController().signal
  );

  const reloaded = await stories.loadHydrated(story.id);
  const node = reloaded.nodes.find((candidate) => candidate.id === nodeId)!;
  assert.equal(node.generationRecordIds?.length, 1);
  const record = await stories.loadGenerationRecord(story.id, nodeId, node.generationRecordIds![0]!);
  assert.equal(record.kind, "rewrite-in-place");
  assert.equal(record.range?.start, start);
  await stories.waitForMaintenance();
});

test("a rewrite take stores its own Generation Record without changing the source take", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-retake-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");
  const created = await stories.createNode(story.id, null, "The old cat sat on the mat.", "");
  const source = created.nodes[0]!;

  const takeId = await rewriteNode(
    story.id,
    source.id,
    {
      start: 0,
      end: source.text.length,
      expected: source.text,
      instruction: "Make it vivid.",
      destination: "take"
    },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    () => {},
    new AbortController().signal
  );
  if (takeId === null) throw new Error("rewrite take did not commit");

  const reloaded = await stories.loadHydrated(story.id);
  const unchangedSource = reloaded.nodes.find((node) => node.id === source.id)!;
  const take = reloaded.nodes.find((node) => node.id === takeId)!;
  assert.equal(unchangedSource.text, source.text);
  assert.equal(unchangedSource.generationRecordIds, undefined);
  assert.equal(take.generationRecordIds?.length, 1);
  const record = await stories.loadGenerationRecord(story.id, take.id, take.generationRecordIds![0]!);
  assert.equal(record.kind, "rewrite-take");
  assert.deepEqual(record.range, { start: 0, end: take.text.length });
  await stories.waitForMaintenance();
});

test("a summary take stores the request record on the generated summary", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-summary-take-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");
  const created = await stories.createNode(story.id, null, "A chapter worth remembering.", "");

  const summaryId = await createSummaryTake(
    story.id,
    { nodeId: created.nodes[0]!.id },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    () => {},
    new AbortController().signal
  );
  if (summaryId === null) throw new Error("summary take did not commit");

  const reloaded = await stories.load(story.id);
  const summary = reloaded.nodes.find((node) => node.id === summaryId)!;
  assert.equal(summary.role, "summary");
  assert.equal(summary.generationRecordIds?.length, 1);
  const record = await stories.loadGenerationRecord(story.id, summary.id, summary.generationRecordIds![0]!);
  assert.equal(record.kind, "summary-take");
  assert.equal(record.prompt.operation, "summary");
  await stories.waitForMaintenance();
});

test("a chapter summary stores the request record on the chapter summary take", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-chapter-summary-"));
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
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    new AbortController().signal
  );

  const reloaded = await stories.load(story.id);
  const summary = reloaded.nodes.find((node) => node.chapterBreakId === breakId)!;
  assert.equal(summary.generationRecordIds?.length, 1);
  const record = await stories.loadGenerationRecord(story.id, summary.id, summary.generationRecordIds![0]!);
  assert.equal(record.kind, "chapter-summary");
  assert.equal(record.prompt.operation, "summary");
  await stories.waitForMaintenance();
});

test("an append raced by a mid-stream chapter break still commits a retargeted Generation Record", async (t) => {
  // Every construction site for ContinueStoryEffect, RewriteNodeEffect,
  // SummaryTakeEffect, and ChapterSummaryEffect must produce a Generation
  // Record — the type now requires one — but the retarget path in
  // `applyContinuation` (server/story-provider-effect.ts) rebuilds that
  // field from scratch when a chapter break lands on the append's target
  // between request start and commit. This exercises that race through the
  // real `continueStory` HTTP path end to end, proving the record survives
  // the retarget instead of the append silently losing its provenance.
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-append-race-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");
  const created = await stories.createNode(story.id, null, "The latch was unlo", "");
  const root = created.nodes[0]!;

  let breakCreated = false;
  const committed = await continueStory(
    story.id,
    {
      appendTo: root.id,
      expectedTextHash: sha256(root.text),
      instruction: "",
      genId: "gen-append-race"
    },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    async () => {
      if (breakCreated) return;
      breakCreated = true;
      await stories.mutate(story.id, (fresh) => {
        createChapterBreak(fresh, root.id, "Chapter 1");
      });
    },
    new AbortController().signal
  );

  const added = committed?.nodes.find((node) => node.genId === "gen-append-race");
  if (added === undefined) throw new Error("retargeted continuation did not create a take");
  assert.notEqual(added.id, root.id);
  assert.equal(added.parentId, root.id);
  assert.equal(added.generationRecordIds?.length, 1);
  const record = await stories.loadGenerationRecord(story.id, added.id, added.generationRecordIds![0]!);
  // The original request streamed as an append (kind "append", ranged); the
  // retarget rewrites it into a whole-take continuation instead of leaving
  // the stale append shape or dropping the record outright.
  assert.equal(record.kind, "continue");
  assert.equal(record.range, undefined);
  await stories.waitForMaintenance();
});

test("deleting the take sweeps its Generation Record away", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-prune-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const result = await continueStory(
    story.id,
    { parentId: null, instruction: "Continue.", genId: "gen-prune" },
    stories,
    stubSettingsStore(dryRunSettings()),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal
  );
  const nodeId = result?.nodes[0]?.id;
  const recordId = result?.nodes[0]?.generationRecordIds?.[0];
  if (nodeId === undefined || recordId === undefined) throw new Error("continuation did not commit a take");
  const generatedText = result!.nodes[0]!.text;
  // Keep the generated revision live through a human sibling. Cleanup must
  // still notice that the deleted take's distinct Generation Record vanished;
  // comparing only revision IDs would miss this case.
  await stories.createNode(story.id, null, generatedText, "");
  const objects = new StoryObjectStore(path.join(dir, story.id));
  const recordPath = objects.objectPath("generation-records", recordId);
  const revisionPath = objects.objectPath(
    "revisions",
    revisionId(createRevision(chunkText(generatedText).map(chunkId), generatedText.length))
  );
  await readFile(recordPath);
  await readFile(revisionPath);

  await stories.deleteNode(story.id, nodeId, 1);
  await stories.waitForMaintenance();

  await assert.rejects(() => readFile(recordPath), /ENOENT/);
  await readFile(revisionPath); // the sibling still owns this revision
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
    timeouts: {
      responseHeaderMs: 1_000,
      firstTokenMs: 1_000,
      idleMs: 1_000,
      totalMs: 5_000
    },
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

function stubSettingsStore(settings: GenerationSettings): SettingsStore {
  return {
    loadGeneration: async () => ({ settings, promptCache: LEGACY_PROMPT_CACHE_CONTEXT }),
    loadImageInputCapability: async () => null
  } as unknown as SettingsStore;
}

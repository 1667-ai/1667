import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { continueStory } from "../server/generation-http.js";
import { GenerationAdmissionRegistry } from "../server/generation-admission.js";
import { LEGACY_PROMPT_CACHE_CONTEXT, PromptCacheRuntime } from "../server/provider-cache-policy.js";
import { attachProviderRuntime } from "../server/provider-runtime.js";
import { parseManifest, serializeManifest, sha256 } from "../server/story-format.js";
import { commitTake } from "../server/story-nodes.js";
import { StoryStore } from "../server/stories.js";
import type { SettingsStore } from "../server/settings.js";
import type { CapturedReasoning } from "../shared/reasoning.js";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";
import { ApiHttpError } from "../tui/src/api-error.js";
import { createApi } from "../tui/src/api.js";
import { attachHttpServer } from "../tui/src/http-attach.js";
import { testApp } from "./story-server-fixture.js";

/**
 * Reasoning ("thought") as a durable, content-addressed object beside the
 * take — mirroring shared/token-probabilities.ts and
 * test/token-probability-storage.test.ts exactly. Dry-run
 * (server/providers.ts's streamDryRun) fabricates a short, deterministic
 * thought on every stream unconditionally, unlike token probabilities:
 * nothing needs enabling on the profile to exercise storage end to end.
 */

const NOW = "2026-01-01T00:00:00.000Z";
const HASH = "a".repeat(64);

test("a dry-run continuation stores its thought, and a reload reads the same record back", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-reasoning-store-"));
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
  assert.equal(node.reasoning, true);

  const record = await stories.loadReasoning(story.id, node.id);
  assert.equal(record.format, "1667-reasoning");
  assert.equal(record.schemaVersion, 1);
  assert.ok(record.text.length > 0);
  assert.ok(record.tokenCount > 0);

  // A fresh load of the story carries presence only, never the record.
  const reloaded = await stories.load(story.id);
  const reloadedNode = reloaded.nodes.find((candidate) => candidate.id === node.id);
  assert.equal(reloadedNode?.reasoning, true);

  // A second, independent read returns byte-identical data — the object was
  // truly persisted, not held only in the process that generated it.
  const again = await stories.loadReasoning(story.id, node.id);
  assert.deepEqual(again, record);
  await stories.waitForMaintenance();
});

test("a writer who keeps no thoughts still streams one, but stores nothing", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-reasoning-discard-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  let streamed = "";
  const result = await continueStory(
    story.id,
    { parentId: null, instruction: "Continue.", genId: "gen-discard" },
    stories,
    stubSettingsStore(dryRunSettings(false)),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal,
    undefined,
    undefined,
    undefined,
    (delta) => { streamed += delta.text; }
  );
  const node = result?.nodes[0];
  if (node === undefined) throw new Error("continuation did not commit a take");

  // The reader still watched the model think; the thought just did not
  // outlive the stream.
  assert.ok(streamed.length > 0);
  assert.equal(node.reasoning, undefined);
  await assert.rejects(
    () => stories.loadReasoning(story.id, node.id),
    /has no stored thought/
  );
  const manifestRaw = await readFile(path.join(dir, story.id, "manifest.json"), "utf8");
  assert.equal(manifestRaw.includes("reasoningId"), false);
  await stories.waitForMaintenance();
});

test("a human take stores no thought, and asking for one 404s distinguishably", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-reasoning-human-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const written = await stories.createNode(story.id, null, "Human prose.", "");
  const node = written.nodes[0];
  if (node === undefined) throw new Error("human take did not commit");
  assert.equal(node.reasoning, undefined);

  await assert.rejects(
    () => stories.loadReasoning(story.id, node.id),
    /has no stored thought/
  );
  const manifestRaw = await readFile(path.join(dir, story.id, "manifest.json"), "utf8");
  assert.equal(manifestRaw.includes("reasoningId"), false);
  await stories.waitForMaintenance();
});

test("each take keeps its own thought, and the right one follows the right take", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-reasoning-right-take-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const root = await stories.withLock(story.id, async () => {
    const mutable = await stories.loadForMutation(story.id);
    commitTake(mutable, {
      parentId: null,
      appendTo: null,
      expectedTextHash: null,
      instruction: "Continue.",
      text: "Root prose.",
      model: "dry-run",
      genId: "gen-right-take-root"
    });
    await stories.save(mutable);
    return mutable.nodes[0]!;
  });

  const thoughtA: CapturedReasoning = { text: "Thought A: picks the garden path.", tokenCount: 6 };
  const thoughtB: CapturedReasoning = { text: "Thought B: picks the storm instead.", tokenCount: 7 };

  const { takeAId, takeBId } = await stories.withLock(story.id, async () => {
    const mutable = await stories.loadForMutation(story.id);
    commitTake(mutable, {
      parentId: root.id,
      appendTo: null,
      expectedTextHash: null,
      instruction: "Continue.",
      text: "Sibling A prose.",
      model: "dry-run",
      genId: "gen-right-take-a",
      reasoning: thoughtA
    });
    commitTake(mutable, {
      parentId: root.id,
      appendTo: null,
      expectedTextHash: null,
      instruction: "Continue.",
      text: "Sibling B prose.",
      model: "dry-run",
      genId: "gen-right-take-b",
      reasoning: thoughtB
    });
    await stories.save(mutable);
    const takeA = mutable.nodes.find((candidate) => candidate.genId === "gen-right-take-a")!;
    const takeB = mutable.nodes.find((candidate) => candidate.genId === "gen-right-take-b")!;
    return { takeAId: takeA.id, takeBId: takeB.id };
  });
  await stories.waitForMaintenance();

  const reloaded = await stories.load(story.id);
  const reloadedA = reloaded.nodes.find((candidate) => candidate.id === takeAId);
  const reloadedB = reloaded.nodes.find((candidate) => candidate.id === takeBId);
  assert.equal(reloadedA?.reasoning, true);
  assert.equal(reloadedB?.reasoning, true);

  const recordA = await stories.loadReasoning(story.id, takeAId);
  const recordB = await stories.loadReasoning(story.id, takeBId);
  assert.equal(recordA.text, thoughtA.text);
  assert.equal(recordB.text, thoughtB.text);
  assert.notEqual(recordA.text, recordB.text);
});

test("an in-place rewrite that produces no thought clears the take's old one", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-reasoning-rewrite-clears-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const original: CapturedReasoning = { text: "Original thought before the rewrite.", tokenCount: 5 };
  const node = await stories.withLock(story.id, async () => {
    const mutable = await stories.loadForMutation(story.id);
    commitTake(mutable, {
      parentId: null,
      appendTo: null,
      expectedTextHash: null,
      instruction: "Continue.",
      text: "Original prose.",
      model: "dry-run",
      genId: "gen-rewrite-clear-root",
      reasoning: original
    });
    await stories.save(mutable);
    return mutable.nodes[0]!;
  });
  assert.equal(node.reasoning, true);
  assert.equal((await stories.loadReasoning(story.id, node.id)).text, original.text);

  const rewritten = await stories.commitProviderEffect(story.id, {
    kind: "rewrite",
    nodeId: node.id,
    expectedText: node.text,
    expectedInstruction: node.instruction,
    text: "Replaced prose, no fresh thought this attempt.",
    updatedAt: new Date().toISOString(),
    reasoning: null
  });
  assert.equal(rewritten.id, node.id, "an in-place rewrite keeps the same take id");
  assert.equal(rewritten.reasoning, undefined);
  await stories.waitForMaintenance();

  const reloaded = await stories.load(story.id);
  const reloadedNode = reloaded.nodes.find((candidate) => candidate.id === node.id);
  assert.equal(reloadedNode?.reasoning, undefined);
  await assert.rejects(
    () => stories.loadReasoning(story.id, node.id),
    /has no stored thought/
  );
  const manifestRaw = await readFile(path.join(dir, story.id, "manifest.json"), "utf8");
  assert.equal(manifestRaw.includes("reasoningId"), false);
});

test("an append with no fresh thought this attempt leaves the take's earlier thought in place", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-reasoning-append-keeps-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const original: CapturedReasoning = { text: "The thought behind the opening line.", tokenCount: 6 };
  const root = await stories.withLock(story.id, async () => {
    const mutable = await stories.loadForMutation(story.id);
    commitTake(mutable, {
      parentId: null,
      appendTo: null,
      expectedTextHash: null,
      instruction: "Continue.",
      text: "Root prose.",
      model: "dry-run",
      genId: "gen-append-keeps-root",
      reasoning: original
    });
    await stories.save(mutable);
    return mutable.nodes[0]!;
  });

  await stories.withLock(story.id, async () => {
    const mutable = await stories.loadForMutation(story.id);
    const target = mutable.nodes.find((candidate) => candidate.id === root.id)!;
    commitTake(mutable, {
      parentId: target.parentId,
      appendTo: target.id,
      expectedTextHash: sha256(target.text),
      instruction: "",
      text: " More prose from the append.",
      model: "dry-run",
      genId: "gen-append-keeps-tail"
      // No `reasoning`: this attempt captured none.
    });
    await stories.save(mutable);
  });
  await stories.waitForMaintenance();

  const reloaded = await stories.load(story.id);
  const node = reloaded.nodes.find((candidate) => candidate.id === root.id);
  if (node === undefined) throw new Error("append did not commit");
  assert.ok(node.text.length > "Root prose.".length, "the append actually grew the take");
  assert.equal(node.reasoning, true);
  assert.equal((await stories.loadReasoning(story.id, root.id)).text, original.text);
});

test("a V5 manifest without reasoningId round-trips byte-for-byte", () => {
  const manifest = {
    format: "1667-story",
    schemaVersion: 5,
    id: "story-one",
    title: "Story",
    createdAt: NOW,
    updatedAt: NOW,
    activeWordCount: 0,
    nodes: [{
      id: "root",
      parentId: null,
      instruction: "",
      model: "test",
      createdAt: NOW,
      preview: "",
      words: 0,
      tokens: 0,
      revisionId: HASH,
      activeChildId: null
    }],
    facts: [],
    activeRootId: "root",
    bookmarks: [],
    recentNodeIds: [],
    chapterBreaks: []
  };
  const raw = `${JSON.stringify(manifest, null, 2)}\n`;
  const parsed = parseManifest(raw, "story-one");
  assert.equal("reasoningId" in parsed.nodes[0]!, false);
  assert.equal(serializeManifest(parsed), raw);
});

const linuxTest = process.platform === "linux" ? test : test.skip;

linuxTest("the read route returns the stored thought, and 404s for a take without one", async (t) => {
  const base = await testApp(t, "1667-reasoning-http-");
  const attach = await attachHttpServer(base);
  t.after(() => attach.dispose());
  const api = createApi(base, undefined, attach);

  const created = await api.createStory("Story");
  const result = await api.continueStory(
    created.id,
    "Continue.",
    "gen-http",
    { parentId: null },
    () => {},
    new AbortController().signal
  );
  const nodeId = result?.payload.path.at(-1)?.id;
  if (nodeId === undefined) throw new Error("continuation did not commit a take");
  assert.equal(result?.payload.nodes.find((node) => node.id === nodeId)?.reasoning, true);

  const record = await api.getReasoning(created.id, nodeId);
  assert.equal(record.format, "1667-reasoning");
  assert.ok(record.text.length > 0);

  // A human take, on an independent line: never asked a model for anything.
  const human = await api.createNode(created.id, { parentId: null, text: "Human prose." });
  const humanNodeId = human.path.at(-1)?.id;
  if (humanNodeId === undefined) throw new Error("human take did not commit");
  await assert.rejects(
    () => api.getReasoning(created.id, humanNodeId),
    (error: unknown) => error instanceof ApiHttpError && error.status === 404
  );
});

function dryRunSettings(keepReasoning = true): GenerationSettings {
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
    keepReasoning,
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
    loadGeneration: async () => ({ settings, promptCache: LEGACY_PROMPT_CACHE_CONTEXT })
  } as unknown as SettingsStore;
}

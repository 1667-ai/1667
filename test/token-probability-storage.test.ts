import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { continueStory } from "../server/generation-http.js";
import { GenerationAdmissionRegistry } from "../server/generation-admission.js";
import { LEGACY_PROMPT_CACHE_CONTEXT, PromptCacheRuntime } from "../server/provider-cache-policy.js";
import { attachProviderRuntime } from "../server/provider-runtime.js";
import { StoryObjectStore } from "../server/story-objects.js";
import { parseManifest, serializeManifest, sha256, type StoryManifestV5 } from "../server/story-format.js";
import { commitTake } from "../server/story-nodes.js";
import { StoryStore } from "../server/stories.js";
import type { SettingsStore } from "../server/settings.js";
import { createTokenProbabilities } from "../shared/token-probabilities.js";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";
import { createDurableMutationId } from "../shared/durable-mutation-id.js";
import { ApiHttpError } from "../tui/src/api-error.js";
import { createApi } from "../tui/src/api.js";
import { attachHttpServer } from "../tui/src/http-attach.js";
import { testApp } from "./story-server-fixture.js";

/**
 * Issue #291 phase 3: token probabilities as a durable, content-addressed
 * object beside the take. The dry-run provider (server/token-probability-
 * capture.ts) fabricates a deterministic record whenever the profile asks
 * for one, which is what makes these end-to-end assertions possible without
 * a real model.
 *
 * The addendum tests below (append, replace, misalignment) cover
 * server/story-node-text.ts's attachTakeTokenProbabilities, which places
 * those captured steps inside the take's actual stored text — see
 * shared/token-probabilities.ts's alignTokenProbabilities, unit-tested
 * directly in test/token-probabilities.test.ts.
 */

const NOW = "2026-01-01T00:00:00.000Z";
const HASH = "a".repeat(64);

test("a dry-run continuation with the profile field set stores the object, and a reload reads the same record back", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-token-probability-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const result = await continueStory(
    story.id,
    { parentId: null, instruction: "Continue.", genId: "gen-store" },
    stories,
    stubSettingsStore(dryRunSettings(4)),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal
  );
  const node = result?.nodes[0];
  if (node === undefined) throw new Error("continuation did not commit a take");
  assert.equal(node.tokenProbabilities, true);

  const record = await stories.loadTokenProbabilities(story.id, node.id);
  assert.equal(record.format, "1667-token-probabilities");
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.requested, 4);
  assert.ok(record.steps.length > 0);

  // A fresh load of the story carries presence only, never the record.
  const reloaded = await stories.load(story.id);
  const reloadedNode = reloaded.nodes.find((candidate) => candidate.id === node.id);
  assert.equal(reloadedNode?.tokenProbabilities, true);

  // The read route's own storage path returns byte-identical data on a
  // second, independent read — the object was truly persisted, not held
  // only in the process that generated it.
  const again = await stories.loadTokenProbabilities(story.id, node.id);
  assert.deepEqual(again, record);
});

test("with the field unset, no object is written and the node has no hash", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-token-probability-unset-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const result = await continueStory(
    story.id,
    { parentId: null, instruction: "Continue.", genId: "gen-unset" },
    stories,
    stubSettingsStore(dryRunSettings(null)),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal
  );
  const node = result?.nodes[0];
  if (node === undefined) throw new Error("continuation did not commit a take");
  assert.equal(node.tokenProbabilities, undefined);

  await assert.rejects(
    () => stories.loadTokenProbabilities(story.id, node.id),
    /no stored token probabilities/
  );

  const manifestRaw = await readFile(path.join(dir, story.id, "manifest.json"), "utf8");
  assert.equal(manifestRaw.includes("tokenProbabilityId"), false);
  const probabilitiesDir = await readdir(path.join(dir, story.id, "probabilities")).catch(() => []);
  assert.deepEqual(probabilitiesDir, []);
});

test("a new take stores textOffset 0 when nothing was trimmed", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-token-probability-offset-zero-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const result = await continueStory(
    story.id,
    { parentId: null, instruction: "Continue.", genId: "gen-offset-zero" },
    stories,
    stubSettingsStore(dryRunSettings(3)),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal
  );
  const node = result?.nodes[0];
  if (node === undefined) throw new Error("continuation did not commit a take");
  assert.equal(node.tokenProbabilities, true);

  const record = await stories.loadTokenProbabilities(story.id, node.id);
  assert.equal(record.textOffset, 0);
  // Nothing was trimmed: the recording covers the whole stored text, not
  // just a piece of it.
  assert.equal(record.steps.map((step) => step.token).join(""), node.text);
});

// The append path is 1667's primary generation gesture (issue #291
// addendum): an empty instruction on the active leaf is "continue", so most
// generations append rather than start a new take. Dry-run has no assistant
// prefill (see dryRunSettings' capabilities below), so this exercises the
// echoed-anchor case of alignTokenProbabilities for real — AnchoredOutputFilter
// strips the echo from the appended text while the captured steps still
// include it.
test("an append continuation stores a record whose textOffset is the take's length before the append, and whose steps cover exactly the appended text", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-token-probability-append-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const first = await continueStory(
    story.id,
    { parentId: null, instruction: "Continue.", genId: "gen-append-root" },
    stories,
    stubSettingsStore(dryRunSettings(4)),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal
  );
  const rootId = first?.nodes[0]?.id;
  if (rootId === undefined) throw new Error("root continuation did not commit a take");
  const beforeText = first!.nodes.find((node) => node.id === rootId)!.text;

  const second = await continueStory(
    story.id,
    { appendTo: rootId, expectedTextHash: sha256(beforeText), instruction: "", genId: "gen-append-tail" },
    stories,
    stubSettingsStore(dryRunSettings(4)),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal
  );
  const afterNode = second?.nodes.find((node) => node.id === rootId);
  if (afterNode === undefined) throw new Error("append did not commit");
  assert.equal(afterNode.tokenProbabilities, true);
  assert.ok(afterNode.text.length > beforeText.length, "the append actually grew the take");
  await stories.waitForMaintenance();

  const record = await stories.loadTokenProbabilities(story.id, rootId);
  assert.equal(record.textOffset, beforeText.length);
  assert.equal(
    record.steps.map((step) => step.token).join(""),
    afterNode.text.slice(beforeText.length)
  );
});

test("a second append replaces the first record rather than growing it", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-token-probability-replace-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const first = await continueStory(
    story.id,
    { parentId: null, instruction: "Continue.", genId: "gen-replace-root" },
    stories,
    stubSettingsStore(dryRunSettings(3)),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal
  );
  const rootId = first?.nodes[0]?.id;
  if (rootId === undefined) throw new Error("root continuation did not commit a take");
  const afterRoot = first!.nodes.find((node) => node.id === rootId)!.text;

  const second = await continueStory(
    story.id,
    { appendTo: rootId, expectedTextHash: sha256(afterRoot), instruction: "", genId: "gen-replace-append-1" },
    stories,
    stubSettingsStore(dryRunSettings(3)),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal
  );
  const afterFirstAppend = second!.nodes.find((node) => node.id === rootId)!.text;
  const firstAppendRecord = await stories.loadTokenProbabilities(story.id, rootId);

  const third = await continueStory(
    story.id,
    { appendTo: rootId, expectedTextHash: sha256(afterFirstAppend), instruction: "", genId: "gen-replace-append-2" },
    stories,
    stubSettingsStore(dryRunSettings(3)),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal
  );
  const afterSecondAppend = third!.nodes.find((node) => node.id === rootId)!.text;
  await stories.waitForMaintenance();
  const secondAppendRecord = await stories.loadTokenProbabilities(story.id, rootId);

  // Replaced, not merged: the stored record describes only the second
  // append's tail, never the two appends' steps combined.
  assert.notDeepEqual(secondAppendRecord, firstAppendRecord);
  assert.equal(secondAppendRecord.textOffset, afterFirstAppend.length);
  assert.equal(
    secondAppendRecord.steps.map((step) => step.token).join(""),
    afterSecondAppend.slice(afterFirstAppend.length)
  );
});

test("a take whose recording cannot be aligned stores no object, and the generation still succeeds with its prose intact", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-token-probability-misaligned-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  // A hand-built record whose recorded tokens share nothing with the text
  // being committed. A real generation could never reach commit with an
  // anchor this wrong — AnchoredOutputFilter would already have failed the
  // request — but it stands in for whatever narrower mismatch would trip
  // alignTokenProbabilities's null case, and this is the surface that case
  // must protect: the diagnostic must never cost the writer their prose.
  const unrelated = createTokenProbabilities(
    3,
    [{ token: "completely unrelated capture", logprob: -0.1, alternatives: [] }],
    undefined,
    0
  );
  const prose = "Real story prose that shares nothing with the capture.";

  await stories.withLock(story.id, async () => {
    const mutable = await stories.loadForMutation(story.id);
    commitTake(mutable, {
      parentId: null,
      appendTo: null,
      expectedTextHash: null,
      instruction: "Continue.",
      text: prose,
      model: "dry-run",
      genId: "gen-misaligned",
      tokenProbabilities: unrelated
    });
    await stories.save(mutable);
  });

  const reloaded = await stories.load(story.id);
  const node = reloaded.nodes[0];
  if (node === undefined) throw new Error("commit did not create a take");
  assert.equal(node.text, prose);
  assert.equal(node.tokenProbabilities, undefined);

  await assert.rejects(
    () => stories.loadTokenProbabilities(story.id, node.id),
    /no stored token probabilities/
  );
  const manifestRaw = await readFile(path.join(dir, story.id, "manifest.json"), "utf8");
  assert.equal(manifestRaw.includes("tokenProbabilityId"), false);
});

test("pruning the take and saving sweeps the object away", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-token-probability-prune-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const result = await continueStory(
    story.id,
    { parentId: null, instruction: "Continue.", genId: "gen-prune" },
    stories,
    stubSettingsStore(dryRunSettings(3)),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal
  );
  const nodeId = result?.nodes[0]?.id;
  if (nodeId === undefined) throw new Error("continuation did not commit a take");
  const objectPath = new StoryObjectStore(path.join(dir, story.id))
    .objectPath("probabilities", await tokenProbabilityHash(dir, story.id, nodeId));
  await readFile(objectPath); // exists before deletion — throws otherwise

  await stories.deleteNode(story.id, nodeId, 1);
  await stories.waitForMaintenance();

  await assert.rejects(() => readFile(objectPath), /ENOENT/);
});

test("a save that keeps the take keeps the object — the regression a missed liveness call site would fail", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-token-probability-keep-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const result = await continueStory(
    story.id,
    { parentId: null, instruction: "Continue.", genId: "gen-keep" },
    stories,
    stubSettingsStore(dryRunSettings(2)),
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal
  );
  const rootId = result?.nodes[0]?.id;
  if (rootId === undefined) throw new Error("continuation did not commit a take");
  const beforeRecord = await stories.loadTokenProbabilities(story.id, rootId);
  const objectPath = new StoryObjectStore(path.join(dir, story.id))
    .objectPath("probabilities", await tokenProbabilityHash(dir, story.id, rootId));

  // An unrelated take, added and then removed. Its deletion drops a
  // revision from the manifest, which is what forces cleanup to actually
  // run a sweep — the sweep whose live set must still include rootId's
  // stored probabilities, because rootId itself was never touched.
  const withThrowaway = await stories.createNode(story.id, rootId, "Throwaway.", "Aside");
  const throwawayId = withThrowaway.nodes.find((node) => node.parentId === rootId)?.id;
  if (throwawayId === undefined) throw new Error("throwaway take did not commit");
  await stories.deleteNode(story.id, throwawayId, 1);
  await stories.waitForMaintenance();

  await readFile(objectPath); // still there — throws if a sweep dropped it
  const afterRecord = await stories.loadTokenProbabilities(story.id, rootId);
  assert.deepEqual(afterRecord, beforeRecord);
});

test("a V5 manifest without tokenProbabilityId round-trips byte-for-byte", () => {
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
  assert.equal("tokenProbabilityId" in parsed.nodes[0]!, false);
  assert.equal(serializeManifest(parsed), raw);
});

const linuxTest = process.platform === "linux" ? test : test.skip;

linuxTest("the read route returns the stored record, and 404s for a take without one", async (t) => {
  const base = await testApp(t, "1667-token-probability-http-");
  const attach = await attachHttpServer(base);
  t.after(() => attach.dispose());
  const api = createApi(base, undefined, attach);

  const created = await api.createStory("Story");
  await enableTokenProbabilities(api);

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
  assert.equal(result?.payload.nodes.find((node) => node.id === nodeId)?.tokenProbabilities, true);

  const record = await api.getTokenProbabilities(created.id, nodeId);
  assert.equal(record.format, "1667-token-probabilities");
  assert.ok(record.steps.length > 0);

  // A human take, on an independent line: never asked a model for anything.
  const human = await api.createNode(created.id, { parentId: null, text: "Human prose." });
  const humanNodeId = human.path.at(-1)?.id;
  if (humanNodeId === undefined) throw new Error("human take did not commit");
  await assert.rejects(
    () => api.getTokenProbabilities(created.id, humanNodeId),
    (error: unknown) => error instanceof ApiHttpError && error.status === 404
  );
});

async function enableTokenProbabilities(api: ReturnType<typeof createApi>): Promise<void> {
  const view = await api.getSettings();
  if (view.dataFormat !== 2 || !view.editable) {
    assert.fail("expected an editable format-2 settings document");
  }
  const currentProfile = view.document.profiles.default;
  if (currentProfile === undefined) throw new Error("expected a default generation profile");
  const mutationId = createDurableMutationId();
  await api.saveSettings({
    transportOperationId: `fixture:${mutationId}`,
    mutationId,
    expectedStateGeneration: view.stateGeneration,
    document: {
      ...view.document,
      profiles: {
        ...view.document.profiles,
        default: { ...currentProfile, tokenProbabilities: 4 }
      }
    }
  });
}

async function tokenProbabilityHash(dir: string, storyId: string, nodeId: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(path.join(dir, storyId, "manifest.json"), "utf8")
  ) as StoryManifestV5;
  const node = manifest.nodes.find((candidate) => candidate.id === nodeId);
  const hash = node?.tokenProbabilityId;
  if (hash === undefined) throw new Error(`Node ${nodeId} has no stored token probabilities`);
  return hash;
}

function dryRunSettings(tokenProbabilities: number | null): GenerationSettings {
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
    tokenProbabilities,
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

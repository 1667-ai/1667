import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { decodeStoryBundle, encodeStoryBundle, hydrateStoryNodes } from "../server/story-codec.js";
import { buildStoryPayload } from "../server/story-payload.js";
import {
  MAX_CHUNK_BYTES,
  MAX_CHUNKS_PER_REVISION,
  StoryFormatError,
  chunkId,
  chunkText,
  createRevision,
  hasUnpairedSurrogate,
  liveObjectIds,
  parseLegacyStory,
  parseManifest,
  parseManifestV13,
  parseRevision,
  requireV5Manifest,
  STORY_FORMAT,
  STORYTAVERN_REVISION_FORMAT,
  STORYTAVERN_STORY_FORMAT,
  revisionId,
  serializeManifest,
  serializeManifestContent,
  serializeRevision,
  sha256,
  type StoryManifestV2,
  type StoryManifestV5,
  type StoryManifestV4,
  type StoryManifestV13
} from "../server/story-format.js";
import { StoryObjectStore } from "../server/story-objects.js";
import {
  MAX_STORY_INSTRUCTION_CHARS,
  MAX_STORY_MANIFEST_BYTES
} from "../server/story-v5-strict.js";
import { MAX_FACT_TEXT_CHARS } from "../shared/types.js";
import type { Story, StoryNode } from "../shared/types.js";

const NOW = "2026-01-01T00:00:00.000Z";
const HASH = "a".repeat(64);

test("story format: chunking and revision hashes preserve exact prose", () => {
  for (const source of ["", "First.\n\nSecond.", "Stars ✨ and 文字.", "x".repeat(MAX_CHUNK_BYTES * 2 + 17)]) {
    const chunks = chunkText(source);
    assert.equal(chunks.join(""), source);
    assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= MAX_CHUNK_BYTES));
  }
  assert.throws(() => chunkText("broken \ud800 text"), /unpaired Unicode surrogate/);
  const revision = createRevision([chunkId("Alpha")], 5);
  const raw = serializeRevision(revision);
  assert.deepEqual(parseRevision(raw, revisionId(revision)), revision);
  assert.throws(() => parseRevision(`${raw} `, revisionId(revision)), StoryFormatError);
  const storyTavernRaw = JSON.stringify({
    ...revision,
    format: STORYTAVERN_REVISION_FORMAT
  });
  assert.equal(
    parseRevision(storyTavernRaw, sha256(Buffer.from(storyTavernRaw))).format,
    STORYTAVERN_REVISION_FORMAT
  );
  const excessive = Array.from({ length: MAX_CHUNKS_PER_REVISION + 1 }, () => "x").join("\n\n");
  assert.throws(() => chunkText(excessive), /chunk limit/);
});

test("story format: StoryTavern V5 manifests normalize to the current identity", () => {
  const parsed = parseManifest(JSON.stringify({
    format: STORYTAVERN_STORY_FORMAT,
    schemaVersion: 5,
    id: "storytavern-v5",
    title: "Legacy",
    createdAt: NOW,
    updatedAt: NOW,
    activeWordCount: 0,
    nodes: [],
    facts: [],
    activeRootId: null,
    bookmarks: [],
    recentNodeIds: [],
    chapterBreaks: []
  }), "storytavern-v5");

  assert.equal(parsed.format, STORY_FORMAT);
  assert.equal(parsed.schemaVersion, 5);
});

test("story payload projects Generation Record counts and human-edit presence", () => {
  const edited = {
    ...node("root", null, "Edited prose"),
    attribution: { source: "human" as const, ranges: [{ start: 0, end: 6 }] },
    generationRecordIds: [HASH, "b".repeat(64)]
  };
  const payload = buildStoryPayload(runtimeStory([edited]));
  const stub = payload.nodes[0];
  assert.equal(stub?.generationRecordCount, 2);
  assert.equal(stub?.editedByUser, true);

  // The path carries the same node in full (not the stub projection), so it
  // must project generationRecordIds down to a count of its own instead of
  // ever putting the ordered id list on the wire.
  const pathNode = payload.path[0];
  assert.equal("generationRecordIds" in (pathNode as object), false);
  assert.equal(pathNode?.generationRecordCount, 2);
});

test("a deletion-only human edit (no ranges, characters removed) still counts as edited", () => {
  const deletionOnly = {
    ...node("root", null, "Shorter prose"),
    attribution: { source: "human" as const, ranges: [], deletedCharacters: 5 }
  };
  const payload = buildStoryPayload(runtimeStory([deletionOnly]));
  assert.equal(payload.nodes[0]?.editedByUser, true);

  // A truly untouched node (no attribution at all) must not be marked edited.
  const untouched = buildStoryPayload(runtimeStory([node("root", null, "Untouched prose")]));
  assert.equal(untouched.nodes[0]?.editedByUser, undefined);
});

test("story objects: foreground cancellation leaves cleanup safe to retry", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-sweep-cancel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const objects = new StoryObjectStore(dir);
  await objects.init();
  const live = await objects.storeText("Live prose");
  const stale = await objects.storeText("Stale prose");
  await objects.flush();
  const abort = new AbortController();
  abort.abort();

  const live1 = {
    revisions: [live],
    leaves: { probabilities: [], reasoning: [], images: [], aside: [] },
    generationRecords: []
  };
  assert.equal(await objects.sweep(live1, abort.signal), false);
  await readFile(objects.objectPath("revisions", stale));
  assert.equal(await objects.sweep(live1), true);
  await assert.rejects(
    () => readFile(objects.objectPath("revisions", stale)),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT"
  );
});

test("story format: V5 bundle round-trips nodes, attribution, tags, recents, and facts", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-v4-format-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const story: Story = {
    id: "story-v4", title: "Tree", createdAt: NOW, updatedAt: NOW,
    nodes: [node("root", null, "Opening", "child"), {
      ...node("child", "root", "Edited prose"),
      updatedAt: "2026-01-02T00:00:00.000Z",
      attribution: { source: "human", ranges: [{ start: 0, end: 6 }], deletedCharacters: 3 },
      rewrittenSpans: [{ start: 7, end: 12 }],
      human: true,
      genId: "g1"
    }, { ...node("summary", "root", "Recap"), role: "summary" }],
    activeRootId: "root",
    tags: [{ nodeId: "child", name: "Canon line", status: "Canon", color: "#4b45c9", createdAt: NOW }],
    recentNodeIds: ["summary"],
    facts: [{
      id: "fact", tag: null, activation: "always", keys: [],
      states: [{ id: "fact", text: "Exact fact.", createdAt: NOW, updatedAt: NOW }],
      createdAt: NOW, updatedAt: NOW
    }],
    chapterBreaks: []
  };
  const manifest = await encodeStoryBundle(story, new StoryObjectStore(dir));
  assert.equal(manifest.schemaVersion, 5);
  assert.equal(manifest.nodes.length, 3);
  assert.equal(manifest.nodes.every((stored) => typeof stored.revisionId === "string"), true);
  assert.deepEqual(manifest.nodes.map(({ preview, words }) => ({ preview, words })), [
    { preview: "Opening", words: 1 },
    { preview: "Edited prose", words: 2 },
    { preview: "Recap", words: 1 }
  ]);
  const parsed = parseManifest(serializeManifest(manifest), story.id);
  assert.deepEqual((await decodeStoryBundle(parsed, dir)).story, story);

  const lazy = (await decodeStoryBundle(parsed, dir, { activeOnly: true })).story;
  assert.equal(lazy.nodes.find((candidate) => candidate.id === "summary")!.text, "");
  assert.deepEqual(buildStoryPayload(lazy).nodes.find((candidate) => candidate.id === "summary"), {
    id: "summary", parentId: "root", preview: "Recap", words: 1, tokens: 4, childCount: 0, leafCount: 1,
    lastTouched: NOW, role: "summary", hasInstruction: true, activeChildId: null
  });
  await hydrateStoryNodes(lazy, ["summary"]);
  assert.equal(lazy.nodes.find((candidate) => candidate.id === "summary")!.text, "Recap");

  const earlyV4 = structuredClone(parsed);
  for (const stored of earlyV4.nodes) {
    delete stored.preview;
    delete stored.words;
  }
  const early = (await decodeStoryBundle(
    parseManifest(JSON.stringify(earlyV4), story.id),
    dir,
    { activeOnly: true }
  )).story;
  assert.equal(
    early.nodes.find((candidate) => candidate.id === "summary")!.text,
    "Recap",
    "early V4 without stubs safely hydrates the full tree"
  );
});

test("story format: legacy flat Facts lift and lower without changing their bytes", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-legacy-fact-lift-lower-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const objects = new StoryObjectStore(dir);
  await objects.init();
  const revisionId = await objects.storeText("Legacy fact text.");
  const manifest: StoryManifestV5 = {
    format: "1667-story",
    schemaVersion: 5,
    id: "legacy-flat-fact",
    title: "Legacy",
    createdAt: NOW,
    updatedAt: NOW,
    activeWordCount: 0,
    nodes: [],
    facts: [{
      id: "fact",
      tag: null,
      revisionId,
      createdAt: NOW,
      updatedAt: NOW
    }],
    activeRootId: null,
    bookmarks: [],
    recentNodeIds: [],
    chapterBreaks: []
  };

  const decoded = await decodeStoryBundle(manifest, dir);
  assert.deepEqual(decoded.story.facts[0]!.states, [{
    id: "fact",
    text: "Legacy fact text.",
    createdAt: NOW,
    updatedAt: NOW
  }]);

  const lowered = await encodeStoryBundle(decoded.story, objects);
  assert.equal(lowered.schemaVersion, 5);
  assert.deepEqual(lowered.facts[0], manifest.facts[0]);
  assert.equal(serializeManifest(lowered as StoryManifestV5), serializeManifest(manifest));
});

test("story format: V13 stores every Fact State revision and omits End State objects", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-v13-fact-states-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const story: Story = {
    id: "story-v13-fact-states",
    title: "Fact States",
    createdAt: NOW,
    updatedAt: NOW,
    nodes: [
      node("root", null, "Opening", "branch"),
      node("branch", "root", "Branch text"),
      { ...node("other", null, "Other branch"), activeChildId: null },
      { ...node("summary", "root", "Summary"), role: "summary" }
    ],
    activeRootId: "root",
    tags: [],
    recentNodeIds: [],
    asideDocumentId: null,
    asideSessionRefs: [],
    asideUnanchoredSessionRefs: [],
    facts: [{
      id: "fact",
      name: "World lore",
      tag: null,
      activation: "always",
      keys: [],
      states: [
        { id: "fact", text: "The door is open.", createdAt: NOW, updatedAt: NOW },
        {
          id: "fact-branch",
          anchorPartId: "branch",
          text: "The door is locked.",
          createdAt: NOW,
          updatedAt: NOW
        },
        { id: "fact-end", anchorPartId: "other", ends: true, createdAt: NOW, updatedAt: NOW }
      ],
      createdAt: NOW,
      updatedAt: NOW
    }],
    chapterBreaks: []
  };
  const objects = new StoryObjectStore(dir);
  const manifest = await encodeStoryBundle(story, objects);
  assert.equal(manifest.schemaVersion, 13);
  assert.equal(manifest.facts[0]!.states.length, 3);
  const decoded = await decodeStoryBundle(manifest, dir);
  assert.deepEqual(decoded.story, story);

  const storedStates = manifest.facts[0]!.states;
  const stateRevisions = storedStates.flatMap((state) =>
    state.revisionId === undefined ? [] : [state.revisionId]
  );
  const live = liveObjectIds(manifest);
  assert.deepEqual(live.revisions.slice(-stateRevisions.length), stateRevisions);
  for (const revision of stateRevisions) {
    await readFile(objects.objectPath("revisions", revision));
  }
});

test("story format: V13 rejects duplicate, unknown, and summary Fact State anchors", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-v13-fact-state-validation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const story: Story = {
    id: "story-v13-fact-state-validation",
    title: "Fact State validation",
    createdAt: NOW,
    updatedAt: NOW,
    nodes: [node("root", null, "Opening"), { ...node("summary", "root", "Summary"), role: "summary" }],
    activeRootId: "root",
    tags: [],
    recentNodeIds: [],
    facts: [{
      id: "fact",
      tag: null,
      activation: "always",
      keys: [],
      states: [{ id: "fact", text: "A fact.", createdAt: NOW, updatedAt: NOW }],
      createdAt: NOW,
      updatedAt: NOW
    }],
    chapterBreaks: []
  };
  const objects = new StoryObjectStore(dir);
  const manifest = await encodeStoryBundle(story, objects);
  assert.equal(manifest.schemaVersion, 5);

  const v13 = {
    ...manifest,
    schemaVersion: 13 as const,
    asideDocumentId: null,
    asideSessionRefs: [],
    asideUnanchoredSessionRefs: [],
    facts: [{
      id: "fact",
      tag: null,
      createdAt: NOW,
      updatedAt: NOW,
      states: [
        { id: "fact", revisionId: HASH, createdAt: NOW, updatedAt: NOW },
        { id: "later", revisionId: HASH, anchorPartId: "root", createdAt: NOW, updatedAt: NOW }
      ]
    }]
  };
  const expectReject = (states: Array<Record<string, unknown>>, pattern: RegExp) => {
    const candidate = {
      ...v13,
      facts: [{
        id: "fact",
        tag: null,
        createdAt: NOW,
        updatedAt: NOW,
        states
      }]
    } as unknown as StoryManifestV13;
    assert.throws(
      () => parseManifestV13(serializeManifestContent(candidate), story.id),
      pattern
    );
  };
  expectReject([
    { id: "fact", revisionId: HASH, createdAt: NOW, updatedAt: NOW },
    { id: "later", revisionId: HASH, anchorPartId: "missing", createdAt: NOW, updatedAt: NOW }
  ], /unknown part/);
  expectReject([
    { id: "fact", revisionId: HASH, createdAt: NOW, updatedAt: NOW },
    { id: "later", revisionId: HASH, anchorPartId: "summary", createdAt: NOW, updatedAt: NOW }
  ], /unknown part/);
  expectReject([
    { id: "fact", revisionId: HASH, createdAt: NOW, updatedAt: NOW },
    { id: "fact", revisionId: HASH, anchorPartId: "root", createdAt: NOW, updatedAt: NOW }
  ], /Duplicate fact state id/);
  expectReject([
    { id: "fact", revisionId: HASH, createdAt: NOW, updatedAt: NOW },
    { id: "later", revisionId: HASH, anchorPartId: "root", createdAt: NOW, updatedAt: NOW },
    { id: "third", revisionId: HASH, anchorPartId: "root", createdAt: NOW, updatedAt: NOW }
  ], /duplicate state anchors/);

  const legacySource = parseManifestV13(
    serializeManifestContent({
      ...v13,
      facts: [{
        id: "fact",
        sourcePartId: "summary",
        tag: null,
        createdAt: NOW,
        updatedAt: NOW,
        states: [{ id: "fact", revisionId: HASH, createdAt: NOW, updatedAt: NOW }]
      }]
    } as unknown as StoryManifestV13),
    story.id
  );
  assert.equal(legacySource.facts[0]!.sourcePartId, "summary");
});

test("story format: Fact State count and aggregate text limits fail before object publication", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-v13-fact-state-limits-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const objects = new StoryObjectStore(dir);
  const tooManyStates: Story = {
    id: "story-v13-too-many-states",
    title: "Too many states",
    createdAt: NOW,
    updatedAt: NOW,
    nodes: Array.from({ length: 33 }, (_, index) => node(`part-${index}`, null, "Part")),
    activeRootId: "part-0",
    tags: [],
    recentNodeIds: [],
    facts: [{
      id: "fact",
      tag: null,
      activation: "always",
      keys: [],
      states: Array.from({ length: 33 }, (_, index) => ({
        id: `state-${index}`,
        anchorPartId: `part-${index}`,
        text: "Fact",
        createdAt: NOW,
        updatedAt: NOW
      })),
      createdAt: NOW,
      updatedAt: NOW
    }],
    chapterBreaks: []
  };
  await assert.rejects(encodeStoryBundle(tooManyStates, objects), /32-state limit/);
  const objectDir = path.join(dir, "revisions");
  await assert.rejects(readdir(objectDir), /ENOENT/);

  const aggregate: Story = {
    ...tooManyStates,
    id: "story-v13-aggregate-limit",
    nodes: [node("root", null, "Part"), node("branch", "root", "Part")],
    activeRootId: "root",
    facts: [{
      id: "fact",
      tag: null,
      activation: "always",
      keys: [],
      states: [
        { id: "fact", text: "x".repeat(MAX_FACT_TEXT_CHARS), createdAt: NOW, updatedAt: NOW },
        { id: "branch", anchorPartId: "branch", text: "x", createdAt: NOW, updatedAt: NOW }
      ],
      createdAt: NOW,
      updatedAt: NOW
    }]
  };
  await assert.rejects(encodeStoryBundle(aggregate, objects), /aggregate .*limit/);
});

test("story format: encoded V5 size validation measures exact persisted bytes", async () => {
  const instruction = "x".repeat(MAX_STORY_INSTRUCTION_CHARS - 276);
  const story = runtimeStory(Array.from({ length: 16 }, (_, index) => ({
    ...node(`root-${index}`, null, ""),
    instruction
  })));
  const candidate: StoryManifestV5 = {
    format: "1667-story",
    schemaVersion: 5,
    id: story.id,
    title: story.title,
    createdAt: story.createdAt,
    updatedAt: story.updatedAt,
    activeWordCount: 0,
    nodes: story.nodes.map((entry) => ({
      id: entry.id,
      parentId: null,
      instruction,
      model: entry.model,
      createdAt: entry.createdAt,
      preview: "",
      words: 0,
      tokens: 0,
      revisionId: HASH,
      activeChildId: null
    })),
    facts: [],
    activeRootId: story.activeRootId,
    bookmarks: [],
    recentNodeIds: [],
    chapterBreaks: []
  };
  assert.ok(Buffer.byteLength(JSON.stringify(candidate)) < MAX_STORY_MANIFEST_BYTES);
  assert.ok(Buffer.byteLength(serializeManifest(candidate)) > MAX_STORY_MANIFEST_BYTES);

  const objects = {
    init: async () => undefined,
    storeTexts: async (values: readonly string[]) => values.map(() => HASH)
  } as unknown as StoryObjectStore;
  await assert.rejects(() => encodeStoryBundle(story, objects), /size limit/);
});

test("story format: preview bounds preserve legacy width without splitting a scalar", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-scalar-preview-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const text = `${"a".repeat(99)}😀more`;
  const story = runtimeStory([node("root", null, text)]);

  const manifest = await encodeStoryBundle(story, new StoryObjectStore(dir));

  assert.equal(manifest.nodes[0]!.preview, "a".repeat(99));
  assert.equal((await decodeStoryBundle(manifest, dir)).story.nodes[0]!.text, text);

  const legacyWidth = runtimeStory([node("root", null, `${"😀".repeat(50)}tail`)]);
  const legacyManifest = await encodeStoryBundle(legacyWidth, new StoryObjectStore(dir));
  assert.equal(legacyManifest.nodes[0]!.preview, "😀".repeat(50));
  assert.equal((await decodeStoryBundle(legacyManifest, dir)).story.nodes[0]!.text, `${"😀".repeat(50)}tail`);
});

test("story format: permissive V4 split previews repair during lazy V5 migration", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-v4-preview-repair-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const objects = new StoryObjectStore(dir);
  await objects.init();
  const activeText = "Active";
  const inactiveText = `${"a".repeat(99)}😀more`;
  const [activeRevision, inactiveRevision] = await objects.storeTexts([activeText, inactiveText]);
  await objects.flush();
  const manifest = v4Manifest();
  manifest.nodes = [{
    id: "root", parentId: null, instruction: "Go", model: "m", createdAt: NOW,
    revisionId: activeRevision!, activeChildId: null, preview: activeText, words: 1
  }, {
    id: "other-root", parentId: null, instruction: "Go", model: "m", createdAt: NOW,
    revisionId: inactiveRevision!, activeChildId: null, preview: inactiveText.slice(0, 100), words: 1
  }];
  manifest.activeRootId = "root";
  manifest.bookmarks = [];
  manifest.recentNodeIds = [];
  assert.equal(hasUnpairedSurrogate(manifest.nodes[1]!.preview!), true);

  const parsed = parseManifest(JSON.stringify(manifest), manifest.id);
  const decoded = await decodeStoryBundle(parsed, dir, { activeOnly: true });
  const migrated = await encodeStoryBundle(decoded.story, objects);

  assert.equal(migrated.nodes[1]!.preview, "a".repeat(99));
  assert.equal(hasUnpairedSurrogate(migrated.nodes[1]!.preview!), false);
  assert.doesNotThrow(() => parseManifest(serializeManifest(requireV5Manifest(migrated, "test migration")), manifest.id));
});

test("story format: V4 manifest fails closed across the tree matrix", () => {
  const base = v4Manifest();
  const reject = (mutate: (manifest: StoryManifestV4) => void, pattern: RegExp): void => {
    const manifest = structuredClone(base);
    mutate(manifest);
    assert.throws(() => parseManifest(JSON.stringify(manifest), manifest.id), pattern);
  };
  reject((m) => { m.nodes[1]!.id = "root"; }, /Duplicate story node id/);
  reject((m) => { m.nodes[0]!.parentId = "child"; }, /earlier node/);
  reject((m) => { m.nodes[1]!.parentId = "missing"; }, /earlier node/);
  reject((m) => { m.nodes[0]!.activeChildId = "missing"; }, /reference a child/);
  reject((m) => { m.nodes[0]!.activeChildId = "other-root"; }, /reference a child/);
  reject((m) => { m.activeRootId = null; }, /reference a root/);
  reject((m) => { m.activeRootId = "child"; }, /reference a root/);
  reject((m) => { m.bookmarks[0]!.nodeId = "missing"; }, /unknown node/);
  reject((m) => { m.bookmarks.push({ ...m.bookmarks[0]! }); }, /Duplicate tag/);
  reject((m) => { m.bookmarks.push({ ...m.bookmarks[0]!, nodeId: "other-root", name: "Other" }); }, /Only one tag may be Canon/);
  reject((m) => { m.bookmarks[0]!.name = " bad "; }, /trimmed/);
  reject((m) => { m.bookmarks[0]!.label = "Bad" as "Canon"; }, /label is invalid/);
  reject((m) => { m.recentNodeIds = ["missing"]; }, /unknown node/);
  reject((m) => { m.recentNodeIds = Array.from({ length: 6 }, () => "child"); }, /5-node limit/);
  reject((m) => { m.nodes[0]!.human = false as true; }, /true or absent/);
  reject((m) => { m.nodes[0]!.role = "prose" as "summary"; }, /role must be/);
  reject((m) => { m.nodes[0]!.preview = "Opening"; }, /preview and words/);
  reject((m) => { m.nodes[0]!.preview = "x".repeat(101); m.nodes[0]!.words = 1; }, /preview exceeds/);
  reject((m) => { m.nodes[0]!.preview = "Opening"; m.nodes[0]!.words = -1; }, /words must not/);
  reject((m) => { m.nodes[0]!.attribution = { source: "human", ranges: [{ start: -1, end: 2 }] }; }, /invalid human edit range/);
  reject((m) => { m.nodes[0]!.attribution = { source: "human", ranges: [], deletedCharacters: 0 }; }, /positive integer/);
  reject((m) => { m.nodes[0]!.attribution = { source: "human", ranges: [], deletedCharacters: 1.5 }; }, /must be an integer/);
  reject((m) => { m.nodes[0]!.rewrittenSpans = [{ start: -1, end: 2 }]; }, /invalid rewritten span/);
  reject((m) => { m.nodes[0]!.rewrittenSpans = [{ start: 4, end: 2 }]; }, /invalid rewritten span/);
  reject((m) => { m.nodes[0]!.rewrittenSpans = [{ start: 2, end: 4 }, { start: 0, end: 3 }]; }, /invalid rewritten span/);
  const empty = { ...structuredClone(base), nodes: [], activeRootId: "root", tags: [], recentNodeIds: [] };
  assert.throws(() => parseManifest(JSON.stringify(empty), empty.id), /must be null/);
});

test("story format: V2 and legacy JSON normalize to V5 trees", () => {
  const v2: StoryManifestV2 = {
    format: "1667-story", schemaVersion: 2, id: "story-v2", title: "V2",
    createdAt: NOW, updatedAt: NOW, activeWordCount: 2, facts: [],
    parts: [{ id: "p1", instruction: "Go", model: "m", createdAt: NOW, revisionIds: [HASH], activeRevision: 0 }]
  };
  const parsed = parseManifest(JSON.stringify(v2), v2.id);
  assert.equal(parsed.schemaVersion, 5);
  assert.equal(parsed.nodes[0]!.id, "p1");
  assert.equal(parsed.activeRootId, "p1");
  assert.equal(JSON.parse(serializeManifest(parsed)).schemaVersion, 5);
  assert.deepEqual(
    parseManifest(
      JSON.stringify({ ...v2, format: STORYTAVERN_STORY_FORMAT }),
      v2.id
    ),
    parsed
  );

  const legacy = {
    id: "legacy", title: "Legacy", createdAt: NOW, updatedAt: NOW,
    parts: [{ id: "p1", instruction: "Go", text: "B", model: "m", createdAt: NOW,
      versions: ["A", "B"], activeVersion: 1, role: "summary" }]
  };
  const story = parseLegacyStory(JSON.stringify(legacy), legacy.id);
  assert.deepEqual(story.nodes.map(({ id, text }) => ({ id, text })), [
    { id: "p1@v0", text: "A" }, { id: "p1", text: "B" }
  ]);
  assert.equal(story.activeRootId, "p1");
  assert.equal(story.nodes[1]?.role, "summary");
  assert.throws(
    () => parseLegacyStory(JSON.stringify({ ...legacy, parts: [{ ...legacy.parts[0], role: "prose" }] }), legacy.id),
    /role must be/
  );
  assert.throws(() => parseLegacyStory(JSON.stringify({ ...legacy, schemaVersion: 9 }), legacy.id), /Unsupported/);
});

test("story format: every historical V2 fact shape normalizes to V4", () => {
  const base = {
    format: "1667-story", schemaVersion: 2, title: "Historical V2",
    createdAt: NOW, updatedAt: NOW, activeWordCount: 2,
    parts: [
      { id: "p1", instruction: "Go", model: "m", createdAt: NOW, revisionIds: [HASH], activeRevision: 0 },
      { id: "p2", instruction: "Go", model: "m", createdAt: NOW, revisionIds: ["b".repeat(64)], activeRevision: 0 }
    ]
  };
  const earliest = parseManifest(JSON.stringify({ ...base, id: "v2-earliest" }), "v2-earliest");
  assert.deepEqual(earliest.facts, [], "the first bundle release had no facts field");

  const temporal = parseManifest(JSON.stringify({
    ...base,
    id: "v2-temporal",
    facts: [{
      id: "fact", tag: "Lore", createdAt: NOW, updatedAt: NOW,
      states: [
        { id: "state-1", revisionId: "c".repeat(64), effectiveAfterPartId: null, createdAt: NOW, updatedAt: NOW },
        { id: "state-2", revisionId: "d".repeat(64), effectiveAfterPartId: "p1", createdAt: NOW, updatedAt: NOW }
      ]
    }]
  }), "v2-temporal");
  assert.equal(temporal.facts[0]!.revisionId, "d".repeat(64));

  const flat = parseManifest(JSON.stringify({
    ...base,
    id: "v2-flat",
    facts: [{ id: "fact", tag: null, revisionId: "e".repeat(64), createdAt: NOW, updatedAt: NOW }]
  }), "v2-flat");
  assert.equal(flat.facts[0]!.revisionId, "e".repeat(64));
});

test("story format: runtime attribution is bounded by its node text", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-v4-attribution-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const story = runtimeStory([{
    ...node("root", null, "short"),
    attribution: { source: "human", ranges: [{ start: 0, end: 99 }] }
  }]);
  await assert.rejects(() => encodeStoryBundle(story, new StoryObjectStore(dir)), /invalid human edit range/);
});

test("story format: runtime rewrittenSpans is bounded by its node text", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-v4-rewritten-spans-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const story = runtimeStory([{
    ...node("root", null, "short"),
    rewrittenSpans: [{ start: 0, end: 99 }]
  }]);
  await assert.rejects(() => encodeStoryBundle(story, new StoryObjectStore(dir)), /invalid rewritten span/);
});

test("story format: default Fact metadata stays omitted and keys do not change its text hash", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-fact-metadata-format-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fact = {
    id: "fact",
    tag: null,
    activation: "always" as const,
    keys: [] as string[],
    states: [{ id: "fact", text: "The red door is locked.", createdAt: NOW, updatedAt: NOW }],
    createdAt: NOW,
    updatedAt: NOW
  };
  const story = { ...runtimeStory([node("root", null, "Opening")]), facts: [fact] };
  const objects = new StoryObjectStore(dir);
  const plain = await encodeStoryBundle(story, objects);
  assert.equal("activation" in plain.facts[0]!, false);
  assert.equal("keys" in plain.facts[0]!, false);

  const keyed = {
    ...story,
    facts: [{ ...fact, activation: "keyed" as const, keys: ["red door"] }]
  };
  const keyedManifest = await encodeStoryBundle(keyed, objects);
  assert.equal(keyedManifest.facts[0]!.activation, "keyed");
  assert.deepEqual(keyedManifest.facts[0]!.keys, ["red door"]);
  assert.equal(
    "revisionId" in keyedManifest.facts[0]! && "revisionId" in plain.facts[0]!
      ? keyedManifest.facts[0]!.revisionId
      : undefined,
    "revisionId" in plain.facts[0]! ? plain.facts[0]!.revisionId : undefined
  );
  assert.deepEqual((await decodeStoryBundle(keyedManifest, dir)).story, keyed);
});

test("story format: Fact metadata defaults omit and non-default settings round-trip", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-fact-priority-budget-format-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const objects = new StoryObjectStore(dir);
  const fact = {
    id: "fact",
    tag: null,
    activation: "always" as const,
    keys: [] as string[],
    states: [{ id: "fact", text: "The red door is locked.", createdAt: NOW, updatedAt: NOW }],
    createdAt: NOW,
    updatedAt: NOW
  };

  // The default priority, and no per-Fact or story Facts budget, never reach
  // disk — this manifest is byte-for-byte what an old story already has, so
  // decoding it stands in for "an old manifest without these fields".
  const plainStory = { ...runtimeStory([node("root", null, "Opening")]), facts: [fact] };
  const plain = await encodeStoryBundle(plainStory, objects);
  assert.equal("priority" in plain.facts[0]!, false);
  assert.equal("budgetTokens" in plain.facts[0]!, false);
  assert.equal("secondaryKeys" in plain.facts[0]!, false);
  assert.equal("secondaryMode" in plain.facts[0]!, false);
  assert.equal("scanDepth" in plain.facts[0]!, false);
  assert.equal("recursion" in plain.facts[0]!, false);
  assert.equal("factsBudgetTokens" in plain, false);
  const plainDecoded = await decodeStoryBundle(plain, dir);
  assert.equal(plainDecoded.story.facts[0]!.priority, undefined);
  assert.equal(plainDecoded.story.facts[0]!.budgetTokens, undefined);
  assert.equal(plainDecoded.story.facts[0]!.secondaryKeys, undefined);
  assert.equal(plainDecoded.story.facts[0]!.secondaryMode, undefined);
  assert.equal(plainDecoded.story.facts[0]!.scanDepth, undefined);
  assert.equal(plainDecoded.story.facts[0]!.recursion, undefined);
  assert.equal(plainDecoded.story.factsBudgetTokens, undefined);

  // A non-default priority, a per-Fact budget, and a story-level Facts budget
  // all survive encode -> decode exactly.
  const richStory = {
    ...plainStory,
    facts: [{
      ...fact,
      priority: "high" as const,
      budgetTokens: 250,
      secondaryKeys: ["permit"],
      secondaryMode: "not" as const,
      scanDepth: 4,
      recursion: "off" as const
    }],
    factsBudgetTokens: 4_000
  };
  const richManifest = await encodeStoryBundle(richStory, objects);
  assert.equal(richManifest.facts[0]!.priority, "high");
  assert.equal(richManifest.facts[0]!.budgetTokens, 250);
  assert.deepEqual(richManifest.facts[0]!.secondaryKeys, ["permit"]);
  assert.equal(richManifest.facts[0]!.secondaryMode, "not");
  assert.equal(richManifest.facts[0]!.scanDepth, 4);
  assert.equal(richManifest.facts[0]!.recursion, "off");
  assert.equal(richManifest.factsBudgetTokens, 4_000);
  assert.deepEqual((await decodeStoryBundle(richManifest, dir)).story, richStory);
});

// Issue #341: a story's own phraseBias/bannedStrings overlay follows the
// exact story-scalar precedent factsBudgetTokens set — optional, omitted at
// the default, so an old manifest that predates this change (no phraseBias
// or bannedStrings key at all) still decodes unchanged, and a story that
// does set them round-trips through encode -> decode exactly.
test("story format: phraseBias and bannedStrings round-trip, and an old manifest without them still decodes", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-story-sampling-format-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const objects = new StoryObjectStore(dir);

  // Neither field ever reaches disk when absent — this manifest is
  // byte-for-byte what a story saved before issue #341 already has.
  const plainStory = runtimeStory([node("root", null, "Opening")]);
  const plain = await encodeStoryBundle(plainStory, objects);
  assert.equal("phraseBias" in plain, false);
  assert.equal("bannedStrings" in plain, false);
  const plainDecoded = await decodeStoryBundle(plain, dir);
  assert.equal(plainDecoded.story.phraseBias, undefined);
  assert.equal(plainDecoded.story.bannedStrings, undefined);

  // A configured phraseBias and bannedStrings both survive encode -> decode
  // exactly.
  const richStory: Story = {
    ...plainStory,
    phraseBias: [{ phrase: "delve", weight: -8 }, { phrase: "tapestry", weight: -12 }],
    bannedStrings: ["moreover", "in conclusion"]
  };
  const richManifest = await encodeStoryBundle(richStory, objects);
  assert.deepEqual(richManifest.phraseBias, richStory.phraseBias);
  assert.deepEqual(richManifest.bannedStrings, richStory.bannedStrings);
  assert.deepEqual((await decodeStoryBundle(richManifest, dir)).story, richStory);

  // Clearing both back to empty omits them again, the same as never setting
  // them — an empty list is not a fact worth a byte on disk.
  const cleared = { ...richStory, phraseBias: [], bannedStrings: [] };
  const clearedManifest = await encodeStoryBundle(cleared, objects);
  assert.equal("phraseBias" in clearedManifest, false);
  assert.equal("bannedStrings" in clearedManifest, false);
});

function node(id: string, parentId: string | null, text: string, activeChildId: string | null = null): StoryNode {
  return { id, parentId, instruction: "Continue", text, model: "test", createdAt: NOW, activeChildId };
}

function runtimeStory(nodes: StoryNode[]): Story {
  return { id: "runtime", title: "Runtime", createdAt: NOW, updatedAt: NOW,
    nodes, activeRootId: nodes[0]?.id ?? null, tags: [], recentNodeIds: [], facts: [], chapterBreaks: [] };
}

function v4Manifest(): StoryManifestV4 {
  return {
    format: "1667-story", schemaVersion: 4, id: "story-v4", title: "V4",
    createdAt: NOW, updatedAt: NOW, activeWordCount: 2,
    nodes: [
      { id: "root", parentId: null, instruction: "Go", model: "m", createdAt: NOW, revisionId: HASH, activeChildId: "child" },
      { id: "child", parentId: "root", instruction: "Go", model: "m", createdAt: NOW, revisionId: HASH, activeChildId: null },
      { id: "other-root", parentId: null, instruction: "Go", model: "m", createdAt: NOW, revisionId: HASH, activeChildId: null }
    ],
    facts: [], activeRootId: "root",
    bookmarks: [{ nodeId: "child", name: "Main", label: "Canon", color: "#4b45c9", createdAt: NOW }],
    recentNodeIds: ["other-root"]
  };
}

test("story format: chapter one's name survives the bundle, and absence stays absent", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-first-chapter-format-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base: Story = {
    id: "story-first-chapter", title: "Tree", createdAt: NOW, updatedAt: NOW,
    nodes: [node("root", null, "Opening")],
    activeRootId: "root", tags: [], recentNodeIds: [], facts: [], chapterBreaks: []
  };

  // A story written before chapter one could be named carries no such field,
  // and must round-trip without acquiring one.
  const objects = new StoryObjectStore(dir);
  const plain = await encodeStoryBundle(base, objects);
  assert.equal("firstChapterTitle" in plain, false);
  assert.deepEqual((await decodeStoryBundle(plain, dir)).story, base);

  const named: Story = { ...base, firstChapterTitle: "Arrival" };
  const manifest = await encodeStoryBundle(named, objects);
  assert.equal(manifest.firstChapterTitle, "Arrival");
  assert.deepEqual((await decodeStoryBundle(manifest, dir)).story, named);
  assert.equal(buildStoryPayload(named).firstChapterTitle, "Arrival");

  // An empty name is an absent one, on the wire and on disk alike.
  const cleared = await encodeStoryBundle({ ...base, firstChapterTitle: "" }, objects);
  assert.equal("firstChapterTitle" in cleared, false);
  assert.equal(buildStoryPayload({ ...base, firstChapterTitle: "" }).firstChapterTitle, undefined);
});

test("story format: author note round-trips, omits empty values, and enforces scalar bounds", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-authors-note-format-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base: Story = {
    id: "story-authors-note", title: "Tree", createdAt: NOW, updatedAt: NOW,
    nodes: [node("root", null, "Opening")],
    activeRootId: "root", tags: [], recentNodeIds: [], facts: [], chapterBreaks: []
  };
  const objects = new StoryObjectStore(dir);

  const absent = await encodeStoryBundle({ ...base, authorsNote: "" }, objects);
  assert.equal("authorsNote" in absent, false);
  assert.equal("authorsNote" in buildStoryPayload({ ...base, authorsNote: "" }), false);

  const note = "😀 Author note";
  const stored = await encodeStoryBundle({ ...base, authorsNote: note }, objects);
  assert.equal(stored.authorsNote, note);
  assert.deepEqual((await decodeStoryBundle(stored, dir)).story, { ...base, authorsNote: note });
  assert.equal(buildStoryPayload({ ...base, authorsNote: note }).authorsNote, note);

  await assert.rejects(
    () => encodeStoryBundle({ ...base, authorsNote: "😀".repeat(4_001) }, objects),
    /4,000 Unicode scalar values/
  );
  await assert.rejects(
    () => encodeStoryBundle({ ...base, authorsNote: "broken \ud800" }, objects),
    /unpaired Unicode surrogate/
  );
  assert.throws(
    () => buildStoryPayload({ ...base, authorsNote: "😀".repeat(4_001) }),
    /4,000 Unicode scalar values/
  );
});

test("story format: author note depth round-trips and never survives without its note", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-authors-note-depth-format-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base: Story = {
    id: "story-authors-note-depth", title: "Tree", createdAt: NOW, updatedAt: NOW,
    nodes: [node("root", null, "Opening")],
    activeRootId: "root", tags: [], recentNodeIds: [], facts: [], chapterBreaks: []
  };
  const objects = new StoryObjectStore(dir);
  const withDepth: Story = { ...base, authorsNote: "Steer it darker.", authorsNoteDepth: 3 };

  const stored = await encodeStoryBundle(withDepth, objects);
  assert.equal(stored.authorsNoteDepth, 3);
  assert.deepEqual((await decodeStoryBundle(stored, dir)).story, withDepth);
  assert.equal(buildStoryPayload(withDepth).authorsNoteDepth, 3);

  // A depth with no note means nothing: the codebase never keeps it.
  const noteless = { ...base, authorsNoteDepth: 3 };
  const encodedNoteless = await encodeStoryBundle(noteless, objects);
  assert.equal("authorsNoteDepth" in encodedNoteless, false);
  assert.equal("authorsNoteDepth" in buildStoryPayload(noteless), false);

  // A whitespace-only note is no note, so no depth outlives it. Only another
  // writer's manifest can hold one: this product's routes trim first.
  const blankNote = { ...base, authorsNote: "  \n", authorsNoteDepth: 3 };
  const encodedBlank = await encodeStoryBundle(blankNote, objects);
  assert.equal("authorsNoteDepth" in encodedBlank, false);
  assert.equal("authorsNoteDepth" in buildStoryPayload(blankNote), false);

  // Absence already means the default placement, so an explicit default from
  // another writer canonicalizes away instead of riding along for ever.
  const explicitDefault = { ...base, authorsNote: "Steer it darker.", authorsNoteDepth: 1 };
  const encodedDefault = await encodeStoryBundle(explicitDefault, objects);
  assert.equal("authorsNoteDepth" in encodedDefault, false);
  assert.equal("authorsNoteDepth" in buildStoryPayload(explicitDefault), false);
  assert.equal(
    "authorsNoteDepth" in (await decodeStoryBundle(
      { ...encodedDefault, authorsNoteDepth: 1 },
      dir
    )).story,
    false
  );
});

test("story format: author brief round-trips, omits empty values, and enforces scalar bounds", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-author-brief-format-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base: Story = {
    id: "story-author-brief", title: "Tree", createdAt: NOW, updatedAt: NOW,
    nodes: [node("root", null, "Opening")],
    activeRootId: "root", tags: [], recentNodeIds: [], facts: [], chapterBreaks: []
  };
  const objects = new StoryObjectStore(dir);

  const absent = await encodeStoryBundle({ ...base, authorBrief: "" }, objects);
  assert.equal("authorBrief" in absent, false);
  assert.equal("authorBrief" in buildStoryPayload({ ...base, authorBrief: "" }), false);

  // A whitespace-only brief overrides nothing, because the prompt falls back
  // to the machine-wide brief. No boundary may report it as an override.
  const blank = { ...base, authorBrief: " \n\t" };
  assert.equal("authorBrief" in (await encodeStoryBundle(blank, objects)), false);
  assert.equal("authorBrief" in buildStoryPayload(blank), false);

  const brief = "😀 Write in short, clipped sentences.";
  const stored = await encodeStoryBundle({ ...base, authorBrief: brief }, objects);
  assert.equal(stored.authorBrief, brief);
  assert.deepEqual((await decodeStoryBundle(stored, dir)).story, { ...base, authorBrief: brief });
  assert.equal(buildStoryPayload({ ...base, authorBrief: brief }).authorBrief, brief);

  await assert.rejects(
    () => encodeStoryBundle({ ...base, authorBrief: "😀".repeat(65_537) }, objects),
    /65,536 Unicode scalar values/
  );
  await assert.rejects(
    () => encodeStoryBundle({ ...base, authorBrief: "broken \ud800" }, objects),
    /unpaired Unicode surrogate/
  );
  assert.throws(
    () => buildStoryPayload({ ...base, authorBrief: "😀".repeat(65_537) }),
    /65,536 Unicode scalar values/
  );
});

test("story format: a story with Image Attachments stays version 5 with activation off, and gains them with activation on", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-image-activation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const attachment = {
    objectId: "c".repeat(64),
    mediaType: "image/png" as const,
    width: 800,
    height: 600,
    byteLength: 123_456
  };
  const story: Story = {
    id: "story-images", title: "Tree", createdAt: NOW, updatedAt: NOW,
    nodes: [{ ...node("root", null, "Opening"), imageAttachments: [attachment] }],
    activeRootId: "root", tags: [], recentNodeIds: [], facts: [], chapterBreaks: []
  };
  const objects = new StoryObjectStore(dir);

  // Off (test-only: this build's release default is on, so the caller
  // overrides it explicitly, the same way a predecessor-safety test does):
  // the successor field never reaches disk, and the manifest stays exactly
  // the current version.
  const inactive = await encodeStoryBundle(story, objects, undefined, undefined, { activation: false });
  assert.equal(inactive.schemaVersion, 5);
  assert.equal("imageAttachments" in inactive.nodes[0]!, false);
  assert.equal((await decodeStoryBundle(inactive, dir)).story.nodes[0]!.imageAttachments, undefined);

  // On (test-only, and also this build's release default): the same
  // in-memory story now writes the successor version, with the attachment
  // carried on the stored node and read back unchanged.
  const active = await encodeStoryBundle(story, objects, undefined, undefined, { activation: true });
  assert.equal(active.schemaVersion, 7);
  assert.deepEqual(active.nodes[0]!.imageAttachments, [attachment]);
  const decoded = await decodeStoryBundle(active, dir);
  assert.deepEqual(decoded.story.nodes[0]!.imageAttachments, [attachment]);
});

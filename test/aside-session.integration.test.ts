import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  appendAsideTurn,
  asideHistoryFromSession,
  asidePresenceFromIndex,
  emptyAsideSessionDocument,
  hashAsideSessionDocument,
  migrateAsideDocumentToUnanchored,
  MAX_ASIDE_THOUGHT_SCALARS,
  parseAsideSessionDocument,
  serializeAsideSessionDocument,
  truncateAsideThoughtsToFit,
  type AsideSessionIndex
} from "../shared/aside.js";
import { appendSideNote, emptyAsideDocument, serializeAsideDocument } from "../shared/aside.js";
import { asidePlan } from "../shared/aside-plan.js";
import { renderPromptPlan } from "../shared/prompt-plan.js";
import { StoryObjectStore } from "../server/story-objects.js";
import { decodeStoryBundle, encodeStoryBundle } from "../server/story-codec.js";
import { parseManifestV9, serializeManifestContent } from "../server/story-format.js";
import { formatV12, storySummaryV6FromContent } from "../server/story-v6-codec.js";
import { readStoredStorySlot, storySlotSweepLiveIds } from "../server/story-storage-reader.js";
import { storyAggregateSnapshot } from "../server/story-aggregate-state.js";
import { setPendingAsideSessionDocument } from "../server/story-aside-pending.js";
import { pruneUnusedTakes as pruneUnusedStoryTakes } from "../server/story-nodes.js";
import {
  allAsideSessionRefs,
  reanchorPrunedAsideSessions
} from "../server/aside-session-store.js";
import { buildStoryPayload } from "../server/story-payload.js";
import {
  assertStrictV11Manifest,
  MAX_SESSION_REFS_PER_BUCKET
} from "../server/story-v11-strict.js";
import type { Story } from "../shared/types.js";

test("v2 session object round-trip keeps thoughts out of Aside history", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-aside-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const objects = new StoryObjectStore(root);
  await objects.init();

  const document = appendAsideTurn(
    emptyAsideSessionDocument({ partId: "part-1", takeId: "take-2" }),
    "Why did the bell ring?",
    "The wind moved the old rope.",
    "private reasoning",
    17
  );
  const hash = await objects.storeAsideSessionDocument(document);
  await objects.flush();
  const loaded = await objects.readAsideSessionDocument(hash);
  assert.deepEqual(loaded, document);
  assert.equal(parseAsideSessionDocument(serializeAsideSessionDocument(loaded), hash).anchor?.takeId, "take-2");

  const history = asideHistoryFromSession(loaded);
  assert.deepEqual(history, [{ question: "Why did the bell ring?", answer: "The wind moved the old rope." }]);
  const prompt = renderPromptPlan(asidePlan({
    facts: null,
    parts: [],
    chapterBreaks: [],
    nodes: [],
    session: loaded,
    question: "What happened next?",
    usableTokens: 10_000
  })).map((message) => message.content).join("\n");
  assert.equal(prompt.includes("private reasoning"), false);
  assert.equal(prompt.includes("The wind moved the old rope."), true);
});

test("v1 migration is lossless and produces an unanchored presence ref", () => {
  const legacy = appendSideNote(
    appendSideNote(emptyAsideDocument(), "First?", "First answer."),
    "Second?",
    "Second answer."
  );
  const migrated = migrateAsideDocumentToUnanchored(legacy);
  assert.ok(migrated);
  assert.equal(migrated.anchor, null);
  assert.deepEqual(asideHistoryFromSession(migrated), legacy.notes);

  const index: AsideSessionIndex = {
    schemaVersion: 2,
    sessions: [
      { id: "s1", documentId: "a".repeat(64), anchor: { partId: "p", takeId: "t" }, turnCount: 2 },
      { id: "s2", documentId: "b".repeat(64), anchor: { partId: "p", takeId: "t" }, turnCount: 1 }
    ],
    unanchored: [{ id: "legacy", documentId: "c".repeat(64), anchor: null, turnCount: 2 }]
  };
  assert.deepEqual(asidePresenceFromIndex(index), {
    anchors: [{ partId: "p", takeId: "t", sessionCount: 2 }],
    unanchoredCount: 1
  });
  assert.equal(serializeAsideDocument(legacy).includes("private reasoning"), false);
});

test("Aside session ref buckets and bounds match the generated schema and runtime", () => {
  const manifest = {
    format: "1667-story",
    schemaVersion: 11,
    id: "story-one",
    title: "Story",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    activeWordCount: 0,
    nodes: [],
    facts: [],
    activeRootId: null,
    bookmarks: [],
    recentNodeIds: [],
    chapterBreaks: [],
    asideDocumentId: null,
    asideSessionRefs: [{
      id: "session-1",
      documentId: "a".repeat(64),
      anchor: { partId: "part-1", takeId: "take-1" },
      sourceAsideDocumentId: "b".repeat(64),
      turnCount: 0
    }],
    asideUnanchoredSessionRefs: []
  } as const;
  const schema = JSON.parse(
    readFileSync(fileURLToPath(new URL("../schema/story-manifest.schema.json", import.meta.url)), "utf8")
  ) as Record<string, unknown>;
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(manifest), true);
  assert.doesNotThrow(() => assertStrictV11Manifest(manifest, manifest.id));

  const boundaryAnchor = {
    partId: "😀".repeat(1_024),
    takeId: "😀".repeat(1_024)
  };
  const boundary = {
    ...manifest,
    asideSessionRefs: [{ ...manifest.asideSessionRefs[0], anchor: boundaryAnchor }]
  };
  assert.equal(validate(boundary), true);
  assert.doesNotThrow(() => assertStrictV11Manifest(boundary, boundary.id));

  const overBoundary = {
    ...boundary,
    asideSessionRefs: [{
      ...boundary.asideSessionRefs[0],
      anchor: { ...boundaryAnchor, partId: `${boundaryAnchor.partId}😀` }
    }]
  };
  assert.equal(validate(overBoundary), false);
  assert.throws(
    () => assertStrictV11Manifest(overBoundary, overBoundary.id),
    /partId must contain/u
  );

  const invalidAnchoredBucket = {
    ...manifest,
    asideSessionRefs: [{ ...manifest.asideSessionRefs[0], anchor: null }]
  };
  assert.equal(validate(invalidAnchoredBucket), false);
  assert.throws(
    () => assertStrictV11Manifest(invalidAnchoredBucket, manifest.id),
    /anchor must be an object/u
  );

  const invalidUnanchoredBucket = {
    ...manifest,
    asideSessionRefs: [],
    asideUnanchoredSessionRefs: [{
      ...manifest.asideSessionRefs[0],
      anchor: { partId: "part-1", takeId: "take-1" }
    }]
  };
  assert.equal(validate(invalidUnanchoredBucket), false);
  assert.throws(
    () => assertStrictV11Manifest(invalidUnanchoredBucket, manifest.id),
    /anchor must be null/u
  );

  const anchoredAtCapacity = Array.from(
    { length: MAX_SESSION_REFS_PER_BUCKET },
    (_, index) => ({
      id: `anchored-${index}`,
      documentId: "a".repeat(64),
      anchor: { partId: "part-1", takeId: "take-1" },
      turnCount: 0
    })
  );
  const unanchoredAtCapacity = Array.from(
    { length: MAX_SESSION_REFS_PER_BUCKET },
    (_, index) => ({
      id: `unanchored-${index}`,
      documentId: "b".repeat(64),
      anchor: null,
      turnCount: 0
    })
  );
  const atBucketCapacity = {
    ...manifest,
    asideSessionRefs: anchoredAtCapacity,
    asideUnanchoredSessionRefs: unanchoredAtCapacity
  };
  assert.equal(validate(atBucketCapacity), true);
  assert.doesNotThrow(() => assertStrictV11Manifest(atBucketCapacity, manifest.id));

  const overBucketCapacity = {
    ...atBucketCapacity,
    asideUnanchoredSessionRefs: [
      ...unanchoredAtCapacity,
      { ...unanchoredAtCapacity[0], id: "unanchored-over-capacity" }
    ]
  };
  assert.equal(validate(overBucketCapacity), false);
  assert.throws(
    () => assertStrictV11Manifest(overBucketCapacity, manifest.id),
    /exceeds 10000/u
  );

  const scalarLimitSessionId = "😀".repeat(128);
  const scalarLimit = {
    ...manifest,
    asideSessionRefs: [{ ...manifest.asideSessionRefs[0], id: scalarLimitSessionId }]
  };
  assert.equal(validate(scalarLimit), true);
  assert.doesNotThrow(() => assertStrictV11Manifest(scalarLimit, manifest.id));

  const scalarOverLimitSessionId = "😀".repeat(129);
  const scalarOverLimit = {
    ...manifest,
    asideSessionRefs: [{ ...manifest.asideSessionRefs[0], id: scalarOverLimitSessionId }]
  };
  assert.equal(validate(scalarOverLimit), false);
  assert.throws(
    () => assertStrictV11Manifest(scalarOverLimit, manifest.id),
    /non-empty session id/u
  );

  for (const id of ["", "x".repeat(129)]) {
    const invalid = {
      ...manifest,
      asideSessionRefs: [{ ...manifest.asideSessionRefs[0], id }]
    };
    assert.equal(validate(invalid), false, `schema accepted session id length ${id.length}`);
    assert.throws(
      () => assertStrictV11Manifest(invalid, manifest.id),
      /non-empty session id/u
    );
  }

  const invalidSource = {
    ...manifest,
    asideSessionRefs: [{
      ...manifest.asideSessionRefs[0],
      sourceAsideDocumentId: "not-a-sha256-digest"
    }]
  };
  assert.equal(validate(invalidSource), false);
  assert.throws(
    () => assertStrictV11Manifest(invalidSource, manifest.id),
    /sourceAsideDocumentId must be a SHA-256 hex digest/u
  );
});

test("optional thoughts truncate without preventing an answer save", () => {
  const document = emptyAsideSessionDocument({ partId: "part-1", takeId: "take-1" });
  const fitted = truncateAsideThoughtsToFit(
    document,
    "Question?",
    "The answer stays.",
    "x".repeat(MAX_ASIDE_THOUGHT_SCALARS + 10),
    50_000
  );
  assert.equal(fitted?.length, MAX_ASIDE_THOUGHT_SCALARS);
  const saved = appendAsideTurn(document, "Question?", "The answer stays.", fitted, 50_000);
  assert.equal(saved.turns[0]?.a, "The answer stays.");
  assert.equal(saved.turns[0]?.thoughts?.length, MAX_ASIDE_THOUGHT_SCALARS);

  assert.equal(truncateAsideThoughtsToFit(
    document,
    "Question?",
    "The answer stays.",
    "\ud800",
    1
  ), undefined);
});

test("v2 manifest refs survive save and reload while the V9 legacy object remains readable", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-aside-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storyId = "aside-v2-persisted";
  const bundleDir = path.join(root, storyId);
  await mkdir(bundleDir, { recursive: true });
  const objects = new StoryObjectStore(bundleDir);
  await objects.init();
  const legacy = appendSideNote(emptyAsideDocument(), "Legacy?", "Still here.");
  const legacyId = await objects.storeAsideDocument(legacy);
  const session = appendAsideTurn(
    emptyAsideSessionDocument({ partId: "part-1", takeId: "take-1" }),
    "Question",
    "Answer",
    "not in prompt",
    9
  );
  const story: Story = {
    id: storyId,
    title: "Persisted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nodes: [{
      id: "take-1",
      parentId: null,
      instruction: "",
      text: "Line.",
      model: "m",
      createdAt: "2026-01-01T00:00:00.000Z",
      activeChildId: null
    }],
    activeRootId: "take-1",
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: [],
    asideDocumentId: legacyId
  };
  setPendingAsideSessionDocument(story, "session-1", session);
  const manifest = await encodeStoryBundle(story, objects, undefined, undefined, { asideActivation: true });
  assert.equal(manifest.schemaVersion, 11);
  await objects.flush();
  const envelope = {
    format: "1667-story" as const,
    schemaVersion: 12 as const,
    kind: "live" as const,
    id: storyId,
    revision: "00000000000000000001",
    previousManifestHash: null,
    content: manifest,
    summary: storySummaryV6FromContent(manifest),
    unresolvedProvider: null,
    lastTransaction: null
  };
  await writeFile(path.join(bundleDir, "manifest.json"), formatV12(envelope));

  const reloaded = await readStoredStorySlot(root, storyId);
  assert.equal(reloaded.kind, "v12-live");
  if (reloaded.kind !== "v12-live") return;
  assert.equal(reloaded.manifest.content.asideDocumentId, legacyId);
  assert.equal(reloaded.manifest.content.asideSessionRefs[0]?.id, "session-1");
  assert.equal(reloaded.manifest.content.asideSessionRefs[0]?.documentId, hashAsideSessionDocument(session));
  assert.equal(storyAggregateSnapshot(reloaded).manifest.schemaVersion, 12);
  assert.deepEqual(storySlotSweepLiveIds(reloaded)?.leaves.aside, [legacyId, hashAsideSessionDocument(session)]);
  const decoded = await decodeStoryBundle(reloaded.manifest.content, bundleDir);
  assert.equal(decoded.story.asideDocumentId, legacyId);
  assert.equal(decoded.story.asideSessionRefs?.[0]?.id, "session-1");
  assert.deepEqual(await objects.readAsideDocument(legacyId), legacy);

  // An old V9 content payload still round-trips with the same V1 object.
  const legacyOnly = parseManifestV9(serializeManifestContent({
    ...manifest,
    schemaVersion: 9,
    asideSessionRefs: undefined,
    asideUnanchoredSessionRefs: undefined
  } as never), storyId);
  const oldDecoded = await decodeStoryBundle(legacyOnly, bundleDir);
  assert.equal(oldDecoded.story.asideDocumentId, legacyId);
  assert.deepEqual(await objects.readAsideDocument(oldDecoded.story.asideDocumentId!), legacy);
});

test("a pruned session keeps its origin anchor and reattaches after restore", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-aside-reanchor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storyId = "aside-reanchor";
  const bundleDir = path.join(root, storyId);
  await mkdir(bundleDir, { recursive: true });
  const objects = new StoryObjectStore(bundleDir);
  await objects.init();
  const anchor = { partId: "part-1", takeId: "take-1" };
  const session = appendAsideTurn(
    emptyAsideSessionDocument(anchor),
    "Question",
    "Answer"
  );
  const documentId = await objects.storeAsideSessionDocument(session);
  const take = {
    id: "take-1",
    parentId: null,
    instruction: "",
    text: "Line.",
    model: "m",
    createdAt: "2026-01-01T00:00:00.000Z",
    activeChildId: null
  };
  const story: Story = {
    id: storyId,
    title: "Reattach",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nodes: [take],
    activeRootId: take.id,
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: [],
    asideSessionRefs: [{ id: "session-1", documentId, anchor, turnCount: 1 }],
    asideUnanchoredSessionRefs: []
  };

  const live = await encodeStoryBundle(story, objects, undefined, undefined, { asideActivation: true });
  if (live.schemaVersion !== 11) throw new Error("expected V11 Aside content");
  assert.equal(live.asideSessionRefs[0]?.anchor?.takeId, "take-1");

  const prunedStory = { ...story, nodes: [], activeRootId: null };
  const pruned = await encodeStoryBundle(prunedStory, objects, undefined, undefined, { asideActivation: true });
  if (pruned.schemaVersion !== 11) throw new Error("expected V11 Aside content");
  assert.equal(pruned.asideSessionRefs.length, 0);
  assert.deepEqual(pruned.asideUnanchoredSessionRefs[0]?.originAnchor, anchor);

  const reloaded = await decodeStoryBundle(pruned, bundleDir);
  assert.equal(reloaded.story.asideUnanchoredSessionRefs?.[0]?.anchor, null);
  assert.deepEqual(reloaded.story.asideUnanchoredSessionRefs?.[0]?.originAnchor, anchor);

  reloaded.story.nodes = [take];
  reloaded.story.activeRootId = take.id;
  assert.deepEqual(allAsideSessionRefs(reloaded.story)[0]?.anchor, anchor);
  assert.equal(reanchorPrunedAsideSessions(reloaded.story), true);
  assert.deepEqual(reloaded.story.asideSessionRefs?.[0]?.anchor, anchor);
  assert.equal(reloaded.story.asideUnanchoredSessionRefs?.length, 0);
  const payload = buildStoryPayload(reloaded.story);
  assert.deepEqual(payload.asidePresence, {
    anchors: [{ partId: "part-1", takeId: "take-1", sessionCount: 1 }],
    unanchoredCount: 0
  });
});

test("the product prune mutation moves a session ref without reading its text", () => {
  const anchor = { partId: "part-1", takeId: "draft" };
  const draft = {
    id: "draft",
    parentId: "root",
    instruction: "",
    text: "Draft.",
    model: "m",
    createdAt: "2026-01-01T00:00:00.000Z",
    activeChildId: null
  };
  const story: Story = {
    id: "aside-prune-path",
    title: "Prune path",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nodes: [
      {
        id: "root",
        parentId: null,
        instruction: "",
        text: "Root.",
        model: "m",
        createdAt: "2026-01-01T00:00:00.000Z",
        activeChildId: "live"
      },
      {
        id: "live",
        parentId: "root",
        instruction: "",
        text: "Live.",
        model: "m",
        createdAt: "2026-01-01T00:00:00.000Z",
        activeChildId: null
      },
      draft
    ],
    activeRootId: "root",
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: [],
    asideSessionRefs: [{
      id: "session-1",
      documentId: "a".repeat(64),
      anchor,
      turnCount: 1
    }],
    asideUnanchoredSessionRefs: []
  };
  const prunedCount = pruneUnusedStoryTakes(story, {
    expectedStoryRevision: story.updatedAt,
    expectedTakeCount: 1,
    expectedPartCount: 1
  });
  assert.equal(prunedCount, 1);
  assert.equal(story.asideSessionRefs?.length, 0);
  assert.deepEqual(story.asideUnanchoredSessionRefs?.[0]?.originAnchor, anchor);

  // No product operation restores a pruned take ID today. A normal story
  // mutation can restore the node; payload and READ projections then reattach
  // from the durable origin without loading the session object.
  story.nodes.push(draft);
  assert.deepEqual(allAsideSessionRefs(story)[0]?.anchor, anchor);
  assert.deepEqual(buildStoryPayload(story).asidePresence, {
    anchors: [{ partId: "part-1", takeId: "draft", sessionCount: 1 }],
    unanchoredCount: 0
  });
});

test("reanchor keeps full buckets valid while projections follow effective anchors", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-aside-reanchor-capacity-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const makeStory = (
    id: string,
    nodes: Story["nodes"],
    asideSessionRefs: NonNullable<Story["asideSessionRefs"]>,
    asideUnanchoredSessionRefs: NonNullable<Story["asideUnanchoredSessionRefs"]>
  ): Story => ({
    id,
    title: "Capacity",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nodes,
    activeRootId: nodes[0]?.id ?? null,
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: [],
    asideSessionRefs,
    asideUnanchoredSessionRefs
  });
  const take = (id: string, parentId: string | null = null) => ({
    id,
    parentId,
    instruction: "",
    text: `${id}.`,
    model: "m",
    createdAt: "2026-01-01T00:00:00.000Z",
    activeChildId: null
  });

  const unanchoredFullRoot = path.join(root, "unanchored-full");
  await mkdir(unanchoredFullRoot, { recursive: true });
  const unanchoredObjects = new StoryObjectStore(unanchoredFullRoot);
  await unanchoredObjects.init();
  const prunedAnchor = { partId: "pruned-part", takeId: "pruned-take" };
  const unanchoredFull = makeStory(
    "unanchored-full",
    [
      { ...take("root"), activeChildId: "live-take" },
      take("live-take", "root"),
      take("pruned-take", "root")
    ],
    [{ id: "pruned", documentId: "a".repeat(64), anchor: prunedAnchor, turnCount: 0 }],
    Array.from({ length: MAX_SESSION_REFS_PER_BUCKET }, (_, index) => ({
      id: `unanchored-${index}`,
      documentId: "b".repeat(64),
      anchor: null,
      turnCount: 0
    }))
  );
  assert.equal(pruneUnusedStoryTakes(unanchoredFull, {
    expectedStoryRevision: unanchoredFull.updatedAt,
    expectedTakeCount: 1,
    expectedPartCount: 1
  }), 1);
  assert.equal(reanchorPrunedAsideSessions(unanchoredFull), false);
  assert.equal(unanchoredFull.asideSessionRefs?.length, 1);
  assert.equal(unanchoredFull.asideUnanchoredSessionRefs?.length, MAX_SESSION_REFS_PER_BUCKET);
  assert.equal(allAsideSessionRefs(unanchoredFull).filter((ref) => ref.anchor === null).length,
    MAX_SESSION_REFS_PER_BUCKET + 1);
  assert.equal(buildStoryPayload(unanchoredFull).asidePresence?.unanchoredCount,
    MAX_SESSION_REFS_PER_BUCKET + 1);
  const unanchoredManifest = await encodeStoryBundle(
    unanchoredFull,
    unanchoredObjects,
    undefined,
    undefined,
    { asideActivation: true }
  );
  if (unanchoredManifest.schemaVersion !== 11) throw new Error("expected V11 Aside content");
  assert.doesNotThrow(() => assertStrictV11Manifest(unanchoredManifest, unanchoredFull.id));
  assert.equal(unanchoredManifest.asideSessionRefs.length, 1);
  assert.equal(unanchoredManifest.asideUnanchoredSessionRefs.length, MAX_SESSION_REFS_PER_BUCKET);
  const unanchoredReloaded = await decodeStoryBundle(unanchoredManifest, unanchoredFullRoot);
  assert.equal(unanchoredReloaded.story.asideSessionRefs?.length, 1);
  assert.equal(unanchoredReloaded.story.asideUnanchoredSessionRefs?.length, MAX_SESSION_REFS_PER_BUCKET);
  assert.equal(buildStoryPayload(unanchoredReloaded.story).asidePresence?.unanchoredCount,
    MAX_SESSION_REFS_PER_BUCKET + 1);

  const anchoredFullRoot = path.join(root, "anchored-full");
  await mkdir(anchoredFullRoot, { recursive: true });
  const anchoredObjects = new StoryObjectStore(anchoredFullRoot);
  await anchoredObjects.init();
  const restoredAnchor = { partId: "restored-part", takeId: "restored-take" };
  const anchoredFull = makeStory(
    "anchored-full",
    [take("live-take")],
    Array.from({ length: MAX_SESSION_REFS_PER_BUCKET }, (_, index) => ({
      id: `anchored-${index}`,
      documentId: "c".repeat(64),
      anchor: { partId: "live-part", takeId: "live-take" },
      turnCount: 0
    })),
    [{
      id: "restored",
      documentId: "d".repeat(64),
      anchor: null,
      originAnchor: restoredAnchor,
      turnCount: 0
    }]
  );
  assert.equal(reanchorPrunedAsideSessions(anchoredFull), false);
  anchoredFull.nodes.push(take("restored-take"));
  assert.equal(reanchorPrunedAsideSessions(anchoredFull), false);
  assert.equal(anchoredFull.asideSessionRefs?.length, MAX_SESSION_REFS_PER_BUCKET);
  assert.equal(anchoredFull.asideUnanchoredSessionRefs?.length, 1);
  const effectiveAnchored = allAsideSessionRefs(anchoredFull);
  assert.equal(effectiveAnchored.filter((ref) => ref.anchor !== null).length,
    MAX_SESSION_REFS_PER_BUCKET + 1);
  assert.equal(buildStoryPayload(anchoredFull).asidePresence?.unanchoredCount, 0);
  const anchoredManifest = await encodeStoryBundle(
    anchoredFull,
    anchoredObjects,
    undefined,
    undefined,
    { asideActivation: true }
  );
  if (anchoredManifest.schemaVersion !== 11) throw new Error("expected V11 Aside content");
  assert.doesNotThrow(() => assertStrictV11Manifest(anchoredManifest, anchoredFull.id));
  assert.equal(anchoredManifest.asideSessionRefs.length, MAX_SESSION_REFS_PER_BUCKET);
  assert.equal(anchoredManifest.asideUnanchoredSessionRefs.length, 1);
  const anchoredReloaded = await decodeStoryBundle(anchoredManifest, anchoredFullRoot);
  assert.equal(anchoredReloaded.story.asideSessionRefs?.length, MAX_SESSION_REFS_PER_BUCKET);
  assert.equal(anchoredReloaded.story.asideUnanchoredSessionRefs?.length, 1);
  assert.equal(buildStoryPayload(anchoredReloaded.story).asidePresence?.unanchoredCount, 0);
});

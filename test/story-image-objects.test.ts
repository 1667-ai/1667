import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { liveObjectIds, manifestImageIds, StoryFormatError, sha256 } from "../server/story-format.js";
import { StoryObjectStore } from "../server/story-objects.js";
import type { StoryManifestV7 } from "../server/story-format.js";

const EMPTY_LIVE = { revisions: [], leaves: { probabilities: [], reasoning: [], images: [] }, generationRecords: [] };

async function tempDir(t: import("node:test").TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("story objects: an image object round-trips through raw bytes with no JSON codec", async (t) => {
  const dir = await tempDir(t, "1667-image-object-");
  const objects = new StoryObjectStore(dir);
  await objects.init();
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
  const hash = await objects.storeImage(bytes);
  await objects.flush();
  assert.equal(hash, sha256(bytes));
  const stored = await readFile(objects.objectPath("images", hash));
  assert.ok(stored.equals(bytes), "the stored bytes are exactly the input bytes, unmodified");
  assert.ok(objects.objectPath("images", hash).endsWith(".bin"), "image objects use the .bin extension");
  const read = await objects.readImage(hash);
  assert.ok(read.equals(bytes));
});

test("story objects: a corrupted image object is refused on read", async (t) => {
  const dir = await tempDir(t, "1667-image-object-corrupt-");
  const objects = new StoryObjectStore(dir);
  await objects.init();
  const bytes = Buffer.from("not actually an image, but bounded bytes");
  const hash = await objects.storeImage(bytes);
  await objects.flush();
  const file = objects.objectPath("images", hash);
  const original = await readFile(file);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, Buffer.concat([original, Buffer.from("x")]));
  const fresh = new StoryObjectStore(dir);
  await assert.rejects(() => fresh.readImage(hash), StoryFormatError);
});

// `StoryObjectStore.sweep` is kind-generic: it knows only `live.leaves.images`,
// never a Draft Lease. server/stories.ts's `unionLiveWithPins` is the one
// place that folds a lease-sourced image id into that set before calling
// sweep, so "a live Draft Lease keeps its image" is integration coverage in
// test/story-image-cleanup.test.ts, driven through `StoryStore`, not a
// `StoryObjectStore`-level concern.
test("story objects: sweep keeps an image live.leaves.images names and removes an unreferenced one", async (t) => {
  const dir = await tempDir(t, "1667-image-sweep-");
  const objects = new StoryObjectStore(dir);
  await objects.init();
  const keep = await objects.storeImage(Buffer.from("kept image bytes"));
  const drop = await objects.storeImage(Buffer.from("orphaned image bytes"));
  await objects.flush();

  const live = { revisions: [], leaves: { probabilities: [], reasoning: [], images: [keep] }, generationRecords: [] };
  const completed = await objects.sweep(live);
  assert.equal(completed, true);
  await readFile(objects.objectPath("images", keep));
  await assert.rejects(() => readFile(objects.objectPath("images", drop)));
});

test("story objects: sweep fails closed when live.leaves.images names a missing image", async (t) => {
  const dir = await tempDir(t, "1667-image-sweep-missing-");
  const objects = new StoryObjectStore(dir);
  await objects.init();
  const stillHere = await objects.storeImage(Buffer.from("present"));
  await objects.flush();
  const missing = sha256(Buffer.from("never stored"));

  const live = { revisions: [], leaves: { probabilities: [], reasoning: [], images: [missing] }, generationRecords: [] };
  await assert.rejects(
    () => objects.sweep(live),
    /Missing images object/
  );
  // The failed sweep must not have deleted anything: a damaged live graph
  // fails closed rather than making recovery harder.
  await readFile(objects.objectPath("images", stillHere));
});

test("story objects: sweep with no live image ids removes every unreferenced image", async (t) => {
  const dir = await tempDir(t, "1667-image-sweep-empty-");
  const objects = new StoryObjectStore(dir);
  await objects.init();
  const orphan = await objects.storeImage(Buffer.from("expired draft image"));
  await objects.flush();

  assert.equal(await objects.sweep(EMPTY_LIVE), true);
  await assert.rejects(() => readFile(objects.objectPath("images", orphan)));
});

function manifestNode(id: string, attachments: readonly { objectId: string }[] | undefined) {
  return {
    id,
    parentId: null,
    instruction: "",
    model: "m",
    createdAt: "2026-01-01T00:00:00.000Z",
    revisionId: "0".repeat(64),
    activeChildId: null,
    ...(attachments === undefined ? {} : {
      imageAttachments: attachments.map((entry) => ({
        objectId: entry.objectId, mediaType: "image/png" as const, width: 4, height: 4, byteLength: 10
      }))
    })
  };
}

function manifestFixture(nodes: ReturnType<typeof manifestNode>[]): StoryManifestV7 {
  return {
    format: "1667-story",
    schemaVersion: 7,
    id: "story-images",
    title: "T",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    activeWordCount: 0,
    nodes,
    facts: [],
    activeRootId: nodes[0]?.id ?? null,
    bookmarks: [],
    recentNodeIds: [],
    chapterBreaks: []
  };
}

test("manifestImageIds collects every attachment's objectId, in node order, including duplicates across nodes", () => {
  const idA = "a".repeat(64);
  const idB = "b".repeat(64);
  const manifest = manifestFixture([
    manifestNode("n1", [{ objectId: idA }, { objectId: idB }]),
    manifestNode("n2", undefined),
    // The same object can occur on a second, unrelated part. Count and
    // send each occurrence, so the collector must not deduplicate.
    manifestNode("n3", [{ objectId: idA }])
  ]);
  assert.deepEqual(manifestImageIds(manifest), [idA, idB, idA]);
});

test("liveObjectIds folds manifestImageIds into leaves.images", () => {
  const idA = "a".repeat(64);
  const manifest = manifestFixture([manifestNode("n1", [{ objectId: idA }])]);
  const live = liveObjectIds(manifest);
  assert.deepEqual(live.leaves.images, [idA]);
});

test("a sweep protects an image the manifest references even with no live Draft Lease at all", async (t) => {
  const dir = await tempDir(t, "1667-image-sweep-manifest-");
  const objects = new StoryObjectStore(dir);
  await objects.init();
  const referenced = await objects.storeImage(Buffer.from("manifest-referenced image"));
  const orphan = await objects.storeImage(Buffer.from("truly orphaned image"));
  await objects.flush();

  const manifest = manifestFixture([manifestNode("n1", [{ objectId: referenced }])]);
  const live = {
    revisions: [],
    leaves: { probabilities: [], reasoning: [], images: manifestImageIds(manifest) },
    generationRecords: []
  };

  // Nothing beyond the manifest reference is in `live.leaves.images`: only
  // that reference protects `referenced`.
  assert.equal(await objects.sweep(live), true);
  await readFile(objects.objectPath("images", referenced));
  await assert.rejects(() => readFile(objects.objectPath("images", orphan)));
});

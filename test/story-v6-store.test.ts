import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Story, StoryNode } from "../shared/types.js";
import { ServiceError } from "../server/errors.js";
import { markCleanupPending, CLEANUP_MARKER_FILENAME } from "../server/story-cleanup.js";
import { sha256, type StoryManifestV5 } from "../server/story-format.js";
import { StoryService } from "../server/story-service.js";
import { buildStorySummary } from "../server/story-summary.js";
import { StoryStore } from "../server/stories.js";
import { STORY_CREATE_RESIDUE_PREFIX } from "../server/story-residue.js";
import { formatV6 } from "../server/story-v6-codec.js";
import { MAX_STORY_MANIFEST_BYTES } from "../server/story-v5-strict.js";
import { MAX_LEGACY_STORY_MANIFEST_BYTES } from "../server/json-schema-version.js";
import type { DeletedStoryManifestV6, LiveStoryManifestV6 } from "../server/story-v6-types.js";
import { parseWorkerMutation, preflightWorkerMutation } from "../server/worker-mutations.js";

const NOW = "2026-01-01T00:00:00.000Z";
const SUCCESSOR_CODE = "story_manifest_requires_successor";

test("story V6 store: existing list, read, and export surfaces support live state and hide deleted state", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-v6-read-"));
  const service = new StoryService({ dataDir });
  await service.init();
  t.after(async () => { await service.dispose(); await rm(dataDir, { recursive: true, force: true }); });

  await service.stories.save(fixture("v5-story", "V5 prose"));
  await service.stories.save(fixture("v6-story", "V6 prose"));
  await service.stories.save(fixture("deleted-story", "Deleted prose"));
  await promoteLive(path.join(dataDir, "stories"), "v6-story");
  await promoteDeleted(path.join(dataDir, "stories"), "deleted-story");

  assert.deepEqual((await service.listStories()).map(({ id }) => id).sort(), ["v5-story", "v6-story"]);
  assert.equal((await service.loadStory("v6-story")).path[0]!.text, "V6 prose");
  assert.match((await service.exportStory("v6-story")).markdown, /V6 prose/);
  await assert.rejects(() => service.loadStory("deleted-story"), hasServiceError("not_found"));

  let settingsLoads = 0;
  service.settings.load = async () => { settingsLoads += 1; throw new Error("settings touched"); };
  await assert.rejects(
    () => service.createNode("v6-story", {
      parentId: "v6-story-root", text: "Blocked", instruction: "", genId: "blocked-generation"
    }),
    hasServiceError(SUCCESSOR_CODE)
  );
  assert.equal(settingsLoads, 0);
});

test("story V6 store: every mutation refuses before hydration, writes, deletion, or cleanup", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-v6-refusal-"));
  const seed = new StoryStore(root);
  await seed.init();
  const story = fixture("successor-story", "Missing after promotion");
  await seed.save(story);
  const manifest = await promoteLive(root, story.id);
  const revisionId = manifest.content.nodes[0]!.revisionId;
  await unlink(path.join(root, story.id, "revisions", revisionId.slice(0, 2), `${revisionId}.json`));
  const beforeManifest = await readFile(path.join(root, story.id, "manifest.json"));
  const beforeEntries = await readdir(root);
  let sweepCalls = 0;
  const store = new StoryStore(root, async () => { sweepCalls += 1; return true; });
  t.after(async () => { await store.waitForMaintenance(); await rm(root, { recursive: true, force: true }); });

  let mutationCalled = false;
  await assert.rejects(() => store.assertMutationSupported(story.id), hasServiceError(SUCCESSOR_CODE));
  await assert.rejects(() => store.loadForMutation(story.id), hasServiceError(SUCCESSOR_CODE));
  await assert.rejects(() => store.mutate(story.id, () => { mutationCalled = true; }), hasServiceError(SUCCESSOR_CODE));
  await assert.rejects(() => store.save(story), hasServiceError(SUCCESSOR_CODE));
  await assert.rejects(() => store.remove(story.id), hasServiceError(SUCCESSOR_CODE));
  await assert.rejects(() => store.create("Replacement", story.id), hasServiceError(SUCCESSOR_CODE));
  assert.equal(mutationCalled, false);
  assert.deepEqual(await readdir(root), beforeEntries);
  assert.deepEqual(await readFile(path.join(root, story.id, "manifest.json")), beforeManifest);

  await markCleanupPending(path.join(root, story.id), story.id);
  await store.init();
  await store.waitForMaintenance();
  assert.equal(sweepCalls, 0);
  await access(path.join(root, story.id, CLEANUP_MARKER_FILENAME));
  assert.deepEqual(await readFile(path.join(root, story.id, "manifest.json")), beforeManifest);
});

test("story V6 store: service admission refuses before creating a legacy receipt", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-v6-receipt-refusal-"));
  const service = new StoryService({ dataDir });
  await service.init();
  t.after(async () => { await service.dispose(); await rm(dataDir, { recursive: true, force: true }); });
  const story = fixture("receipt-blocked", "Future prose");
  await service.stories.save(story);
  await promoteLive(path.join(dataDir, "stories"), story.id);
  const input = parseWorkerMutation("renameStory", { id: story.id, title: "Blocked" });
  let workCalls = 0;

  await assert.rejects(
    () => service.runMutation(
      `m1-${Date.now().toString(36)}-${"a".repeat(32)}`,
      "renameStory",
      input,
      async () => { workCalls += 1; return "must not run"; },
      undefined,
      (plan) => {
        assert.deepEqual(Object.keys(plan).sort(), ["entityId", "method"]);
        return preflightWorkerMutation(service, input, plan);
      }
    ),
    hasServiceError(SUCCESSOR_CODE)
  );

  assert.equal(workCalls, 0);
  assert.deepEqual(await readdir(path.join(dataDir, "mutation-receipts")), []);
});

test("story V6 store: exact successor residue is busy and excluded from the catalog", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-v6-residue-"));
  const store = new StoryStore(root);
  await store.init();
  t.after(async () => { await store.waitForMaintenance(); await rm(root, { recursive: true, force: true }); });
  const id = "reserved-story";
  await mkdir(path.join(root, `${STORY_CREATE_RESIDUE_PREFIX}${id}`));

  assert.deepEqual(await store.list(), []);
  await assert.rejects(() => store.load(id), hasServiceError("resource_busy"));
  await assert.rejects(() => store.assertMutationSupported(id), hasServiceError("resource_busy"));
  await assert.rejects(() => store.create("Blocked", id), hasServiceError("resource_busy"));
});

test("story store: oversized V2-V4 manifests remain readable while V5 stays bounded", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-oversize-legacy-"));
  const store = new StoryStore(root);
  await store.init();
  t.after(async () => { await store.waitForMaintenance(); await rm(root, { recursive: true, force: true }); });
  const id = "oversize-v4";
  const title = "x".repeat(MAX_STORY_MANIFEST_BYTES + 1);
  const manifest = {
    format: "1667-story",
    id,
    title,
    createdAt: NOW,
    updatedAt: NOW,
    activeWordCount: 0,
    nodes: [],
    facts: [],
    activeRootId: null,
    bookmarks: [],
    recentNodeIds: [],
    schemaVersion: 4
  };
  const bundle = path.join(root, id);
  await mkdir(bundle);
  const file = path.join(bundle, "manifest.json");
  const escapedSchemaKey = [..."schemaVersion"]
    .map((character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`)
    .join("");
  const legacyRaw = JSON.stringify(manifest).replace('"schemaVersion"', `"${escapedSchemaKey}"`);
  assert.ok(Buffer.byteLength(legacyRaw) > MAX_STORY_MANIFEST_BYTES);
  await writeFile(file, legacyRaw);

  assert.equal((await store.load(id)).title.length, title.length);

  const paddedVersion = legacyRaw.replace(":4}", `:4.${"0".repeat(100)}}`);
  await writeFile(file, paddedVersion);
  assert.equal((await store.load(id)).title.length, title.length);

  await writeFile(file, legacyRaw.replace(":4}", ":5}"));
  await assert.rejects(() => store.load(id), /size limit/);

  const giantStrictPrimitive = `{"padding":${"1".repeat(MAX_STORY_MANIFEST_BYTES)},"schemaVersion":5}`;
  await writeFile(file, giantStrictPrimitive);
  await assert.rejects(() => store.load(id), /size limit/);

  const mismatchedLegacy = `{"padding":[${" ".repeat(MAX_STORY_MANIFEST_BYTES)}},"schemaVersion":4}`;
  await writeFile(file, mismatchedLegacy);
  await assert.rejects(() => store.load(id), /size limit/);

  await writeFile(file, '{"schemaVersion":4}');
  await truncate(file, MAX_LEGACY_STORY_MANIFEST_BYTES + 1);
  await assert.rejects(() => store.load(id), /legacy migration limit/);
});

async function promoteLive(root: string, id: string): Promise<LiveStoryManifestV6> {
  const file = path.join(root, id, "manifest.json");
  const content = JSON.parse(await readFile(file, "utf8")) as StoryManifestV5;
  const summary = buildStorySummary(content);
  const manifest: LiveStoryManifestV6 = {
    format: "1667-story",
    schemaVersion: 6,
    kind: "live",
    id,
    revision: "00000000000000000001",
    previousManifestHash: null,
    content,
    summary: {
      ...summary,
      words: uint64(summary.words),
      lineCount: uint64(summary.lineCount)
    },
    unresolvedProvider: null,
    lastTransaction: null
  };
  await writeFile(file, formatV6(manifest));
  return manifest;
}

async function promoteDeleted(root: string, id: string): Promise<void> {
  const file = path.join(root, id, "manifest.json");
  const previous = await readFile(file);
  const manifest: DeletedStoryManifestV6 = {
    format: "1667-story",
    schemaVersion: 6,
    kind: "deleted",
    id,
    revision: "00000000000000000002",
    previousManifestHash: sha256(previous),
    deletedAt: NOW,
    unresolvedProvider: null,
    lastTransaction: {
      receiptKind: "user",
      mutationId: "m1.1767225600000.0123456789abcdef0123456789abcdef",
      phase: "prepared"
    }
  };
  await writeFile(file, formatV6(manifest));
}

function fixture(id: string, text: string): Story {
  const root: StoryNode = {
    id: `${id}-root`, parentId: null, instruction: "Continue", text,
    model: "test", createdAt: NOW, activeChildId: null
  };
  return {
    id, title: id, createdAt: NOW, updatedAt: NOW, nodes: [root], activeRootId: root.id,
    bookmarks: [], recentNodeIds: [], facts: [], chapterBreaks: []
  };
}

function uint64(value: number): string {
  return BigInt(value).toString().padStart(20, "0");
}

function hasServiceError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ServiceError && error.code === code;
}

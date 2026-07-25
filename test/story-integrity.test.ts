import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Story, StoryNode } from "../shared/types.js";
import { CLEANUP_MARKER_FILENAME } from "../server/story-cleanup.js";
import { StoryObjectStore } from "../server/story-objects.js";
import { HttpError } from "../server/http.js";
import type { StoryManifestV4 } from "../server/story-format.js";
import { StoryStore } from "../server/stories.js";

const NOW = "2026-01-01T00:00:00.000Z";

test("story integrity: lazy path hydration reports an unknown node as 404", async (t) => {
  const { store } = await testStore(t);
  await store.save(fixture("missing-node"));

  await assert.rejects(
    () => store.editNode("missing-node", "gone", { text: "new", expectedTextHash: "0".repeat(64) }),
    (error: unknown) => error instanceof HttpError && error.status === 404
  );
});

test("story integrity: an unrelated save rejects a corrupt hidden revision", async (t) => {
  const { dir, store } = await testStore(t);
  const story = fixture("hidden-corruption");
  await store.save(story);
  const before = await manifest(dir, story.id);
  const hiddenRevision = before.nodes.find(({ id }) => id === "hidden")!.revisionId;
  const bundleDir = path.join(dir, story.id);
  const objects = new StoryObjectStore(bundleDir);
  await writeFile(objects.objectPath("revisions", hiddenRevision), "corrupt");

  await assert.rejects(() => store.mutate(story.id, (loaded) => { loaded.title = "Must not publish"; }));
  assert.equal((await manifest(dir, story.id)).title, "Story");
  await readFile(path.join(bundleDir, CLEANUP_MARKER_FILENAME));
});

function fixture(id: string): Story {
  return {
    id, title: "Story", createdAt: NOW, updatedAt: NOW,
    nodes: [node("root", null, "Root", "active"), node("active", "root", "Active"), node("hidden", "root", "Hidden")],
    activeRootId: "root", bookmarks: [], recentNodeIds: [], facts: [], chapterBreaks: []
  };
}

function node(id: string, parentId: string | null, text: string, activeChildId: string | null = null): StoryNode {
  return { id, parentId, instruction: "Continue", text, model: "test", createdAt: NOW, activeChildId };
}

async function testStore(t: test.TestContext): Promise<{ dir: string; store: StoryStore }> {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-integrity-"));
  const store = new StoryStore(dir);
  await store.init();
  t.after(async () => { await store.waitForMaintenance(); await rm(dir, { recursive: true, force: true }); });
  return { dir, store };
}

async function manifest(dir: string, id: string): Promise<StoryManifestV4> {
  return JSON.parse(await readFile(path.join(dir, id, "manifest.json"), "utf8")) as StoryManifestV4;
}

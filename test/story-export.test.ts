import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { StoryService } from "../server/story-service.js";
import { StoryStore } from "../server/stories.js";
import type { Story } from "../shared/types.js";

test("export writes the active branch with chapters as headings", async (t) => {
  const service = await openService(t);
  const created = await service.createStory("The Tavern After Rain");
  const opening = await service.createNode(created.id, {
    parentId: null,
    instruction: "open the scene",
    text: "Rain still ran off the eaves."
  });
  const firstPart = opening.nodes.find((node) => node.parentId === null)!;
  const continued = await service.createNode(created.id, {
    parentId: firstPart.id,
    instruction: "keep going",
    text: "The second part."
  });
  assert.ok(continued.nodes.some((node) => node.parentId === firstPart.id));
  await service.createChapterBreak(created.id, firstPart.id, "After the Rain");

  const exported = await service.exportStory(created.id);

  assert.equal(exported.filename, "The_Tavern_After_Rain.md");
  const lines = exported.markdown.split("\n");
  assert.equal(lines[0], "# The Tavern After Rain");
  assert.deepEqual(
    lines.filter((line) => line.startsWith("#")),
    ["# The Tavern After Rain", "## After the Rain"]
  );
  // The opening chapter is unnamed, so the document title stands for it.
  assert.equal(exported.markdown.includes("## Chapter 1"), false);
  assert.equal(exported.markdown.includes("Rain still ran off the eaves."), true);
  assert.equal(exported.markdown.includes("The second part."), true);
  // A hand-off artifact carries prose, not the instructions that made it.
  assert.equal(exported.markdown.includes("<!-- prompt:"), false);
  assert.equal(exported.markdown.endsWith("\n"), true);
});

test("a story with no chapter break exports as plain prose", async (t) => {
  const service = await openService(t);
  const created = await service.createStory("One Sitting");
  await service.createNode(created.id, {
    parentId: null,
    instruction: "open",
    text: "One sitting, one line."
  });

  const exported = await service.exportStory(created.id);
  assert.equal(exported.markdown.includes("##"), false);
  assert.equal(
    exported.markdown,
    "# One Sitting\n\n<!-- 1667:export:v1 -->\n\nOne sitting, one line.\n"
  );
});

test("origin metadata remains one comment when its source title is multiline", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-origin-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "project");
  const store = new StoryStore(path.join(dataDir, "stories"));
  await store.init();
  const now = "2026-01-01T00:00:00.000Z";
  const story: Story = {
    id: "derived-story",
    title: "Derived",
    createdAt: now,
    updatedAt: now,
    origin: {
      storyId: "source-story",
      storyTitle: "First\nSecond",
      partId: "source-node",
      offset: null,
      createdAt: now
    },
    nodes: [],
    activeRootId: null,
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: []
  };
  await store.save(story);

  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  t.after(() => service.dispose());
  const exported = await service.exportStory(story.id);
  assert.match(exported.markdown, /derived from "First Second"/u);
  const reimported = await service.importMarkdown(exported.markdown);
  assert.equal(reimported.title, "Derived");
  assert.equal(reimported.nodes.length, 0);
});

async function openService(t: TestContext): Promise<StoryService> {
  const root = await mkdtemp(path.join(tmpdir(), "1667-export-service-"));
  const service = StoryService.withoutDiagnostics({
    dataDir: path.join(root, "project")
  });
  await service.init();
  t.after(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return service;
}

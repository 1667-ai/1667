import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { StoryService } from "../server/story-service.js";
import { partsFromMarkdown } from "../server/import-md.js";
import { storyFromImport } from "../server/import-st.js";
import { parseImportCommand } from "../tui/src/import-cli.js";
import type { StoryPayload } from "../shared/types.js";
import { API_PROTOCOL_HEADERS, fetchWithApiProtocol } from "./http-test-client.js";
import { testApp } from "./story-server-fixture.js";

const linuxTest = process.platform === "linux" ? test : test.skip;

function isServiceError(error: unknown, status: number, messageSub: string): boolean {
  return error instanceof Error
    && "status" in error
    && (error as { status?: number }).status === status
    && error.message.includes(messageSub);
}

function isErrorWithMessage(error: unknown, messageSub: string): boolean {
  return error instanceof Error && error.message.includes(messageSub);
}

test("partsFromMarkdown parses title, prose paragraphs, and ## chapter breaks", () => {
  const markdown = `# The Great Adventure

<!-- header comment -->

First paragraph of opening chapter.

Second paragraph of opening chapter.

## Chapter 2: The Dark Forest

First paragraph of chapter 2.

Second paragraph of chapter 2.

## Chapter 3: The Summit

Only paragraph of chapter 3.
`;

  const parsed = partsFromMarkdown(markdown, "Fallback Title");
  assert.equal(parsed.title, "The Great Adventure");
  assert.equal(parsed.parts.length, 5);
  assert.equal(parsed.parts[0]?.text, "First paragraph of opening chapter.");
  assert.equal(parsed.parts[1]?.text, "Second paragraph of opening chapter.");
  assert.equal(parsed.parts[2]?.text, "First paragraph of chapter 2.");
  assert.equal(parsed.parts[3]?.text, "Second paragraph of chapter 2.");
  assert.equal(parsed.parts[4]?.text, "Only paragraph of chapter 3.");

  assert.equal(parsed.chapterBreaks.length, 2);
  assert.deepEqual(parsed.chapterBreaks[0], {
    parentPartIndex: 1,
    title: "Chapter 2: The Dark Forest"
  });
  assert.deepEqual(parsed.chapterBreaks[1], {
    parentPartIndex: 3,
    title: "Chapter 3: The Summit"
  });
});

test("export and reimport round-trip preserves story structure and re-exported markdown", async (t) => {
  const service = await openService(t);
  const created = await service.createStory("The Tavern After Rain");

  const opening = await service.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: "Rain still ran off the eaves."
  });
  const firstPart = opening.nodes.find((node) => node.parentId === null)!;

  const secondNode = await service.createNode(created.id, {
    parentId: firstPart.id,
    instruction: "",
    text: "The second part of chapter 1."
  });
  const secondPart = secondNode.nodes.find((node) => node.parentId === firstPart.id)!;

  await service.createChapterBreak(created.id, secondPart.id, "After the Rain");

  await service.createNode(created.id, {
    parentId: secondPart.id,
    instruction: "",
    text: "The third part in chapter 2."
  });

  // Export story
  const exported = await service.exportStory(created.id);
  assert.equal(exported.filename, "The_Tavern_After_Rain.md");
  assert.ok(exported.markdown.includes("# The Tavern After Rain"));
  assert.ok(exported.markdown.includes("## After the Rain"));

  // Reimport as a new story
  const reimportedPayload = await service.importMarkdown(exported.markdown);
  assert.equal(reimportedPayload.title, "The Tavern After Rain");
  assert.equal(reimportedPayload.nodes.length, 3);
  assert.equal(reimportedPayload.chapterBreaks.length, 1);
  assert.equal(reimportedPayload.chapterBreaks[0]?.title, "After the Rain");

  // Re-export the reimported story
  const reexported = await service.exportStory(reimportedPayload.id);
  assert.equal(reexported.markdown, exported.markdown);
});

test("storyFromImport generates deterministic chapter break IDs when supplied", () => {
  const markdown = `# Title\n\nPart 1.\n\n## Chapter 2\n\nPart 2.\n`;
  const parsed = partsFromMarkdown(markdown);
  const story = storyFromImport(parsed, {
    storyId: "s_det",
    nodeId: (index) => `n_${index}`,
    chapterBreakId: (index) => `cb_${index}`
  });
  assert.equal(story.id, "s_det");
  assert.equal(story.nodes[0]?.id, "n_0");
  assert.equal(story.nodes[1]?.id, "n_1");
  assert.equal(story.chapterBreaks[0]?.id, "cb_0");
  assert.equal(story.chapterBreaks[0]?.parentPartId, "n_0");
});

test("markdown import enforces import byte and part limits", () => {
  assert.throws(
    () => partsFromMarkdown(""),
    (error: unknown) => isServiceError(error, 400, "No importable prose")
  );

  const hugeParagraphs = Array.from({ length: 5001 }, (_, i) => `Paragraph ${i}`).join("\n\n");
  assert.throws(
    () => partsFromMarkdown(hugeParagraphs),
    (error: unknown) => isServiceError(error, 400, "5000 parts")
  );
});

test("CLI parseImportCommand parses files and flags correctly", () => {
  assert.deepEqual(parseImportCommand(["file1.md", "file2.jsonl"]), {
    files: ["file1.md", "file2.jsonl"],
    data: null,
    global: false
  });
  assert.deepEqual(parseImportCommand(["--data", "myproject", "story.md"]), {
    files: ["story.md"],
    data: "myproject",
    global: false
  });
  assert.throws(
    () => parseImportCommand([]),
    (error: unknown) => isErrorWithMessage(error, "at least one file argument")
  );
  assert.throws(
    () => parseImportCommand(["--global", "--data", "foo", "bar.md"]),
    (error: unknown) => isErrorWithMessage(error, "select different projects")
  );
});

linuxTest("HTTP POST /api/import/markdown accepts JSON envelope with markdown and fallback defaultTitle", async (t) => {
  const base = await testApp(t, "1667-import-md-http-");
  const markdownBody = "Prose without a title heading.";
  const response = await fetchWithApiProtocol(`${base}/api/import/markdown`, {
    method: "POST",
    headers: { ...API_PROTOCOL_HEADERS, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ markdown: markdownBody, defaultTitle: "Custom Default Title" })
  });
  assert.equal(response.status, 201);
  const payload = await response.json() as StoryPayload;
  assert.equal(payload.title, "Custom Default Title");
  assert.equal(payload.path[0]?.text, "Prose without a title heading.");
});

async function openService(t: TestContext): Promise<StoryService> {
  const root = await mkdtemp(path.join(tmpdir(), "1667-import-service-"));
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
